const Kernel = require('./Kernel');
const debug = require('debug')('jupyter:server');

class Server {
  constructor(options = {}) {
    this.sockets = new Map();
    this.kernels = new Map();
    this.executionLocks = new Map(); // Map to track execution locks per document
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
          const kernel = await server.startKernel({ docId, docPath, socketId });
          
          // Initial socket becomes a subscriber automatically
          kernel.addSubscriber(socketId);
          
          server.emitIndex();
        }
        
        else if (topic === 'view_document') {
          // Event for when a client starts viewing a document
          debug(`Socket ${socketId} is now viewing document ${docId}`);
          
          // Auto-subscribe to the kernel if it exists
          const kernel = this.kernels.get(docId);
          if (kernel) {
            kernel.addSubscriber(socketId);
            
            // Send current document state
            socket.emit('kernel', {
              topic: 'document_state',
              docId,
              kernel: kernel.toJSON()
            });
          }
        }
        
        else if (topic === 'close_document') {
          // Event for when a client stops viewing a document
          debug(`Socket ${socketId} is no longer viewing document ${docId}`);
          
          // Auto-unsubscribe from the kernel
          const kernel = this.kernels.get(docId);
          if (kernel) {
            kernel.removeSubscriber(socketId);
          }
        }
        
        else if (topic === 'run') {
          debug(`Running code in kernel ${docId} for element ${elementId}`, { codeLength: code?.length });
          
          // Make sure the socket is subscribed to the kernel before running code
          const kernel = this.kernels.get(docId);
          if (kernel && !kernel.hasSubscriber(socketId)) {
            kernel.addSubscriber(socketId);
          }
          
          if (this.options.verbose) {
            debug(`Code to execute: ${code.slice(0, 100)}${code.length > 100 ? '...' : ''}`);
          }
          
          // Use tryRunCode with timeout and retries
          await server.tryRunCode({ docId, code, elementId, socketId, retries: 3 });
        }
        
        else if (topic === 'execution') {
          debug(`Socket ${socketId} wants to subscribe to execution events for ${docId}`);
          const kernel = this.kernels.get(docId);
          if (kernel) {
            kernel.addSubscriber(socketId);
          }
        }
        
        else if (topic === 'kill') {
          debug(`Killing kernel ${docId}`);
          await server.killKernel(docId);
          server.emitIndex();
        }
        
        else if (topic === 'subscribe') {
          debug(`Socket ${socketId} explicitly subscribing to kernel ${docId}`);
          const kernel = this.kernels.get(docId);
          if (kernel) {
            kernel.addSubscriber(socketId);
          } else {
            throw new Error(`No kernel running for document ${docId}`);
          }
        }
        
        else if (topic === 'unsubscribe') {
          debug(`Socket ${socketId} explicitly unsubscribing from kernel ${docId}`);
          const kernel = this.kernels.get(docId);
          if (kernel) {
            kernel.removeSubscriber(socketId);
          }
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
      
      // Unsubscribe from all kernels
      for (const kernel of this.kernels.values()) {
        if (kernel.hasSubscriber(socketId)) {
          kernel.removeSubscriber(socketId);
          debug(`Removed socket ${socketId} from kernel ${kernel.docId} subscribers`);
          
          // If no subscribers left and autoShutdown is enabled, shut down the kernel
          if (this.options.autoShutdownUnusedKernels && kernel.getSubscriberCount() === 0) {
            debug(`No subscribers left for kernel ${kernel.docId} and autoShutdown enabled, shutting down`);
            this.killKernel(kernel.docId).catch(error => {
              debug(`Error shutting down unused kernel ${kernel.docId}: ${error.message}`);
            });
          }
        }
      }
      
      // Remove socket from sockets map
      this.sockets.delete(socketId);
    });
  }
  
  // Function to broadcast to all subscribers of a specific kernel
  broadcastToSubscribers(kernel, message) {
    if (!kernel) {
      debug(`Attempted to broadcast to non-existent kernel`);
      return;
    }
    
    const subscribers = kernel.getSubscribers();
    if (subscribers.length === 0) {
      debug(`No subscribers for kernel ${kernel.docId}, skipping broadcast`);
      return;
    }
    
    debug(`Broadcasting message to ${subscribers.length} subscribers of kernel ${kernel.docId}: ${message.topic}`);
    
    let deliveredCount = 0;
    for (const socketId of subscribers) {
      const socket = this.sockets.get(socketId);
      if (socket) {
        try {
          socket.emit('kernel', message);
          deliveredCount++;
        } catch (error) {
          debug(`Error sending message to socket ${socketId}: ${error.message}`);
        }
      } else {
        debug(`Socket ${socketId} not found while broadcasting - may need cleanup`);
        // Consider auto-cleanup of stale subscribers:
        // kernel.removeSubscriber(socketId);
      }
    }
    
    if (deliveredCount < subscribers.length) {
      debug(`Only delivered message to ${deliveredCount}/${subscribers.length} subscribers`);
    }
  }
  
  emitAll(message) {
    debug(`Broadcasting message to all sockets: ${message.topic}`);
    for (const socket of this.sockets.values()) {
      socket.emit('kernel', message);
    }
  }
  
  index() {
    let r = {};
    for (const [key, kernel] of this.kernels) {
      r[key] = kernel.toJSON();
    }
    return r;
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
      this.setupKernelMessageHandlers(kernel);
      
      // Initialize message history for this kernel if enabled
      if (this.options.saveMessageHistory) {
        this.messageHistory.set(docId, []);
      }
      
      // Initialize execution lock for this document
      this.executionLocks.set(docId, Promise.resolve());
      
      // Store kernel
      this.kernels.set(docId, kernel);
      
      debug(`Kernel for ${docId} initialized and stored`);
      return kernel;
    } catch (error) {
      console.error(`Failed to start kernel for document ${docId}:`, error);
      throw error;
    }
  }
  
  setupKernelMessageHandlers(kernel) {
    const docId = kernel.docId;
    debug(`Setting up message handlers for kernel ${docId}`);
    
    // Handle kernel update events
    kernel.emitter.on('kernel_update', (kernelState) => {
      debug(`Kernel update for ${docId}`);
      
      // Broadcast to all subscribers
      this.broadcastToSubscribers(kernel, {
        topic: 'kernel_update',
        docId,
        kernel: kernelState,
        timestamp: Date.now()
      });
    });
    
    // Handle all kernel messages
    kernel.emitter.on('message', (message) => {
      if (!this.kernels.has(docId)) {
        debug(`Message received for unknown kernel ${docId}`);
        return;
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
      
      // Send to all subscribers using the broadcast method
      const elementId = message.parentHeader.msg_id;
      this.broadcastToSubscribers(kernel, {
        topic: 'data',
        docId, 
        elementId,
        type: message.type,
        content: message.content,
      });
    });
    
    // Handle queue updates
    kernel.emitter.on('queue_update', (queueStatus) => {
      debug(`Queue update for kernel ${docId}: ${queueStatus.queueLength} items, processing: ${queueStatus.processing}`);
      
      // Notify subscribers about queue status changes using broadcast
      this.broadcastToSubscribers(kernel, {
        topic: 'queue_update',
        docId,
        queueStatus
      });
    });
    
    // Handle execution start events
    kernel.emitter.on('execution_start', ({ executionId, code, timestamp, sessionId }) => {
      debug(`Execution started in kernel ${docId}: ${executionId}`);
      
      // Broadcast execution_start event to all subscribers
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_start',
        docId,
        executionId,
        sessionId,
        timestamp: timestamp || Date.now(),
        codePreview: this.options.verbose ? 
          (code ? code.slice(0, 100) + (code.length > 100 ? '...' : '') : null) : null
      });
    });
    
    // Handle execution complete events
    kernel.emitter.on('execution_complete', ({ executionId, success, error, traceback, executionTime, outputs, sessionId }) => {
      debug(`Execution completed in kernel ${docId}: ${executionId}`, { success });
      
      // Broadcast execution_complete event to all subscribers
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_complete',
        docId,
        executionId,
        sessionId,
        success,
        timestamp: Date.now(),
        executionTime,
        outputs,
        error: error ? {
          message: error.message,
          stack: this.options.verbose ? error.stack : undefined,
          traceback
        } : null
      });
      
      if (error) {
        debug(`Execution error: ${error.message}`);
      }
    });
    
    // Handle execution timeouts
    kernel.emitter.on('execution_timeout', ({ executionId, timeout }) => {
      debug(`Execution timeout in kernel ${docId}: ${executionId} (${timeout}ms)`);
      
      // Broadcast execution timeout event
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_timeout',
        docId,
        executionId,
        timeout,
        message: `Execution may be stuck (timeout after ${timeout}ms)`
      });
      
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
      
      // Notify all subscribers using broadcast
      this.broadcastToSubscribers(kernel, {
        topic: 'error', 
        docId, 
        error: error.message,
        stack: this.options.verbose ? error.stack : undefined
      });
    });
  }
  
  // Method for handling code execution with retries
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
    const kernel = this.kernels.get(docId);
    if (!kernel) {
      debug(`Attempt to run code in non-existent kernel ${docId}`);
      throw new Error('No kernel running for this document');
    }

    debug(`Executing code in kernel ${docId} for element ${elementId}`);
    
    try {
      // Execute the code with proper error handling
      const executionId = await kernel.sendExecuteRequest({
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
    
    const kernel = this.kernels.get(docId);
    if (!kernel) return;
    
    debug(`Setting execution timeout monitor for ${executionId} in kernel ${docId} (${timeoutMs}ms)`);
    
    setTimeout(() => {
      // Check if execution might be stuck
      if (kernel.currentExecutionId === executionId && kernel.status === 'busy') {
        console.warn(`Execution ${executionId} in kernel ${docId} may be stuck (timeout after ${timeoutMs}ms)`);
        
        // Notify clients about the execution timeout using broadcast
        this.broadcastToSubscribers(kernel, {
          topic: 'execution_timeout',
          docId,
          executionId,
          message: `Execution may be stuck (timeout after ${timeoutMs}ms)`
        });
        
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
    const kernel = this.kernels.get(docId);
    if (!kernel)
      throw new Error('Kernel not found');
    
    // Use toJSON for consistent representation
    const status = kernel.toJSON();
    
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
    const kernel = this.kernels.get(docId);
    if (!kernel)
      throw new Error('Kernel not found');
    
    debug(`Interrupting kernel ${docId}`);
    const result = await kernel.interrupt();
    
    if (result) {
      debug(`Kernel ${docId} interrupt successful`);
      
      // Broadcast the interrupt success
      this.broadcastToSubscribers(kernel, {
        topic: 'kernel_interrupted',
        docId,
        timestamp: Date.now()
      });
    } else {
      debug(`Kernel ${docId} interrupt failed`);
      
      // Broadcast the interrupt failure
      this.broadcastToSubscribers(kernel, {
        topic: 'kernel_interrupt_failed',
        docId,
        timestamp: Date.now()
      });
    }
    
    return result;
  }
  
  async killKernel(docId) {
    const kernel = this.kernels.get(docId);
    if (!kernel) {
      debug(`Attempt to kill non-existent kernel ${docId}`);
      throw new Error('Kernel not found');
    }
    
    debug(`Destroying kernel ${docId}`);
    
    // Get subscribers to notify before destroying
    const subscribers = kernel.getSubscribers();
    
    // Destroy the kernel
    kernel.destroy();
    
    // Remove from kernels map
    this.kernels.delete(docId);
    
    // Clean up message history
    if (this.options.saveMessageHistory) {
      this.messageHistory.delete(docId);
    }
    
    // Remove execution lock
    this.executionLocks.delete(docId);
    
    // Notify all previous subscribers
    for (const socketId of subscribers) {
      const socket = this.sockets.get(socketId);
      if (socket) {
        socket.emit('kernel', {
          topic: 'kernel_terminated', 
          docId,
          timestamp: Date.now()
        });
      }
    }
    
    debug(`Kernel ${docId} destroyed successfully`);
    return true;
  }
  
  shutdownAllKernels() {
    debug(`Shutting down all kernels (count: ${this.kernels.size})`);
    for (const [docId, kernel] of this.kernels.entries()) {
      try {
        debug(`Shutting down kernel ${docId}`);
        kernel.destroy();
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
    
    for (const [docId, kernel] of this.kernels.entries()) {
      info.kernels[docId] = kernel.toJSON();
      
      if (this.options.saveMessageHistory) {
        const history = this.messageHistory.get(docId) || [];
        info.kernels[docId].messageCount = history.length;
      }
    }
    
    return info;
  }
}

module.exports = Server;