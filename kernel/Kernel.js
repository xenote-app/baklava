const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zmq = require('zeromq');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const debug = require('debug')('jupyter:kernel');

class Kernel {
  constructor(docId, docPath, options = {}) {
    this.docId = docId;
    this.docPath = docPath;
    this.emitter = new EventEmitter();
    this.isDestroyed = false;
    this.executionQueue = [];
    this.processing = false;
    this.currentExecutionId = null;
    this.verbose = options.verbose || false;
    
    // Add subscriber tracking
    this.subscribers = new Set();
    this.status = 'idle';
    this.activeExecutions = 0;
    this.lastActivity = Date.now();
    
    // Channel locks for preventing concurrent send operations
    this.channelLocks = {
      shell: Promise.resolve(),
      control: Promise.resolve(),
      stdin: Promise.resolve(),
      iopub: Promise.resolve()
    };
  }

  /**
   * Serializes the kernel state to JSON
   */
  toJSON() {
    return {
      docId: this.docId,
      docPath: this.docPath,
      isDestroyed: this.isDestroyed,
      status: this.status,
      activeExecutions: this.activeExecutions,
      executionQueue: this.executionQueue.map(item => item.executionId),
      processing: this.processing,
      currentExecutionId: this.currentExecutionId,
      subscriberCount: this.subscribers.size,
      lastActivity: this.lastActivity,
      pid: this.kernelProcess ? this.kernelProcess.pid : null,
      connected: !!this.channels
    };
  }

  /**
   * Emits a kernel update event
   */
  emitKernelUpdate() {
    this.emitter.emit('kernel_update', this.toJSON());
  }

  async start() {
    debug(`Starting kernel for document ${this.docId}`);
    const connectionFilePath = path.join(require('os').tmpdir(), `kernel-${uuid()}.json`);
    
    const kernelProcess = spawn(
      'jupyter',
      ['kernel', '--KernelManager.connection_file=' + connectionFilePath]
    );
    
    kernelProcess.stdout.on('data', (data) => {
      if (this.verbose) {
        debug(`Kernel process stdout: ${data.toString().trim()}`);
      }
    });
    
    kernelProcess.stderr.on('data', (data) => {
      if (this.verbose) {
        debug(`Kernel process stderr: ${data.toString().trim()}`);
      }
    });
    
    kernelProcess.on('error', (error) => {
      debug(`Kernel process error: ${error.message}`);
      this.emitter.emit('error', error);
    });
    
    kernelProcess.on('exit', (code, signal) => {
      debug(`Kernel process exited with code ${code} and signal ${signal}`);
      if (!this.isDestroyed) {
        this.emitter.emit('error', new Error(`Kernel process exited unexpectedly with code ${code}`));
      }
    });

    debug(`Waiting for connection file: ${connectionFilePath}`);
    const connectionInfo = await this.waitForConnectionFile(connectionFilePath);

    if (!connectionInfo) {
      throw new Error('Unable to start kernel connection.');
    }

    this.connectionInfo = connectionInfo;
    this.kernelProcess = kernelProcess;
    this.connectionFilePath = connectionFilePath;

    // Set up cleanup handler for the connection file
    process.on('exit', () => {
      this.cleanup();
    });

    await this.connectChannels();
    this.startIOPubReceiver();
    
    debug(`Kernel startup complete for document ${this.docId}`);
    this.emitKernelUpdate();
    return this;
  }
  
  // Subscriber management methods
  addSubscriber(socketId) {
    this.subscribers.add(socketId);
    debug(`Socket ${socketId} subscribed to kernel ${this.docId} (total subscribers: ${this.subscribers.size})`);
    this.emitKernelUpdate();
    return this.subscribers.size;
  }
  
  removeSubscriber(socketId) {
    const removed = this.subscribers.delete(socketId);
    if (removed) {
      debug(`Socket ${socketId} unsubscribed from kernel ${this.docId} (remaining subscribers: ${this.subscribers.size})`);
      this.emitKernelUpdate();
    }
    return this.subscribers.size;
  }
  
  hasSubscriber(socketId) {
    return this.subscribers.has(socketId);
  }
  
  getSubscriberCount() {
    return this.subscribers.size;
  }
  
  getSubscribers() {
    return Array.from(this.subscribers);
  }

  async closeChannels() {
    debug(`Closing ZMQ channels`);
    
    if (!this.channels) {
      return;
    }
    
    for (const [name, channel] of Object.entries(this.channels)) {
      if (channel && typeof channel.close === 'function') {
        await channel.close();
      }
    }
    
    this.channels = null;
  }
  
  async waitForConnectionFile(connectionFilePath) {
    debug(`Waiting for connection file to be created: ${connectionFilePath}`);
    return await new Promise((resolve) => {
      let i = 0, MAX_TRIES = 8, TRY_INTERVAL = 300;
      let connectionData = null;

      const ts = setInterval(function () {
        if (fs.existsSync(connectionFilePath)) {
          try { 
            connectionData = JSON.parse(fs.readFileSync(connectionFilePath, 'utf8'));
          }
          catch(e) { 
            // Connection file exists but not ready yet
          } 
        }
        
        if (connectionData || i >= MAX_TRIES) { 
          clearInterval(ts); 
          resolve(connectionData); 
        }
        i += 1;
      }, TRY_INTERVAL);
    });
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
    debug(`All channels connected successfully`);
  }

  startIOPubReceiver() {
    const kernel = this;
    let isReceiving = false;
    let shouldContinue = true;
    
    const receiveMessages = async () => {
      if (isReceiving || kernel.isDestroyed) {
        return;
      }
      
      isReceiving = true;
      
      try {
        const response = await kernel.channels.iopub.receive();
        const part = response.slice(1);

        if (part.length >= 6) {
          try {
            const
              header = JSON.parse(part[2].toString()),
              parentHeader = JSON.parse(part[3].toString()),
              content = JSON.parse(part[5].toString()),
              type = header.msg_type,
              message = { type, content, parentHeader, header };
            
            if (kernel.verbose) {
              debug(`Received IOPub message: ${type}`);
            }
            
            // Update kernel status based on message type
            if (type === 'status') {
              const prevStatus = kernel.status;
              kernel.status = content.execution_state;
              
              if (prevStatus !== kernel.status) {
                debug(`Kernel ${kernel.docId} status changed: ${prevStatus} -> ${kernel.status}`);
                kernel.emitKernelUpdate();
              }
              
              if (content.execution_state === 'idle' && kernel.activeExecutions > 0) {
                kernel.activeExecutions--;
                debug(`Execution completed in kernel ${kernel.docId}, active: ${kernel.activeExecutions}`);
                kernel.emitKernelUpdate();
              } 
            }
            
            kernel.emitter.emit('message', message);
            kernel.emitter.emit(`message:${type}`, message);
            
            if (parentHeader.msg_id) {
              const executionId = parentHeader.msg_id;
              kernel.emitter.emit(`execution:${executionId}`, message);
              
              // Process status:idle messages (execution completion)
              if (type === 'status' && content.execution_state === 'idle') {
                if (kernel.currentExecutionId === executionId) {
                  debug(`Execution ${executionId} completed, kernel is now idle`);
                  
                  // Emit execution complete event directly from message
                  kernel.emitter.emit('execution_complete', { 
                    executionId,
                    success: true,
                    timestamp: Date.now()
                  });
                  
                  // Reset execution flags
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Process next execution 
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  kernel.emitKernelUpdate();
                }
              }
              
              // Handle error messages
              if (type === 'error') {
                debug(`Error in execution ${executionId}: ${content.ename}: ${content.evalue}`);
                kernel.emitter.emit('execution_complete', { 
                  executionId,
                  success: false,
                  timestamp: Date.now(),
                  error: new Error(`${content.ename}: ${content.evalue}`),
                  traceback: content.traceback
                });
                
                // Check if this is for the current execution
                if (kernel.currentExecutionId === executionId) {
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Process next execution
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  kernel.emitKernelUpdate();
                }
              }
            }
          } catch (parseError) {
            debug(`Error parsing IOPub message: ${parseError.message}`);
          }
        }
        
        isReceiving = false;
        if (!kernel.isDestroyed && shouldContinue) {
          setImmediate(receiveMessages);
        }
      } catch (error) {
        isReceiving = false;
        
        if (!kernel.isDestroyed && shouldContinue) {
          setTimeout(() => {
            if (!kernel.isDestroyed && shouldContinue) {
              receiveMessages();
            }
          }, 1000);
        }
      }
    };
    
    // Start the receiver
    receiveMessages();
    
    // Add a method to stop the receiver cleanly
    kernel.stopIOPubReceiver = () => {
      debug(`Stopping IOPub receiver for kernel ${kernel.docId}`);
      shouldContinue = false;
    };
  }

  async processNextExecution() {
    // Check if we're already processing
    if (this.processing || this.executionQueue.length === 0) {
      return;
    }

    debug(`Processing next execution from queue (${this.executionQueue.length} remaining)`);
    
    // Set processing flag
    this.processing = true;
    
    // Take the next request from the queue
    const request = this.executionQueue.shift();
    
    // Emit kernel update for queue change
    this.emitKernelUpdate();
    
    const msg = this.createMessage(request.executionId, request.sessionId, 'execute_request', {
      code: request.code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: true,
      stop_on_error: true
    });
    
    this.currentExecutionId = msg.header.msg_id;
    
    // Update active executions counter
    this.activeExecutions++;
    this.emitKernelUpdate();
    
    debug(`Starting execution ${this.currentExecutionId}`);
    
    // Emit execution_start event
    this.emitter.emit('execution_start', { 
      executionId: this.currentExecutionId,
      sessionId: request.sessionId,
      code: request.code,
      timestamp: Date.now()
    });
    
    try {
      // Send the message to the kernel
      await this.sendKernelMessage(msg);
      
      // Wait for the shell reply
      try {
        const reply = await this.channels.shell.receive();
        
        // Parse the reply
        if (reply.length >= 6) {
          const header = JSON.parse(reply[3].toString());
          const content = reply[6] && JSON.parse(reply[6].toString());
          
          if (this.verbose) {
            debug(`Received shell reply for execution ${msg.header.msg_id}`);
          }
          
          // Emit an event for the reply
          this.emitter.emit(`shell_reply:${msg.header.msg_id}`, { header, content });
        }
      } catch (shellError) {
        debug(`Error receiving shell reply: ${shellError.message}`);
        // Force execution to finish if there's a shell error
        this.emitter.emit('execution_complete', { 
          executionId: this.currentExecutionId,
          success: false,
          error: shellError,
          timestamp: Date.now()
        });
        
        // Reset execution state
        this.processing = false;
        this.currentExecutionId = null;
        if (this.activeExecutions > 0) this.activeExecutions--;
        this.emitKernelUpdate();
        
        // Process next execution with a delay
        setTimeout(() => this.processNextExecution(), 50);
      }
      
      // Note: We don't set processing to false here - that will happen when 
      // we receive the status:idle message from the IOPub channel
    } catch (error) {
      debug(`Error in execution ${this.currentExecutionId}: ${error.message}`);
      
      // Reset execution state
      this.processing = false;
      this.currentExecutionId = null;
      if (this.activeExecutions > 0) this.activeExecutions--;
      
      // Emit error event
      this.emitter.emit('execution_complete', { 
        executionId: msg.header.msg_id,
        success: false,
        error,
        timestamp: Date.now()
      });
      
      this.emitKernelUpdate();
      
      // Process next execution with a delay
      setTimeout(() => this.processNextExecution(), 50);
    }
  }

  async sendExecuteRequest({ executionId, sessionId, code }) {
    // Create a unique ID for this execution if not provided
    const execId = executionId || uuid();
    const sessId = sessionId || uuid();
    
    debug(`Queuing execution request ${execId} (code length: ${code.length})`);
    if (this.verbose) {
      debug(`Code preview: ${code.slice(0, 50)}${code.length > 50 ? '...' : ''}`);
    }
    
    // Add the request to the queue
    this.executionQueue.push({ executionId: execId, sessionId: sessId, code });
        
    // Emit kernel update for queue change
    this.emitKernelUpdate();
    
    // Directly trigger processing if not already running
    if (!this.processing) {
      // Use setTimeout to avoid potential race conditions
      setTimeout(() => {
        this.processNextExecution();
      }, 0);
    }
    
    return execId; // Return the execution ID
  }

  createMessage(messageId, sessionId, msg_type, content = {}) {
    const msgId = messageId || uuid();
    const sessId = sessionId || uuid();
    
    return {
      header: {
        msg_id: msgId,
        username: 'node-kernel-client',
        session: sessId,
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

  async sendKernelMessage(message) {
    const msg_type = message.header.msg_type;
    
    if (!this.channels) {
      throw new Error('Cannot send message: channels not initialized');
    }
    
    const msg_list = [
      JSON.stringify(message.header),
      JSON.stringify(message.parent_header),
      JSON.stringify(message.metadata),
      JSON.stringify(message.content)
    ];

    const key = this.connectionInfo.key;
    
    // Determine which channel to use based on message type
    let channelName;
    if (msg_type.startsWith('execute_')) {
      channelName = 'shell';
    } else if (msg_type.startsWith('kernel_')) {
      channelName = 'control';
    } else if (msg_type.startsWith('input_')) {
      channelName = 'stdin';
    } else if (msg_type === 'interrupt_request') {
      channelName = 'control';
    } else {
      channelName = 'shell'; // Default to shell
    }
    
    const channel = this.channels[channelName];
    
    if (!channel) {
      throw new Error(`Channel ${channelName} is not available`);
    }
    
    // Create signature
    const signature = key
      ? crypto.createHmac('sha256', key).update(msg_list.join('')).digest('hex')
      : '';
    
    // Add retry logic for EBUSY errors
    const maxRetries = 3;
    const retryDelay = 1000;
    
    const sendWithRetries = async (retryCount = 0) => {
      try {
        // Try to send the message
        await channel.send(['<IDS|MSG>', signature, ...msg_list]);
        return message;
      } catch (error) {
        // Handle EBUSY errors with retries
        if (error.code === 'EBUSY' && retryCount < maxRetries) {
          debug(`EBUSY error sending message ${message.header.msg_id}, retrying...`);
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, retryCount)));
          // Recursive retry
          return sendWithRetries(retryCount + 1);
        }
        
        throw error;
      }
    };
    
    // Use a channel lock to prevent concurrent sends to the same channel
    let result;
    
    this.channelLocks[channelName] = this.channelLocks[channelName]
      .then(() => sendWithRetries())
      .then(r => {
        result = r;
        return r;
      });
    
    try {
      // Wait for the send operation to complete
      await this.channelLocks[channelName];
      return result;
    } catch (error) {
      debug(`Failed to send message ${message.header.msg_id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Interrupts the currently running execution
   */
  async interrupt() {
    if (!this.kernelProcess || !this.channels || !this.currentExecutionId) {
      debug('No active execution to interrupt');
      return false;
    }
    
    debug(`Interrupting current execution ${this.currentExecutionId}`);
    
    // Using control channel to send interrupt_request
    const msg = this.createMessage(uuid(), null, 'interrupt_request', {});
    
    // Send the interrupt request through the control channel
    await this.sendKernelMessage(msg);
    await this.channels.control.receive();

    // Emit an event for the interrupt
    this.emitter.emit('execution_interrupted', {
      executionId: this.currentExecutionId,
      timestamp: Date.now()
    });
    
    // Update kernel state
    this.emitKernelUpdate();
    
    return true;
  }

  removeFromQueue(executionId) {
    if (!executionId) {
      return false;
    }
    this.executionQueue = this.executionQueue.filter(item => item.executionId !== executionId);
    this.emitKernelUpdate();
  }

  cleanup() {
    try {
      if (this.connectionFilePath && fs.existsSync(this.connectionFilePath)) {
        fs.unlinkSync(this.connectionFilePath);
      }
    } catch (e) {
      debug(`Error during cleanup: ${e.message}`);
    }
  }

  destroy(removeListeners = true) {
    debug(`Destroying kernel for document ${this.docId}`);
    this.isDestroyed = true;
    
    // Stop IOPub receiver cleanly if it exists
    if (this.stopIOPubReceiver) {
      this.stopIOPubReceiver();
    }
    
    // Close ZMQ channels
    this.closeChannels();
    
    if (this.kernelProcess) {
      try {
        this.kernelProcess.kill();
      } catch (error) {
        debug(`Error killing kernel process: ${error.message}`);
      }
      this.kernelProcess = null;
    }
    
    this.cleanup();
    
    // Clear subscribers
    this.subscribers.clear();
    
    if (removeListeners) {
      this.emitter.removeAllListeners();
    }
  }
}

module.exports = Kernel;