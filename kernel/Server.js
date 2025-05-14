const Kernel = require('./Kernel');
const debug = require('debug')('jupyter:server');

class Server {
  constructor(options = {}) {
    this.sockets = new Map();
    this.kernels = new Map();
    this.options = {
      retryDelay: options.retryDelay || 500, // Default retry delay for operations
      queueTimeout: options.queueTimeout || 60000, // Default timeout for queued executions
      ...options
    };
    
    // Set up process exit handler for cleanup
    process.on('exit', () => {
      this.shutdownAllKernels();
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
      let responseObj = { topic, docId, requestId };

      debug(`Received '${topic}' request from socket ${socketId}`, { docId, elementId, requestId });
      
      try {
        if (topic === 'index') {
          socket.emit('kernel', { topic: 'index', kernels: this.index() });
        }

        else if (topic === 'start') {
          const kernel = await server.startKernel({ docId, docPath, socketId });
          kernel.addSubscriber(socketId);
          server.emitIndex();
        }
        
        else if (topic === 'run') {
          const kernel = this.kernels.get(docId);
          if (kernel && !kernel.hasSubscriber(socketId)) {
            kernel.addSubscriber(socketId);
          }
          await server.runCode({ docId, code, elementId, socketId });
        }
        
        else if (topic === 'interrupt') {
          responseObj.interrupted = await server.interruptExecution(docId);
        }
        
        else if (topic === 'kill') {
          responseObj.killed = await server.killKernel(docId);
          server.emitIndex();
        }
        
        else if (topic === 'restart') {
          responseObj.restarted = await server.restartKernel(docId);
          server.emitIndex();
        }
        
        else if (topic === 'kernel_status') {
          responseObj.status = await server.getKernelStatus(docId)
        }

        socket.emit('kernel', { status: 'success', ...responseObj });
      } catch (e) {
        console.log(`Error processing '${topic}'`);
        console.error(e);
        socket.emit('kernel', { status: 'error', error: e.message, stack: e.stack,...responseObj });
      }
    });
    
    socket.on('disconnect', () => {
      debug(`Socket ${socketId} disconnected`);
      
      // Unsubscribe from all kernels
      for (const kernel of this.kernels.values()) {
        if (kernel.hasSubscriber(socketId)) {
          kernel.removeSubscriber(socketId);
        }
      }
      // Remove socket from sockets map
      this.sockets.delete(socketId);
    });
  }
  
  // Function to broadcast to all subscribers of a specific kernel
  broadcastToSubscribers(kernel, message) {
    if (!kernel) {
      return;
    }
    
    const subscribers = kernel.getSubscribers();
       
    for (const socketId of subscribers) {
      const socket = this.sockets.get(socketId);
      if (socket) {
        try {
          socket.emit('kernel', message);
        } catch (error) {
          debug(`Error sending message to socket ${socketId}: ${error.message}`);
        }
      }
    }
    
  }
  
  emitAll(message) {
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
    this.emitAll({ topic: 'index', kernels });
  }
  
  async startKernel({ docId, docPath, socketId }) {
    // Check if kernel already exists
    if (this.kernels.has(docId)) {
      throw new Error('Kernel already running for the document.');
    }
    
    const kernel = new Kernel(docId, docPath, this.options);
    
    await kernel.start();
    this.setupKernelMessageHandlers(kernel);
    // Store kernel
    this.kernels.set(docId, kernel);
    return kernel;
  }
  
  setupKernelMessageHandlers(kernel) {
    const docId = kernel.docId;
    
    kernel.emitter.on('kernel_update', () => {
      this.emitIndex()
    });

    kernel.emitter.on('message', (message) => {
      if (!this.kernels.has(docId)) {
        return;
      }

      const elementId = message.parentHeader.msg_id;
      this.broadcastToSubscribers(kernel, {
        topic: 'data',
        docId, 
        elementId,
        type: message.type,
        content: message.content,
      });
    });
    
    kernel.emitter.on('execution_start', ({ executionId, code, timestamp, sessionId }) => {
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_start',
        docId,
        executionId,
        sessionId,
        timestamp: timestamp || Date.now()
      });
    });
    
    kernel.emitter.on('execution_interrupted', ({ executionId, timestamp }) => {
      debug('Execution interrupted')
      
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_interrupted',
        docId,
        executionId,
        timestamp: timestamp || Date.now(),
        message: 'Execution interrupted by user'
      });
    });
    
    kernel.emitter.on('execution_complete', ({ executionId, success, error, traceback, executionTime, outputs, sessionId, interruptedByUser }) => {
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_complete',
        docId,
        executionId,
        sessionId,
        success,
        timestamp: Date.now(),
        executionTime,
        outputs,
        interruptedByUser,
        error: error ? { message: error.message, stack: error.stack, traceback } : null
      });
      
      if (error) {
        debug(`Execution error: ${error.message}`);
      }
    });
    
    kernel.emitter.on('execution_timeout', ({ executionId, timeout }) => {
      this.broadcastToSubscribers(kernel, {
        topic: 'execution_timeout',
        docId,
        executionId,
        timeout,
        message: `Execution may be stuck (timeout after ${timeout}ms)`
      });
    });
    
    kernel.emitter.on('error', (error) => {
      console.error(`Kernel error for document ${docId}:`, error);
      
      this.broadcastToSubscribers(kernel, {
        topic: 'error', 
        docId,
        error: error.message,
        stack: error.stack
      });
    });
  }

  getKernel = (docId) => {
    const kernel = this.kernels.get(docId);
    if (!kernel)
      throw new Error('Kernel not found for doucment ' + docId);
    return kernel
  }
  
  async runCode({ docId, elementId, code, socketId }) {
    const kernel = this.getKernel(docId);
    
    return await kernel.sendExecuteRequest({
      executionId: elementId,
      sessionId: docId,
      code
    });
  }

  async interruptExecution(docId) {
    const kernel = this.getKernel(docId);
    return await kernel.interrupt();
  }
  
  async restartKernel(docId) {
    const kernel = this.getKernel(docId);
    await kernel.restart();
    this.broadcastToSubscribers(kernel, {
      topic: 'kernel_restarted',
      docId,
      timestamp: Date.now()
    });
    return true;
  } 
  
  async getKernelStatus(docId) {
    const kernel = this.getKernel(docId);
    const status = kernel.toJSON();
    return status;
  }
  
  async killKernel(docId) {
    const kernel = this.kernels.get(docId);
    kernel.destroy();
    this.kernels.delete(docId);
    return true;
  }
  
  shutdownAllKernels() {
    debug(`Shutting down all kernels (count: ${this.kernels.size})`);
    for (const [docId, kernel] of this.kernels.entries()) {
      try {
        kernel.destroy();
      } catch (e) {
        console.error(`Error shutting down kernel ${docId}:`, e);
      }
    }
    this.kernels.clear();
  }
}

module.exports = Server;