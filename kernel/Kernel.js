const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zmq = require('zeromq');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

class Kernel {
  constructor(docId, docPath) {
    this.docId = docId;
    this.docPath = docPath;
    this.emitter = new EventEmitter();
    this.isDestroyed = false;
    this.executionQueue = []; // Queue to manage execution requests
    this.processing = false; // Flag to track if we're currently processing a request
  }

  async start() {
    const connectionFilePath = path.join(require('os').tmpdir(), `kernel-${uuid()}.json`);
    const kernelProcess = spawn(
      'jupyter',
      ['kernel', '--KernelManager.connection_file=' + connectionFilePath]
    );

    const connectionInfo = await new Promise((resolve) => {
      let i = 0, MAX_TRIES = 8, TRY_INTERVAL = 300;
      let connectionData = null;

      const ts = setInterval(function () {
        if (fs.existsSync(connectionFilePath)) {
          try { 
            connectionData = JSON.parse(fs.readFileSync(connectionFilePath, 'utf8')); 
          }
          catch(e) { 
            // not ready yet, will try again
          } 
        }
        if (connectionData || i >= MAX_TRIES) { 
          clearInterval(ts); 
          resolve(connectionData); 
        }
        i += 1;
      }, TRY_INTERVAL);
    });

    if (!connectionInfo)
      throw new Error('Unable to start kernel connection.');

    this.connectionInfo = connectionInfo;
    this.kernelProcess = kernelProcess;
    this.connectionFilePath = connectionFilePath;

    // Set up cleanup handler for the connection file
    process.on('exit', () => {
      this.cleanup();
    });

    await this.connectChannels();
    this.startIOPubReceiver();
    this.startMessageProcessor();
    
    return this; // Return this for chaining
  }

  async connectChannels() {
    const channels = {};
    const ci = this.connectionInfo;

    // Shell channel - for code execution requests
    channels.shell = new zmq.Request();
    await channels.shell.connect(`${ci.transport}://${ci.ip}:${ci.shell_port}`);
    
    // IOPub channel - for output streams
    channels.iopub = new zmq.Subscriber();
    await channels.iopub.connect(`${ci.transport}://${ci.ip}:${ci.iopub_port}`);
    await channels.iopub.subscribe('');

    // Control channel - for kernel control
    channels.control = new zmq.Request();
    await channels.control.connect(`${ci.transport}://${ci.ip}:${ci.control_port}`);
    
    // Stdin channel - for input requests
    channels.stdin = new zmq.Request();
    await channels.stdin.connect(`${ci.transport}://${ci.ip}:${ci.stdin_port}`);
    
    this.channels = channels;
  }

  startIOPubReceiver() {
    const kernel = this;    
    const receiveMessages = async () => {
      try {
        // Wait for the next message
        const
          response = await kernel.channels.iopub.receive(),
          part = response.slice(1);

        if (part.length >= 6) {
          const
            header = JSON.parse(part[2].toString()),
            parentHeader = JSON.parse(part[3].toString()),
            content = JSON.parse(part[5].toString()),
            type = header.msg_type,
            message = { type, content, parentHeader, header };
          
          kernel.emitter.emit('message', message);
          // Also emit specific event types
          kernel.emitter.emit(`message:${type}`, message);
          
          // If the message is associated with an execution, emit an execution-specific event
          if (parentHeader.msg_id) {
            kernel.emitter.emit(`execution:${parentHeader.msg_id}`, message);
            
            // If this is a status:idle message after execute, we can process the next execution
            if (type === 'status' && content.execution_state === 'idle') {
              const executionId = parentHeader.msg_id;
              // Allow the next request to be processed
              if (kernel.currentExecutionId === executionId) {
                kernel.processing = false;
                kernel.currentExecutionId = null;
                setImmediate(() => kernel.processNextExecution());
              }
            }
          }
        }
        
        // Continue receiving if the kernel is still active
        if (!kernel.isDestroyed) {
          setImmediate(receiveMessages);
        }
      } catch (error) {
        if (!kernel.isDestroyed) {
          kernel.emitter.emit('error', error);
          // Try to reconnect after a brief delay
          setTimeout(receiveMessages, 1000);
        }
      }
    };
    receiveMessages();
  }

  startMessageProcessor() {
    // Initialize the message processor if not already running
    if (!this.messageProcessor) {
      this.messageProcessor = setInterval(() => {
        this.processNextExecution();
      }, 50); // Check the queue every 50ms
    }
  }

  async processNextExecution() {
    // If we're currently processing or there's nothing in the queue, do nothing
    if (this.processing || this.executionQueue.length === 0) {
      return;
    }

    this.processing = true;
    const request = this.executionQueue.shift();
    
    try {
      const msg = this.createMessage(request.executionId, request.sessionId, 'execute_request', {
        code: request.code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: true,
        stop_on_error: true
      });
      
      this.currentExecutionId = msg.header.msg_id;
      
      // Send the message to the kernel
      await this.sendKernelMessage(msg);
      
      // Now wait for the reply from the shell channel
      const reply = await this.channels.shell.receive();
      
      // Parse the reply (similar to how we parse IOPub messages)
      if (reply.length >= 6) {
        const
          header = JSON.parse(reply[3].toString()),
          content = JSON.parse(reply[6].toString());
        
        // Emit an event for the reply
        this.emitter.emit(`shell_reply:${msg.header.msg_id}`, { header, content });
      }
      
      // We don't set processing to false here - that will happen when we receive the status:idle message
      // from the IOPub channel, indicating the kernel has finished processing the request
      
    } catch (error) {
      this.emitter.emit('error', error);
      this.processing = false; // Reset processing flag to allow next request
      this.currentExecutionId = null;
    }
  }

  async sendExecuteRequest({ executionId, sessionId, code }) {
    // Create a unique ID for this execution if not provided
    const execId = executionId || uuid();
    
    // Add the request to the queue
    this.executionQueue.push({ executionId: execId, sessionId, code });
    
    // Trigger processing if not already running
    setImmediate(() => this.processNextExecution());
    
    return execId; // Return the execution ID so the caller can listen for events
  }

  createMessage(messageId, sessionId, msg_type, content = {}) {    
    return {
      header: {
        msg_id: messageId || uuid(),
        username: 'node-kernel-client',
        session: sessionId || uuid(),
        date: new Date().toISOString(),
        msg_type,
        version: '5.3'
      },
      parent_header: {},
      metadata: {},
      content,
      buffers: []
    };
  }

  // Send a message to kernel over ZMQ with proper signature
  async sendKernelMessage(message) {
    const msg_list = [
      JSON.stringify(message.header),
      JSON.stringify(message.parent_header),
      JSON.stringify(message.metadata),
      JSON.stringify(message.content)
    ];

    const key = this.connectionInfo.key;
    let channel;
    
    // Determine which channel to use based on message type
    if (message.header.msg_type.startsWith('execute_')) {
      channel = this.channels.shell;
    } else if (message.header.msg_type.startsWith('kernel_')) {
      channel = this.channels.control;
    } else if (message.header.msg_type.startsWith('input_')) {
      channel = this.channels.stdin;
    } else {
      channel = this.channels.shell; // Default to shell
    }
    
    // Create signature
    const signature = key
      ? crypto.createHmac('sha256', key).update(msg_list.join('')).digest('hex')
      : '';
    
    // ZMQ identity frame (blank for now)
    await channel.send(['<IDS|MSG>', signature, ...msg_list]);
    return message;
  }

  async interrupt() {
    if (this.kernelProcess && this.kernelProcess.pid) {
      process.kill(this.kernelProcess.pid, 'SIGINT');
      
      // Reset execution state
      this.processing = false;
      this.currentExecutionId = null;
      
      return true;
    }
    return false;
  }

  async restart() {
    // Clear execution queue
    this.executionQueue = [];
    this.processing = false;
    this.currentExecutionId = null;
    
    this.destroy(false); // Don't remove listeners
    await this.start();
  }

  cleanup() {
    try {
      if (this.connectionFilePath && fs.existsSync(this.connectionFilePath)) {
        fs.unlinkSync(this.connectionFilePath);
      }
    } catch (e) {
      // Ignore errors on cleanup
    }
  }

  destroy(removeListeners = true) {
    this.isDestroyed = true;
    
    if (this.kernelProcess) {
      this.kernelProcess.kill();
      this.kernelProcess = null;
    }
    
    this.cleanup();
    
    if (this.messageProcessor) {
      clearInterval(this.messageProcessor);
      this.messageProcessor = null;
    }
    
    if (removeListeners) {
      this.emitter.removeAllListeners();
    }
  }
}

module.exports = Kernel;