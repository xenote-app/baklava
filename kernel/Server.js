const Kernel = require('./kernel');
const debug = require('debug')('jupyter:server');

class Server {
  constructor(options = {}) {
    this.sockets = new Map();
    this.kernels = new Map();
    this.executionLocks = new Map(); // New map to track execution locks per document
    this.options = {
      verbose: options.verbose || false,
      logMessageTypes: options.logMessageTypes || ['status', 'error'],
      logAllMessages: options.logAllMessages || false,
      saveMessageHistory: options.saveMessageHistory || false,
      maxMessageHistory: options.maxMessageHistory || 100,
      retryDelay: options.retryDelay || 500, // Default retry delay for operations
      queueTimeout: options.queueTimeout || 60000, // Default timeout for queued executions
      ...options
    };
    
    // Initialize message history if enabled
    if (this.options.saveMessageHistory) {
      this.messageHistory = new Map();
    }
    
    debug('Server initialized with options:', this.options);
    
    // Set up process exit handler for cleanup
    process.on('exit', () => {
      debug('Process exit detected, shutting down all kernels');
      this.shutdownAllKernels();
    });
    
    // Handle SIGINT and SIGTERM gracefully
    process.on('SIGINT', () => {
      console.log('Received SIGINT, shutting down kernels...');
      this.shutdownAllKernels();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down kernels...');
      this.shutdownAllKernels();
      process.exit(0);
    });
  }
  
  handleSocket(socket) {
    const server = this;
    const socketId = socket.id;
    
    debug(`New socket connection: ${socketId}`);
    
    // Store socket reference
    this.sockets.set(socketId, socket);
    socket.emit('kernel', { topic: 'index', kernels: this.index() });
    
    // Set up socket event handlers with improved error handling
    socket.on('kernel', async (message) => {
      const { topic, docId, docPath, requestId, elementId, code } = message;
      debug(`Received '${topic}' request from socket ${socketId}`, { docId, elementId, requestId });
      
      try {
        if (topic === 'index') {
          socket.emit('kernel', { topic: 'index', kernels: this.index() });
        }

        else if (topic === 'start') {
          debug(`Starting kernel for document ${docId} at path ${docPath}`);
          await server.startKernel({ docId, docPath, socketId });
          server.emitIndex();
        }
        
        else if (topic === 'run') {
          debug(`Running code in kernel ${docId} for element ${elementId}`, { codeLength: code?.length });
          if (this.options.verbose) {
            debug(`Code to execute: ${code.slice(0, 100)}${code.length > 100 ? '...' : ''}`);
          }
          
          // Use tryRunCode with timeout and retries instead of direct runCode
          await server.tryRunCode({ docId, code, elementId, socketId, retries: 3 });
        }
        
        else if (topic === 'kill') {
          debug(`Killing kernel ${docId}`);
          await server.killKernel(docId);
          server.emitIndex();
        }
        
        else if (topic === 'subscribe') {
          debug(`Socket ${socketId} subscribing to kernel ${docId}`);
          await server.subscribeToKernel({ docId, socketId });
        }
        
        else if (topic === 'unsubscribe') {
          debug(`Socket ${socketId} unsubscribing from kernel ${docId}`);
          await server.unsubscribeFromKernel({ docId, socketId });
        }
        
        else if (topic === 'kernel_status') {
          const status = await server.getKernelStatus(docId);
          socket.emit('kernel', { topic: 'kernel_status', docId, status, requestId });
          return; // Skip the generic success message below
        }
        
        else if (topic === 'interrupt') {
          debug(`Interrupting kernel ${docId}`);
          await server.interruptKernel(docId);
        }
        
        debug(`Successfully processed '${topic}' request`);
        socket.emit('kernel', { status: 'success', requestId, requestTopic: topic });
      } catch (e) {
        console.error(`Error processing '${topic}' request:`, e);
        socket.emit('kernel', { 
          status: 'error', 
          error: e.message, 
          stack: this.options.verbose ? e.stack : undefined,
          requestId, 
          requestTopic: topic 
        });
      }
    });
    
    socket.on('disconnect', () => {
      debug(`Socket ${socketId} disconnected`);
      server.handleSocketDisconnect(socketId);
    });
  }
  
  emitAll(message) {
    debug(`Broadcasting message to all sockets: ${message.topic}`);
    for (const [socketId, socket] of this.sockets.entries()) {
      socket.emit('kernel', message);
    }
  }
  
  index() {
    return Array.from(this.kernels.values()).map(kd => ({
      docId: kd.kernel.docId,
      docPath: kd.kernel.docPath,
      status: kd.status || 'unknown',
      activeExecutions: kd.activeExecutions || 0,
      queuedExecutions: this.getQueueLength(kd.kernel)
    }));
  }
  
  getQueueLength(kernel) {
    // Try to get queue length from kernel if the property exists
    return kernel.executionQueue?.length || 0;
  }
  
  emitIndex() {
    const kernels = this.index();
    debug(`Emitting updated kernel index: ${kernels.length} kernels`);
    this.emitAll({ topic: 'index', kernels });
  }
  
  async startKernel({ docId, docPath, socketId }) {
    // Check if kernel already exists
    if (this.kernels.has(docId)) {
      debug(`Kernel for ${docId} already exists`);
      throw new Error('Kernel already running for the document.');
    }
    
    try {
      debug(`Creating new kernel for document ${docId}`);
      // Create and start new kernel with enhanced options
      const kernel = new Kernel(docId, docPath, {
        ...this.options,
        // Add additional options that might help with EBUSY errors
        executeTimeout: this.options.executeTimeout || 30000,
      });
      
      debug(`Starting kernel...`);
      await kernel.start();
      debug(`Kernel started successfully`);
      
      // Set up message handler
      this.setupKernelMessageHandlers(kernel, docId);
      
      // Initialize message history for this kernel if enabled
      if (this.options.saveMessageHistory) {
        this.messageHistory.set(docId, []);
      }
      
      // Initialize execution lock for this document
      this.executionLocks.set(docId, Promise.resolve());
      
      // Store kernel
      this.kernels.set(docId, {
        kernel,
        subscribers: new Set([socketId]), // Initial subscriber is the creator
        status: 'idle',
        activeExecutions: 0,
        lastActivity: Date.now()
      });
      
      debug(`Kernel for ${docId} initialized and stored`);
      return kernel;
    } catch (error) {
      console.error(`Failed to start kernel for document ${docId}:`, error);
      throw error;
    }
  }
  
  setupKernelMessageHandlers(kernel, docId) {
    debug(`Setting up message handlers for kernel ${docId}`);
    
    // Handle all kernel messages
    kernel.emitter.on('message', (message) => {
      const kernelData = this.kernels.get(docId);
      if (!kernelData) {
        debug(`Message received for unknown kernel ${docId}`);
        return;
      }
      
      // Update kernel status based on message type
      if (message.type === 'status') {
        const prevStatus = kernelData.status;
        kernelData.status = message.content.execution_state;
        kernelData.lastActivity = Date.now();
        
        if (prevStatus !== kernelData.status) {
          debug(`Kernel ${docId} status changed: ${prevStatus} -> ${kernelData.status}`);
        }
        
        // If this is a status:idle message, decrement active executions counter
        if (message.content.execution_state === 'idle' && kernelData.activeExecutions > 0) {
          kernelData.activeExecutions--;
          debug(`Execution completed in kernel ${docId}, active: ${kernelData.activeExecutions}`);
        } else if (message.content.execution_state === 'busy') {
          // The busy state often indicates the start of an execution
          debug(`Kernel ${docId} is busy`);
        }
      }
      
      // Log selected message types or all messages if configured
      if (this.options.logAllMessages || 
          (this.options.logMessageTypes && this.options.logMessageTypes.includes(message.type))) {
        debug(`Kernel ${docId} message: ${message.type}`, 
              this.options.verbose ? message.content : undefined);
      }
      
      // Store message in history if enabled
      if (this.options.saveMessageHistory) {
        const history = this.messageHistory.get(docId) || [];
        history.push({
          timestamp: Date.now(),
          ...message
        });
        
        // Trim history if needed
        if (history.length > this.options.maxMessageHistory) {
          history.splice(0, history.length - this.options.maxMessageHistory);
        }
        
        this.messageHistory.set(docId, history);
      }
      
      // Send to all subscribers
      const elementId = message.parentHeader.msg_id;
      
      for (const socketId of kernelData.subscribers) {
        const socket = this.sockets.get(socketId);
        if (!socket) {
          debug(`Socket ${socketId} not found`);
          continue;
        }

        socket.emit('kernel', {
          topic: 'data',
          docId, 
          elementId,
          type: message.type,
          content: message.content,
        });
      }
    });
    
    // Handle queue updates
    kernel.emitter.on('queue_update', (queueStatus) => {
      debug(`Queue update for kernel ${docId}: ${queueStatus.queueLength} items, processing: ${queueStatus.processing}`);
      
      // Notify subscribers about queue status changes
      const kernelData = this.kernels.get(docId);
      if (!kernelData) return;
      
      for (const socketId of kernelData.subscribers) {
        const socket = this.sockets.get(socketId);
        if (socket) {
          socket.emit('kernel', {
            topic: 'queue_update',
            docId,
            queueStatus
          });
        }
      }
    });
    
    // Handle shell replies
    kernel.emitter.on('shell_reply', (message) => {
      debug(`Received shell reply for kernel ${docId}`, message);
    });
    
    // Handle specific execution events
    kernel.emitter.on('execution_start', ({ executionId }) => {
      debug(`Execution started in kernel ${docId}: ${executionId}`);
      const kernelData = this.kernels.get(docId);
      if (kernelData) {
        kernelData.activeExecutions++;
        kernelData.lastActivity = Date.now();
      }
    });
    
    kernel.emitter.on('execution_complete', ({ executionId, success, error }) => {
      debug(`Execution completed in kernel ${docId}: ${executionId}`, { success });
      if (error) {
        debug(`Execution error: ${error.message}`);
      }
    });
    
    // Handle execution timeouts
    kernel.emitter.on('execution_timeout', ({ executionId, timeout }) => {
      debug(`Execution timeout in kernel ${docId}: ${executionId} (${timeout}ms)`);
      
      // Optionally auto-interrupt the kernel on timeout
      if (this.options.autoInterruptOnTimeout) {
        debug(`Auto-interrupting kernel ${docId} due to execution timeout`);
        this.interruptKernel(docId).catch(error => {
          debug(`Error auto-interrupting kernel: ${error.message}`);
        });
      }
    });
    
    // Handle kernel errors
    kernel.emitter.on('error', (error) => {
      console.error(`Kernel error for document ${docId}:`, error);
      
      const kernelData = this.kernels.get(docId);
      if (!kernelData) return;
      
      // Update status
      kernelData.status = 'error';
      kernelData.lastError = {
        timestamp: Date.now(),
        message: error.message,
        stack: error.stack
      };
      
      // Notify all subscribers
      for (const socketId of kernelData.subscribers) {
        const socket = this.sockets.get(socketId);
        if (socket) {
          socket.emit('kernel', {
            topic: 'error', 
            docId, 
            error: error.message,
            stack: this.options.verbose ? error.stack : undefined
          });
        }
      }
    });
  }
  
  // New method for handling code execution with retries
  async tryRunCode({ docId, elementId, code, socketId, retries = 3 }) {
    let lastError = null;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Use execution lock to ensure serialized access
        const executionLock = this.executionLocks.get(docId) || Promise.resolve();
        
        // Chain a new promise that will handle this execution
        const newLock = executionLock.then(async () => {
          debug(`Acquired execution lock for ${docId} (attempt ${attempt + 1}/${retries})`);
          try {
            // Now actually run the code
            return await this.runCode({ docId, elementId, code, socketId });
          } catch (error) {
            // Specific handling for EBUSY errors
            if (error.code === 'EBUSY') {
              debug(`EBUSY error on attempt ${attempt + 1}, will retry after delay`);
              throw error; // Rethrow to trigger retry
            }
            throw error; // Rethrow other errors
          } finally {
            debug(`Released execution lock for ${docId}`);
          }
        });
        
        // Update the execution lock
        this.executionLocks.set(docId, newLock);
        
        // Wait for execution to complete
        const result = await newLock;
        return result; // Success, return result
      } catch (error) {
        lastError = error;
        
        // If this is the last attempt or not a retriable error, abort
        if (attempt === retries - 1 || (error.code !== 'EBUSY' && error.code !== 'EAGAIN')) {
          debug(`Final error on attempt ${attempt + 1}/${retries}: ${error.message}`);
          throw error; // Re-throw last error
        }
        
        // Add exponential backoff delay before retry
        const delay = this.options.retryDelay * Math.pow(2, attempt);
        debug(`Retrying operation after ${delay}ms delay (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // This should not be reached due to the throw in the loop, but just in case:
    throw lastError || new Error('Failed to run code after multiple attempts');
  }
  
  async runCode({ docId, elementId, code, socketId }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData) {
      debug(`Attempt to run code in non-existent kernel ${docId}`);
      throw new Error('No kernel running for this document');
    }

    debug(`Executing code in kernel ${docId} for element ${elementId}`);
    
    try {
      // Update state
      kernelData.lastActivity = Date.now();
      
      // Execute the code with proper error handling
      const executionId = await kernelData.kernel.sendExecuteRequest({
        executionId: elementId,
        sessionId: docId,
        code
      });
      
      debug(`Code execution request sent successfully: ${executionId}`);
      
      // Set up a timeout monitor for this execution
      this.monitorExecution(docId, executionId, this.options.queueTimeout);
      
      return executionId;
    } catch (error) {
      console.error(`Error executing code in kernel ${docId}:`, error);
      
      // Special handling for specific errors
      if (error.code === 'EBUSY') {
        debug(`EBUSY error when executing code in kernel ${docId}`);
      }
      
      throw error;
    }
  }
  
  monitorExecution(docId, executionId, timeoutMs = 30000) {
    // Skip if we don't have timeout monitoring enabled
    if (!this.options.monitorExecutions) return;
    
    const kernelData = this.kernels.get(docId);
    if (!kernelData) return;
    
    debug(`Setting execution timeout monitor for ${executionId} in kernel ${docId} (${timeoutMs}ms)`);
    
    setTimeout(() => {
      const kernel = kernelData.kernel;
      // Check if execution might be stuck
      if (kernel.currentExecutionId === executionId && kernelData.status === 'busy') {
        console.warn(`Execution ${executionId} in kernel ${docId} may be stuck (timeout after ${timeoutMs}ms)`);
        
        // Notify clients about the execution timeout
        for (const socketId of kernelData.subscribers) {
          const socket = this.sockets.get(socketId);
          if (socket) {
            socket.emit('kernel', {
              topic: 'execution_timeout',
              docId,
              executionId,
              message: `Execution may be stuck (timeout after ${timeoutMs}ms)`
            });
          }
        }
        
        // Optionally auto-interrupt the kernel
        if (this.options.autoInterruptOnTimeout) {
          debug(`Auto-interrupting kernel ${docId} due to execution monitor timeout`);
          this.interruptKernel(docId).catch(error => {
            debug(`Error auto-interrupting kernel: ${error.message}`);
          });
        }
      }
    }, timeoutMs);
  }
  
  async getKernelStatus(docId) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      throw new Error('Kernel not found');
    
    const kernel = kernelData.kernel;
    
    // Gather detailed status information
    const status = {
      status: kernelData.status || 'unknown',
      activeExecutions: kernelData.activeExecutions || 0,
      queuedExecutions: this.getQueueLength(kernel),
      lastActivity: kernelData.lastActivity,
      lastError: kernelData.lastError,
      currentExecutionId: kernel.currentExecutionId,
      subscriberCount: kernelData.subscribers.size
    };
    
    // Add execution history if available
    if (this.options.saveMessageHistory) {
      const history = this.messageHistory.get(docId) || [];
      status.messageCount = history.length;
      
      // Include recent status messages
      status.recentStatusMessages = history
        .filter(msg => msg.type === 'status')
        .slice(-5)
        .map(msg => ({
          timestamp: msg.timestamp,
          state: msg.content.execution_state
        }));
    }
    
    debug(`Status for kernel ${docId}:`, status);
    return status;
  }
  
  async interruptKernel(docId) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      throw new Error('Kernel not found');
    
    debug(`Interrupting kernel ${docId}`);
    const result = await kernelData.kernel.interrupt();
    
    if (result) {
      debug(`Kernel ${docId} interrupt successful`);
      // Reset execution counters
      kernelData.activeExecutions = 0;
      kernelData.status = 'idle'; // Will be updated by next status message
    } else {
      debug(`Kernel ${docId} interrupt failed`);
    }
    
    return result;
  }
  
  async killKernel(docId) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData) {
      debug(`Attempt to kill non-existent kernel ${docId}`);
      throw new Error('Kernel not found');
    }
    
    debug(`Destroying kernel ${docId}`);
    // Destroy the kernel
    kernelData.kernel.destroy();
    
    // Remove from kernels map
    this.kernels.delete(docId);
    
    // Clean up message history
    if (this.options.saveMessageHistory) {
      this.messageHistory.delete(docId);
    }
    
    // Remove execution lock
    this.executionLocks.delete(docId);
    
    // Notify all subscribers
    for (const socketId of kernelData.subscribers) {
      const socket = this.sockets.get(socketId);
      if (socket) {
        socket.emit('kernel', {
          topic: 'kernel_terminated', docId
        });
      }
    }
    
    debug(`Kernel ${docId} destroyed successfully`);
    return true;
  }
  
  async subscribeToKernel({ docId, socketId }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData) {
      debug(`Attempt to subscribe to non-existent kernel ${docId}`);
      throw new Error('No kernel running for this document');
    }
    
    // Add to subscribers
    kernelData.subscribers.add(socketId);
    debug(`Socket ${socketId} subscribed to kernel ${docId}`);
  }
  
  async unsubscribeFromKernel({ docId, socketId }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData) {
      debug(`Attempt to unsubscribe from non-existent kernel ${docId}`);
      return false;
    }
    
    // Remove from subscribers
    kernelData.subscribers.delete(socketId);
    debug(`Socket ${socketId} unsubscribed from kernel ${docId}`);
  }
  
  handleSocketDisconnect(socketId) {
    debug(`Handling disconnect for socket ${socketId}`);
    
    // Remove socket from collection
    this.sockets.delete(socketId);
    
    // Unsubscribe from all kernels
    for (const [docId, kernelData] of this.kernels.entries()) {
      if (kernelData.subscribers.has(socketId)) {
        kernelData.subscribers.delete(socketId);
        debug(`Removed socket ${socketId} from kernel ${docId} subscribers`);
      }
      
      // If no subscribers left and autoShutdown is enabled, shut down the kernel
      if (this.options.autoShutdownUnusedKernels && kernelData.subscribers.size === 0) {
        debug(`No subscribers left for kernel ${docId} and autoShutdown enabled, shutting down`);
        this.killKernel(docId).catch(error => {
          debug(`Error shutting down unused kernel ${docId}: ${error.message}`);
        });
      }
    }
  }
  
  shutdownAllKernels() {
    debug(`Shutting down all kernels (count: ${this.kernels.size})`);
    for (const [docId, kernelData] of this.kernels.entries()) {
      try {
        debug(`Shutting down kernel ${docId}`);
        kernelData.kernel.destroy();
      } catch (e) {
        console.error(`Error shutting down kernel ${docId}:`, e);
      }
    }
    this.kernels.clear();
    this.executionLocks.clear();
    debug('All kernels shut down');
  }
  
  // Diagnostic/debugging methods
  getDiagnosticInfo() {
    const info = {
      socketCount: this.sockets.size,
      kernelCount: this.kernels.size,
      kernels: {}
    };
    
    for (const [docId, kernelData] of this.kernels.entries()) {
      info.kernels[docId] = {
        status: kernelData.status,
        subscribers: kernelData.subscribers.size,
        activeExecutions: kernelData.activeExecutions,
        queuedExecutions: this.getQueueLength(kernelData.kernel),
        lastActivity: kernelData.lastActivity ? new Date(kernelData.lastActivity).toISOString() : null,
        currentExecutionId: kernelData.kernel.currentExecutionId,
        hasExecutionLock: this.executionLocks.has(docId)
      };
      
      if (this.options.saveMessageHistory) {
        const history = this.messageHistory.get(docId) || [];
        info.kernels[docId].messageCount = history.length;
      }
    }
    
    return info;
  }
}

module.exports = Server;