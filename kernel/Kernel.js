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
    this.executionQueue = []; // Queue to manage execution requests
    this.processing = false; // Flag to track if we're currently processing a request
    this.currentExecutionId = null; // Track current execution
    this.options = {
      verbose: options.verbose || false,
      retryCount: options.retryCount || 3,
      retryDelay: options.retryDelay || 1000,
      connectTimeout: options.connectTimeout || 15000,
      executeTimeout: options.executeTimeout || 30000,
      ...options
    };
    
    // Add channel locks to prevent concurrent send operations
    this.channelLocks = {
      shell: Promise.resolve(),
      control: Promise.resolve(),
      stdin: Promise.resolve(),
      iopub: Promise.resolve()
    };
    
    debug(`Kernel initialized for document ${docId} with options:`, this.options);
  }

  async start() {
    debug(`Starting kernel for document ${this.docId}`);
    const connectionFilePath = path.join(require('os').tmpdir(), `kernel-${uuid()}.json`);
    
    debug(`Spawning Jupyter kernel process`);
    const kernelProcess = spawn(
      'jupyter',
      ['kernel', '--KernelManager.connection_file=' + connectionFilePath]
    );
    
    // Handle process stdout/stderr for debugging
    kernelProcess.stdout.on('data', (data) => {
      debug(`Kernel process stdout: ${data.toString().trim()}`);
    });
    
    kernelProcess.stderr.on('data', (data) => {
      debug(`Kernel process stderr: ${data.toString().trim()}`);
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
      const error = new Error('Unable to start kernel connection.');
      debug(`Kernel startup failed: ${error.message}`);
      throw error;
    }

    debug(`Connection file loaded, connecting to kernel`);
    this.connectionInfo = connectionInfo;
    this.kernelProcess = kernelProcess;
    this.connectionFilePath = connectionFilePath;

    // Set up cleanup handler for the connection file
    process.on('exit', () => {
      this.cleanup();
    });

    try {
      await this.connectChannels();
      this.startIOPubReceiver();
      
      debug(`Kernel startup complete for document ${this.docId}`);
      this.emitQueueUpdate(); // Emit initial queue state
      return this; // Return this for chaining
    } catch (error) {
      debug(`Error during kernel startup: ${error.message}`);
      this.cleanup();
      throw error;
    }
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
            debug(`Connection file loaded successfully on attempt ${i+1}`);
          }
          catch(e) { 
            debug(`Connection file exists but not ready yet (attempt ${i+1})`);
          } 
        } else {
          debug(`Connection file does not exist yet (attempt ${i+1})`);
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
    debug(`Connecting to ZMQ channels`);
    const channels = {};
    const ci = this.connectionInfo;

    try {
      // Shell channel - for code execution requests
      debug(`Connecting to shell channel on port ${ci.shell_port}`);
      channels.shell = new zmq.Request();
      await Promise.race([
        channels.shell.connect(`${ci.transport}://${ci.ip}:${ci.shell_port}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Shell channel connection timeout')), this.options.connectTimeout))
      ]);
      
      // IOPub channel - for output streams
      debug(`Connecting to iopub channel on port ${ci.iopub_port}`);
      channels.iopub = new zmq.Subscriber();
      await Promise.race([
        channels.iopub.connect(`${ci.transport}://${ci.ip}:${ci.iopub_port}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IOPub channel connection timeout')), this.options.connectTimeout))
      ]);
      await channels.iopub.subscribe('');
      
      // Control channel - for kernel control
      debug(`Connecting to control channel on port ${ci.control_port}`);
      channels.control = new zmq.Request();
      await Promise.race([
        channels.control.connect(`${ci.transport}://${ci.ip}:${ci.control_port}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Control channel connection timeout')), this.options.connectTimeout))
      ]);
      
      // Stdin channel - for input requests
      debug(`Connecting to stdin channel on port ${ci.stdin_port}`);
      channels.stdin = new zmq.Request();
      await Promise.race([
        channels.stdin.connect(`${ci.transport}://${ci.ip}:${ci.stdin_port}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stdin channel connection timeout')), this.options.connectTimeout))
      ]);
      
      this.channels = channels;
      debug(`All channels connected successfully`);
    } catch (error) {
      debug(`Error connecting to channels: ${error.message}`);
      throw error;
    }
  }

  startIOPubReceiver() {
    debug(`Starting IOPub message receiver`);
    const kernel = this;
    
    // Flag to track if we're currently receiving messages
    kernel.isReceiving = false;
    
    const receiveMessages = async () => {
      if (kernel.isReceiving) {
        // Already receiving messages, don't start another receiver
        return;
      }
      
      kernel.isReceiving = true;
      
      try {
        // Wait for the next message with timeout
        const receivePromise = kernel.channels.iopub.receive();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('IOPub receive timeout')), 60000) // 1-minute timeout
        );
        
        let response;
        try {
          response = await Promise.race([receivePromise, timeoutPromise]);
        } catch (error) {
          if (error.message === 'IOPub receive timeout') {
            // This is just a timeout, not a real error
            debug(`IOPub receive timeout (expected during inactivity)`);
            kernel.isReceiving = false;
            if (!kernel.isDestroyed) {
              setImmediate(receiveMessages);
            }
            return;
          }
          // For real errors, continue to error handling
          throw error;
        }
        
        const part = response.slice(1);

        if (part.length >= 6) {
          try {
            const
              header = JSON.parse(part[2].toString()),
              parentHeader = JSON.parse(part[3].toString()),
              content = JSON.parse(part[5].toString()),
              type = header.msg_type,
              message = { type, content, parentHeader, header };
            
            if (kernel.options.verbose) {
              debug(`Received IOPub message: ${type}`, content);
            } else {
              debug(`Received IOPub message: ${type}`);
            }
            
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
                  debug(`Execution ${executionId} completed, kernel is now idle`);
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Emit an execution complete event
                  kernel.emitter.emit('execution_complete', { 
                    executionId,
                    success: true 
                  });
                  
                  // Process next execution with a small delay to prevent race conditions
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  // Emit queue update since we've completed an execution
                  kernel.emitQueueUpdate();
                }
              }
              
              // Special handling for error messages
              if (type === 'error') {
                debug(`Error in execution ${parentHeader.msg_id}: ${content.ename}: ${content.evalue}`);
                kernel.emitter.emit('execution_complete', { 
                  executionId: parentHeader.msg_id,
                  success: false,
                  error: new Error(`${content.ename}: ${content.evalue}`)
                });
                
                // Check if this is for the current execution
                if (kernel.currentExecutionId === parentHeader.msg_id) {
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Process next execution with a small delay
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  // Emit queue update
                  kernel.emitQueueUpdate();
                }
              }
            }
          } catch (parseError) {
            debug(`Error parsing IOPub message: ${parseError.message}`);
            kernel.emitter.emit('error', new Error(`Failed to parse IOPub message: ${parseError.message}`));
          }
        } else {
          debug(`Received invalid IOPub message format (parts: ${part.length})`);
        }
        
        // Reset receiving flag and continue receiving if the kernel is still active
        kernel.isReceiving = false;
        if (!kernel.isDestroyed) {
          setImmediate(receiveMessages);
        }
      } catch (error) {
        kernel.isReceiving = false;
        if (!kernel.isDestroyed) {
          debug(`Error in IOPub receiver: ${error.message}`);
          kernel.emitter.emit('error', error);
          // Try to reconnect after a brief delay
          setTimeout(receiveMessages, kernel.options.retryDelay);
        }
      }
    };
    
    // Start the receiver
    receiveMessages();
  }

  async processNextExecution() {
    // Double-check we're not already processing
    if (this.processing || this.executionQueue.length === 0) {
      debug("No execution to process: already processing or empty queue");
      return;
    }

    debug(`Processing next execution from queue (${this.executionQueue.length} remaining)`);
    
    // Set processing flag before doing anything else
    this.processing = true;
    
    // Take the next request from the queue
    const request = this.executionQueue.shift();
    
    // Emit queue update since we're removing an item from the queue
    this.emitQueueUpdate();
    
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
      
      debug(`Starting execution ${this.currentExecutionId}`);
      this.emitter.emit('execution_start', { 
        executionId: this.currentExecutionId,
        code: request.code.slice(0, 100) + (request.code.length > 100 ? '...' : '')
      });
      
      // Create a timeout for this execution
      const executionTimeout = setTimeout(() => {
        if (this.currentExecutionId === msg.header.msg_id && this.processing) {
          debug(`Execution timeout for ${msg.header.msg_id}`);
          this.emitter.emit('execution_timeout', { 
            executionId: msg.header.msg_id,
            timeout: this.options.executeTimeout
          });
        }
      }, this.options.executeTimeout);
      
      // Send the message to the kernel
      await this.sendKernelMessage(msg);
      
      // Now wait for the reply from the shell channel
      try {
        const receivePromise = this.channels.shell.receive();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Shell reply timeout')), this.options.executeTimeout)
        );
        
        const reply = await Promise.race([receivePromise, timeoutPromise]);
        
        // Parse the reply
        if (reply.length >= 6) {
          try {
            const
              header = JSON.parse(reply[3].toString()),
              content = JSON.parse(reply[6].toString());
            
            debug(`Received shell reply for execution ${msg.header.msg_id}`, 
                  this.options.verbose ? content : undefined);
            
            // Emit an event for the reply
            this.emitter.emit(`shell_reply:${msg.header.msg_id}`, { header, content });
          } catch (parseError) {
            debug(`Error parsing shell reply: ${parseError.message}`);
          }
        } else {
          debug(`Received invalid shell reply format`);
        }
        
        // Clear the timeout
        clearTimeout(executionTimeout);
        
        // NOTE: We don't set processing to false here - that will happen when 
        // we receive the status:idle message from the IOPub channel
      } catch (timeoutError) {
        debug(`Timeout waiting for shell reply: ${timeoutError.message}`);
        clearTimeout(executionTimeout);
        
        // Force reset the processing state after timeout
        this.processing = false;
        this.currentExecutionId = null;
        
        // Emit a timeout event
        this.emitter.emit('execution_complete', { 
          executionId: msg.header.msg_id,
          success: false,
          error: new Error('Execution timed out waiting for shell reply')
        });
        
        // Emit queue update since execution state changed
        this.emitQueueUpdate();
        
        // Process the next execution with a delay
        setTimeout(() => {
          this.processNextExecution();
        }, 100);
      }
    } catch (error) {
      debug(`Error in execution ${request.executionId}: ${error.message}`);
      
      // Make sure to reset processing flags on error
      this.processing = false;
      this.currentExecutionId = null;
      
      // Emit error events
      this.emitter.emit('error', error);
      this.emitter.emit('execution_complete', { 
        executionId: request.executionId,
        success: false,
        error
      });
      
      // Emit queue update since execution state changed
      this.emitQueueUpdate();
      
      // Try to process the next execution after a delay
      setTimeout(() => {
        this.processNextExecution();
      }, 100);
    }
  }

  async sendExecuteRequest({ executionId, sessionId, code }) {
    // Create a unique ID for this execution if not provided
    const execId = executionId || uuid();
    
    debug(`Queuing execution request ${execId} (code length: ${code.length})`);
    if (this.options.verbose) {
      debug(`Code preview: ${code.slice(0, 100)}${code.length > 100 ? '...' : ''}`);
    }
    
    // Add the request to the queue
    this.executionQueue.push({ executionId: execId, sessionId, code });
    
    // Emit queue update event
    this.emitQueueUpdate();
    
    // Directly trigger processing if not already running
    if (!this.processing) {
      // Use setTimeout to avoid potential race conditions
      setTimeout(() => {
        this.processNextExecution();
      }, 0);
    }
    
    return execId; // Return the execution ID so the caller can listen for events
  }
  
  // Emit queue update events
  emitQueueUpdate() {
    const queueStatus = this.getQueueStatus();
    debug(`Emitting queue update: ${queueStatus.queueLength} items queued, active: ${queueStatus.processing ? queueStatus.currentExecutionId : 'none'}`);
    
    this.emitter.emit('queue_update', queueStatus);
  }

  createMessage(messageId, sessionId, msg_type, content = {}) {
    const msgId = messageId || uuid();
    const sessId = sessionId || uuid();
    
    debug(`Creating message: ${msg_type} (ID: ${msgId}, Session: ${sessId})`);
    
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

  // Enhanced send message with channel locking to prevent EBUSY errors
  async sendKernelMessage(message) {
    const msg_type = message.header.msg_type;
    debug(`Preparing to send message: ${msg_type} (ID: ${message.header.msg_id})`);
    
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
    } else {
      channelName = 'shell'; // Default to shell
    }
    
    debug(`Using ${channelName} channel for ${msg_type}`);
    const channel = this.channels[channelName];
    
    // Create signature
    const signature = key
      ? crypto.createHmac('sha256', key).update(msg_list.join('')).digest('hex')
      : '';
    
    // Use the channel lock to prevent concurrent access
    // This creates a chain of promises to ensure sequential access
    let result;
    
    this.channelLocks[channelName] = this.channelLocks[channelName].then(async () => {
      debug(`Acquired lock for ${channelName} channel to send message ${message.header.msg_id}`);
      try {
        // ZMQ identity frame (blank for now) followed by the message parts
        await channel.send(['<IDS|MSG>', signature, ...msg_list]);
        debug(`Message ${message.header.msg_id} sent successfully on ${channelName} channel`);
        result = message;
      } catch (error) {
        debug(`Error sending message ${message.header.msg_id} on ${channelName} channel: ${error.message}`);
        throw error;
      } finally {
        debug(`Released lock for ${channelName} channel after message ${message.header.msg_id}`);
      }
    }).catch(error => {
      debug(`Error in channel lock for ${channelName}: ${error.message}`);
      throw error;
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

  async interrupt() {
    if (this.kernelProcess && this.kernelProcess.pid) {
      debug(`Interrupting kernel process (PID: ${this.kernelProcess.pid})`);
      try {
        process.kill(this.kernelProcess.pid, 'SIGINT');
        
        // Reset execution state
        this.processing = false;
        this.currentExecutionId = null;
        
        // Emit queue update since execution state changed
        this.emitQueueUpdate();
        
        debug(`Kernel interrupt signal sent successfully`);
        return true;
      } catch (error) {
        debug(`Error interrupting kernel: ${error.message}`);
        return false;
      }
    }
    debug(`Cannot interrupt kernel: no process or PID available`);
    return false;
  }

  async restart() {
    debug(`Restarting kernel for document ${this.docId}`);
    
    // Clear execution queue
    const hadItems = this.executionQueue.length > 0;
    this.executionQueue = [];
    this.processing = false;
    this.currentExecutionId = null;
    
    // Reset channel locks
    this.channelLocks = {
      shell: Promise.resolve(),
      control: Promise.resolve(),
      stdin: Promise.resolve(),
      iopub: Promise.resolve()
    };
    
    // Emit queue update if we had items
    if (hadItems) {
      this.emitQueueUpdate();
    }
    
    try {
      this.destroy(false); // Don't remove listeners
      await this.start();
      debug(`Kernel restart completed successfully`);
      return true;
    } catch (error) {
      debug(`Error restarting kernel: ${error.message}`);
      throw error;
    }
  }

  cleanup() {
    debug(`Cleaning up kernel resources`);
    try {
      if (this.connectionFilePath && fs.existsSync(this.connectionFilePath)) {
        fs.unlinkSync(this.connectionFilePath);
        debug(`Removed connection file: ${this.connectionFilePath}`);
      }
    } catch (e) {
      debug(`Error during cleanup: ${e.message}`);
    }
  }

  destroy(removeListeners = true) {
    debug(`Destroying kernel for document ${this.docId}`);
    this.isDestroyed = true;
    
    if (this.kernelProcess) {
      try {
        this.kernelProcess.kill();
        debug(`Kernel process terminated`);
      } catch (error) {
        debug(`Error killing kernel process: ${error.message}`);
      }
      this.kernelProcess = null;
    }
    
    this.cleanup();
    
    if (this.messageProcessor) {
      clearInterval(this.messageProcessor);
      this.messageProcessor = null;
      debug(`Message processor stopped`);
    }
    
    if (removeListeners) {
      this.emitter.removeAllListeners();
      debug(`Event listeners removed`);
    } else {
      debug(`Event listeners preserved (for restart)`);
    }
    
    debug(`Kernel destruction complete`);
  }
  
  // Utility methods for debugging and diagnostics
  getState() {
    return {
      docId: this.docId,
      docPath: this.docPath,
      isDestroyed: this.isDestroyed,
      processing: this.processing,
      currentExecutionId: this.currentExecutionId,
      queueLength: this.executionQueue.length,
      isConnected: !!this.channels,
      hasProcess: !!this.kernelProcess,
      pid: this.kernelProcess ? this.kernelProcess.pid : null
    };
  }
  
  getQueueStatus() {
    return {
      queueLength: this.executionQueue.length,
      processing: this.processing,
      currentExecutionId: this.currentExecutionId,
      queued: this.executionQueue.map(item => ({
        executionId: item.executionId,
        sessionId: item.sessionId,
        codeLength: item.code.length,
        codePreview: item.code.slice(0, 50) + (item.code.length > 50 ? '...' : '')
      }))
    };
  }
}

module.exports = Kernel;