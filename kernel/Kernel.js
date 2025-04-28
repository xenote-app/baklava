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
    
    // Add execution tracking
    this.executionOutputs = new Map(); // Map to store outputs for each execution
    this.executionStartTimes = new Map(); // Track when executions start
    this.executionSessions = new Map(); // Track session ID for each execution
    this.executionCodes = new Map(); // Track code for each execution
    
    // Add subscriber tracking directly to kernel
    this.subscribers = new Set(); // Set of socketIds subscribed to this kernel
    this.status = 'idle'; // Track kernel status
    this.activeExecutions = 0; // Track number of active executions
    this.lastActivity = Date.now(); // Track last activity timestamp
    
    debug(`Kernel initialized for document ${docId} with options:`, this.options);
  }

  /**
   * Serializes the kernel state to JSON
   * @returns {Object} JSON representation of the kernel
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
      connected: !!this.channels,
    };
  }

  /**
   * Emits a kernel update event
   * This should be called whenever the kernel state changes
   */
  emitKernelUpdate() {
    this.emitter.emit('kernel_update', this.toJSON());
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
      this.emitKernelUpdate(); // Emit initial kernel state
      return this; // Return this for chaining
    } catch (error) {
      debug(`Error during kernel startup: ${error.message}`);
      this.cleanup();
      throw error;
    }
  }
  
  // Subscriber management methods
  addSubscriber(socketId) {
    this.subscribers.add(socketId);
    debug(`Socket ${socketId} subscribed to kernel ${this.docId} (total subscribers: ${this.subscribers.size})`);
    
    this.emitKernelUpdate(); // Emit update after subscriber added
    return this.subscribers.size;
  }
  
  removeSubscriber(socketId) {
    const removed = this.subscribers.delete(socketId);
    if (removed) {
      debug(`Socket ${socketId} unsubscribed from kernel ${this.docId} (remaining subscribers: ${this.subscribers.size})`);
      this.emitKernelUpdate(); // Emit update after subscriber removed
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
      debug('No channels to close');
      return;
    }
    
    // Close each channel with proper error handling
    for (const [name, channel] of Object.entries(this.channels)) {
      try {
        debug(`Closing ${name} channel`);
        if (channel && typeof channel.close === 'function') {
          await channel.close();
          debug(`${name} channel closed successfully`);
        }
      } catch (error) {
        debug(`Error closing ${name} channel: ${error.message}`);
        // Continue closing other channels even if one fails
      }
    }
    
    this.channels = null;
    debug('All channels closed');
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
    
    // Use a proper lock mechanism with atomic operations
    let isReceiving = false;
    let shouldContinue = true;
    let receivePromise = null;
    
    const receiveMessages = async () => {
      // Critical section - only enter if not already receiving
      if (isReceiving || kernel.isDestroyed) {
        return;
      }
      
      // Set flag immediately to prevent race conditions
      isReceiving = true;
      
      try {
        // Create a single receive promise that we can reuse
        if (!receivePromise) {
          receivePromise = kernel.channels.iopub.receive();
        }
        
        // Set up a timeout that won't interfere with the receive operation
        const timeoutPromise = new Promise((_, reject) => {
          const timeout = setTimeout(() => {
            clearTimeout(timeout); // Cleanup
            reject(new Error('IOPub receive timeout'));
          }, 60000); // 1-minute timeout
        });
        
        let response;
        try {
          // Use race to handle timeout without canceling the receive operation
          response = await Promise.race([receivePromise, timeoutPromise]);
          
          // Reset the promise since we got a response successfully
          receivePromise = null;
        } catch (error) {
          if (error.message === 'IOPub receive timeout') {
            // This is just a timeout, not a real error
            debug(`IOPub receive timeout (expected during inactivity)`);
            isReceiving = false;
            
            // Schedule next receive attempt after a very short delay
            if (!kernel.isDestroyed && shouldContinue) {
              setTimeout(receiveMessages, 10);
            }
            return;
          }
          
          // For EBUSY or other socket errors, reset the promise
          if (error.code === 'EBUSY') {
            debug(`Socket busy error in IOPub receiver: ${error.message}`);
            receivePromise = null;
          }
          
          // Rethrow for other error handling
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
            
            // Update kernel status based on message type
            if (type === 'status') {
              const prevStatus = kernel.status;
              kernel.status = content.execution_state;
              
              if (prevStatus !== kernel.status) {
                debug(`Kernel ${kernel.docId} status changed: ${prevStatus} -> ${kernel.status}`);
                kernel.emitKernelUpdate(); // Emit update after status change
              }
              
              // If this is a status:idle message, decrement active executions counter
              if (content.execution_state === 'idle' && kernel.activeExecutions > 0) {
                kernel.activeExecutions--;
                debug(`Execution completed in kernel ${kernel.docId}, active: ${kernel.activeExecutions}`);
                kernel.emitKernelUpdate(); // Emit update after active executions change
              } else if (content.execution_state === 'busy') {
                // The busy state often indicates the start of an execution
                debug(`Kernel ${kernel.docId} is busy`);
              }
            }
            
            kernel.emitter.emit('message', message);
            // Also emit specific event types
            kernel.emitter.emit(`message:${type}`, message);
            
            // Process execution-related messages
            if (parentHeader.msg_id) {
              const executionId = parentHeader.msg_id;
              kernel.emitter.emit(`execution:${executionId}`, message);
              
              // Track outputs for stream, display_data, execute_result, and error messages
              if (['stream', 'display_data', 'execute_result', 'error'].includes(type)) {
                const outputs = kernel.executionOutputs.get(executionId) || [];
                outputs.push({
                  type,
                  content,
                  timestamp: Date.now()
                });
                kernel.executionOutputs.set(executionId, outputs);
              }
              
              // Process status:idle messages (execution completion)
              if (type === 'status' && content.execution_state === 'idle') {
                if (kernel.currentExecutionId === executionId) {
                  debug(`Execution ${executionId} completed, kernel is now idle`);
                  
                  // Calculate execution time
                  const startTime = kernel.executionStartTimes.get(executionId) || Date.now();
                  const executionTime = Date.now() - startTime;
                  
                  // Get collected outputs and session info
                  const outputs = kernel.executionOutputs.get(executionId) || [];
                  const sessionId = kernel.executionSessions.get(executionId);
                  
                  // Emit enhanced execution complete event
                  kernel.emitter.emit('execution_complete', { 
                    executionId,
                    sessionId,
                    success: true,
                    executionTime,
                    outputs,
                    timestamp: Date.now()
                  });
                  
                  // Clean up tracking data to prevent memory leaks
                  kernel.executionStartTimes.delete(executionId);
                  kernel.executionOutputs.delete(executionId);
                  kernel.executionSessions.delete(executionId);
                  kernel.executionCodes.delete(executionId);
                  
                  // Reset execution flags
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Process next execution with a small delay to prevent race conditions
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  // Emit queue update since we've completed an execution
                  kernel.emitQueueUpdate();
                }
              }
              
              // Handle error messages
              if (type === 'error') {
                // Calculate execution time for the current execution
                let executionTime = 0;
                if (kernel.executionStartTimes.has(executionId)) {
                  const startTime = kernel.executionStartTimes.get(executionId);
                  executionTime = Date.now() - startTime;
                }
                
                // Get collected outputs and session info
                const outputs = kernel.executionOutputs.get(executionId) || [];
                const sessionId = kernel.executionSessions.get(executionId);
                
                debug(`Error in execution ${executionId}: ${content.ename}: ${content.evalue}`);
                kernel.emitter.emit('execution_complete', { 
                  executionId,
                  sessionId,
                  success: false,
                  executionTime,
                  outputs,
                  timestamp: Date.now(),
                  error: new Error(`${content.ename}: ${content.evalue}`),
                  traceback: content.traceback
                });
                
                // Check if this is for the current execution
                if (kernel.currentExecutionId === executionId) {
                  // Clean up tracking data
                  kernel.executionStartTimes.delete(executionId);
                  kernel.executionOutputs.delete(executionId);
                  kernel.executionSessions.delete(executionId);
                  kernel.executionCodes.delete(executionId);
                  
                  kernel.processing = false;
                  kernel.currentExecutionId = null;
                  
                  // Process next execution with a small delay
                  setTimeout(() => {
                    kernel.processNextExecution();
                  }, 50);
                  
                  // Emit queue update
                  kernel.emitQueueUpdate();
                  kernel.emitKernelUpdate(); // Emit update after error
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
        
        // Reset the receiving flag and schedule next receive if kernel is still active
        isReceiving = false;
        if (!kernel.isDestroyed && shouldContinue) {
          // Use setImmediate for better performance
          setImmediate(receiveMessages);
        }
      } catch (error) {
        // Reset state and try to recover
        isReceiving = false;
        receivePromise = null;
        
        if (!kernel.isDestroyed && shouldContinue) {
          debug(`Error in IOPub receiver: ${error.message}`);
          kernel.emitter.emit('error', error);
          
          // Try to reconnect after a delay
          setTimeout(() => {
            if (!kernel.isDestroyed && shouldContinue) {
              receiveMessages();
            }
          }, kernel.options.retryDelay || 1000);
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
      
      // Store execution metadata for tracking
      this.executionStartTimes.set(this.currentExecutionId, Date.now());
      this.executionOutputs.set(this.currentExecutionId, []);
      this.executionSessions.set(this.currentExecutionId, request.sessionId);
      this.executionCodes.set(this.currentExecutionId, request.code);
      
      // Update active executions counter
      this.activeExecutions++;
      this.emitKernelUpdate(); // Emit update after active execution count changes
      
      debug(`Starting execution ${this.currentExecutionId}`);
      
      // Emit enhanced execution_start event with all necessary information
      this.emitter.emit('execution_start', { 
        executionId: this.currentExecutionId,
        sessionId: request.sessionId,
        code: request.code,
        timestamp: Date.now()
      });
      
      // Create a timeout for this execution
      const executionTimeout = setTimeout(() => {
        if (this.currentExecutionId === msg.header.msg_id && this.processing) {
          debug(`Execution timeout for ${msg.header.msg_id}`);
          this.emitter.emit('execution_timeout', { 
            executionId: msg.header.msg_id,
            sessionId: request.sessionId,
            timeout: this.options.executeTimeout,
            timestamp: Date.now()
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
        
        // Decrease active executions counter
        if (this.activeExecutions > 0) {
          this.activeExecutions--;
        }
        
        // Emit a timeout event with the session ID
        this.emitter.emit('execution_complete', { 
          executionId: msg.header.msg_id,
          sessionId: request.sessionId,
          success: false,
          executionTime: Date.now() - this.executionStartTimes.get(msg.header.msg_id),
          error: new Error('Execution timed out waiting for shell reply'),
          timestamp: Date.now()
        });
        
        // Clean up tracking data
        this.executionStartTimes.delete(msg.header.msg_id);
        this.executionOutputs.delete(msg.header.msg_id);
        this.executionSessions.delete(msg.header.msg_id);
        this.executionCodes.delete(msg.header.msg_id);
        
        // Emit queue update since execution state changed
        this.emitQueueUpdate();
        this.emitKernelUpdate(); // Emit update after timeout
        
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
      
      // Decrease active executions counter
      if (this.activeExecutions > 0) {
        this.activeExecutions--;
      }
      
      // Emit error events
      this.emitter.emit('error', error);
      this.emitter.emit('execution_complete', { 
        executionId: request.executionId,
        sessionId: request.sessionId,
        success: false,
        error,
        timestamp: Date.now()
      });
      
      // Emit queue update since execution state changed
      this.emitQueueUpdate();
      this.emitKernelUpdate(); // Emit update after error
      
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
        
    // Emit kernel update for queue change
    this.emitKernelUpdate();
    
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
    } else {
      channelName = 'shell'; // Default to shell
    }
    
    debug(`Using ${channelName} channel for ${msg_type}`);
    const channel = this.channels[channelName];
    
    if (!channel) {
      throw new Error(`Channel ${channelName} is not available`);
    }
    
    // Create signature
    const signature = key
      ? crypto.createHmac('sha256', key).update(msg_list.join('')).digest('hex')
      : '';
    
    // Use the channel lock to prevent concurrent access
    // This creates a chain of promises to ensure sequential access
    let result;
    
    // Add retry logic for EBUSY errors
    const maxRetries = 3;
    const retryDelay = this.options.retryDelay || 1000;
    
    const sendWithRetries = async (retryCount = 0) => {
      try {
        debug(`Acquired lock for ${channelName} channel to send message ${message.header.msg_id}`);
        
        // Try to send the message
        await channel.send(['<IDS|MSG>', signature, ...msg_list]);
        debug(`Message ${message.header.msg_id} sent successfully on ${channelName} channel`);
        return message;
      } catch (error) {
        // Handle EBUSY errors with retries
        if (error.code === 'EBUSY' && retryCount < maxRetries) {
          debug(`EBUSY error sending message ${message.header.msg_id}, retrying (${retryCount + 1}/${maxRetries})...`);
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, retryCount)));
          // Recursive retry
          return sendWithRetries(retryCount + 1);
        }
        
        debug(`Error sending message ${message.header.msg_id} on ${channelName} channel: ${error.message}`);
        throw error;
      }
    };
  
    this.channelLocks[channelName] = this.channelLocks[channelName]
      .then(() => sendWithRetries())
      .then(r => {
        result = r;
        return r;
      })
      .catch(error => {
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
        
        // Reset active executions counter
        this.activeExecutions = 0;
        
        // Emit execution_interrupted event for the current execution
        if (this.currentExecutionId) {
          this.emitter.emit('execution_interrupted', {
            executionId: this.currentExecutionId,
            timestamp: Date.now()
          });
        }
        
        // Emit queue update since execution state changed
        this.emitQueueUpdate();
        this.emitKernelUpdate(); // Emit update after interrupt
        
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
    
    // Save subscribers to restore after restart
    const subscribers = this.getSubscribers();
    
    // Clear execution queue
    const hadItems = this.executionQueue.length > 0;
    this.executionQueue = [];
    this.processing = false;
    this.currentExecutionId = null;
    this.activeExecutions = 0;
    
    // Clear tracking data
    this.executionOutputs.clear();
    this.executionStartTimes.clear();
    this.executionSessions.clear();
    this.executionCodes.clear();
    
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
      // Stop IOPub receiver
      if (this.stopIOPubReceiver) {
        this.stopIOPubReceiver();
      }
      
      // Properly close channels
      await this.closeChannels();
      
      // Kill the current process
      if (this.kernelProcess) {
        this.kernelProcess.kill();
        this.kernelProcess = null;
      }
      
      // Cleanup any temporary files
      this.cleanup();
      
      // Start a fresh kernel
      await this.start();
      
      // Restore subscribers
      this.subscribers = new Set(subscribers);
      this.emitKernelUpdate(); // Emit update after restart
      
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
    
    // Stop IOPub receiver cleanly if it exists
    if (this.stopIOPubReceiver) {
      this.stopIOPubReceiver();
    }
    
    // Properly close ZMQ channels
    this.closeChannels().catch(error => {
      debug(`Error while closing channels: ${error.message}`);
    });
    
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
    
    // Clear tracking data
    this.executionOutputs.clear();
    this.executionStartTimes.clear();
    this.executionSessions.clear();
    this.executionCodes.clear();
    
    // Clear subscribers
    this.subscribers.clear();
    
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
      pid: this.kernelProcess ? this.kernelProcess.pid : null,
      activeExecutions: this.activeExecutions,
      subscriberCount: this.subscribers.size,
      status: this.status
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
  
  getExecutionOutputs(executionId) {
    return this.executionOutputs.get(executionId) || [];
  }
}

module.exports = Kernel;