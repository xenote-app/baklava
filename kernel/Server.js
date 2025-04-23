const Kernel = require('./kernel');

class Server {
  constructor() {
    this.sockets = new Map();
    this.kernels = new Map();
    
    // Set up process exit handler for cleanup
    process.on('exit', () => {
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
    
    // Store socket reference
    this.sockets.set(socketId, socket);
    socket.emit('kernel', { topic: 'index', kernels: this.index() });
    
    // Set up socket event handlers
    socket.on('kernel', async (message) => {
      const { topic, docId, docPath, requestId, elementId, code } = message;
      try {
        if (topic === 'index') {
          socket.emit('kernel', { topic: 'index', kernels: this.index() });
        }

        else if (topic === 'start') {
          await server.startKernel({ docId, docPath, socketId });
          server.emitIndex();
        }
        
        else if (topic === 'run') {
          await server.runCode({ docId, code, elementId });
        }
        
        else if (topic === 'kill') {
          await server.killKernel(docId);
          server.emitIndex();
        }
        
        else if (topic === 'subscribe') {
          await server.subscribeToKernel({ docId, socketId });
        }
        
        else if (topic === 'unsubscribe') {
          await server.unsubscribeFromKernel({ docId, socketId });
        }

        socket.emit('kernel', { status: 'success', requestId, requestTopic: topic });
      }  catch (e) {
        console.error(e);
        socket.emit('kernel', { status: 'error', error: e.message, requestId, requestTopic: topic });
      }
    });
    
    socket.on('disconnect', () => {
      server.handleSocketDisconnect(socketId);
    });
  }
  
  emitAll(data) {
    for (const [socketId, socket] of this.sockets.entries()) {
      socket.emit('kernel', data);
    }
  }
  
  index() {
    return Array.from(this.kernels.values()).map(kd => ({
      docId: kd.kernel.docId,
      docPath: kd.kernel.docPath
    }));
  }
  
  emitIndex() {
    this.emitAll({ topic: 'index', kernels: this.index() });
  }
  
  async startKernel({ docId, docPath, socketId }) {
    // Check if kernel already exists
    if (this.kernels.has(docId)) {
      throw new Error('Kernel already running for the document.');
    }
    
    try {
      // Create and start new kernel
      const kernel = new Kernel(docId, docPath);
      await kernel.start();
      
      // Set up message handler
      this.setupKernelMessageHandlers(kernel, docId);
      
      // Store kernel
      this.kernels.set(docId, {
        kernel,
        subscribers: new Set([socketId]) // Initial subscriber is the creator
      });
      
      return kernel;
    } catch (error) {
      console.error(`Failed to start kernel for document ${docId}:`, error);
      throw error;
    }
  }
  
  setupKernelMessageHandlers(kernel, docId) {
    // Handle all kernel messages
    kernel.emitter.on('message', (message) => {
      const kernelData = this.kernels.get(docId);
      if (!kernelData) return;
      
      // Send to all subscribers
      for (const socketId of this.sockets.keys()) { // kernelData.subscribers) {
        const socket = this.sockets.get(socketId);
        if (!socket) continue;

        const elementId = message.parentHeader.msg_id;
        socket.emit('kernel', {
          topic: 'data',
          docId, elementId,
          type: message.type,
          content: message.content,
        });
      }
    });
    
    // Handle kernel errors
    kernel.emitter.on('error', (error) => {
      // console.error(`Kernel error for document ${docId}:`, error);
      
      const kernelData = this.kernels.get(docId);
      if (!kernelData) return;
      
      // Notify all subscribers
      for (const socketId of kernelData.subscribers) {
        const socket = this.sockets.get(socketId);
        if (socket) {
          socket.emit('kernel', {
            topic: 'error', docId, error: error.message
          });
        }
      }
    });
  }
  
  async runCode({ docId, elementId, code }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      throw new Error('No kernel running for this document');

    await kernelData.kernel.sendExecuteRequest({
      executionId: elementId,
      sessionId: docId,
      code
    });
  }
  
  async killKernel(docId) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      throw new Error('Kernel not found');
    
    // Destroy the kernel
    kernelData.kernel.destroy();
    
    // Remove from kernels map
    this.kernels.delete(docId);
    
    // Notify all subscribers
    for (const socketId of kernelData.subscribers) {
      const socket = this.sockets.get(socketId);
    }
    
    return true;
  }
  
  async subscribeToKernel({ docId, socketId }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      throw new Error('No kernel running for this document');
    
    // Add to subscribers
    kernelData.subscribers.add(socketId);
  }
  
  async unsubscribeFromKernel({ docId, socketId }) {
    const kernelData = this.kernels.get(docId);
    if (!kernelData)
      return false;
    // Remove from subscribers
    kernelData.subscribers.delete(socketId);
  }
  
  handleSocketDisconnect(socketId) {
    // Remove socket from collection
    this.sockets.delete(socketId);
    
    // Unsubscribe from all kernels
    for (const [docId, kernelData] of this.kernels.entries()) {
      kernelData.subscribers.delete(socketId);
      
      // If no subscribers left, consider shutting down the kernel
      // Uncomment this if you want kernels to shut down when no clients are connected
      /*
      if (kernelData.subscribers.size === 0) {
        this.killKernel(docId);
      }
      */
    }
  }
  
  shutdownAllKernels() {
    for (const [docId, kernelData] of this.kernels.entries()) {
      try {
        kernelData.kernel.destroy();
      } catch (e) {
        console.error(`Error shutting down kernel ${docId}:`, e);
      }
    }
    this.kernels.clear();
  }
}

module.exports = Server;