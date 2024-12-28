const
  fs = require('fs'),
  net = require('net'),
  Emitter = require('events').EventEmitter,
  BufferHandler = require('./BufferHandler.js');

// child -> socket -> bufferHandler -> broker's emitter -> vani -> * 

class VaniManager {
  constructor({ port, processManager, webSocketManager }) {
    this.port = port;
    this.emitter = new Emitter();
    this.processManager = processManager;
    this.webSocketManager = webSocketManager;

    const self = this;
    this.server = net.createServer(function(socket) { self.handleSocketConnection(socket); });

    webSocketManager.emitter.on('vani', function(data) { self.handleVaniMessage(data); });
  }

  listen(cb) {
    if (fs.existsSync(this.port))
      fs.unlinkSync(this.port);
    this.server.listen(this.port, cb);
  }

  handleVaniMessage(data) {
    // web -> sockets
    this.emitter.emit('for socket', data);
  }

  handleSocketMessage(data) {
    // socket -> socket
    this.emitter.emit('for socket', data);
    // socket -> web
    this.webSocketManager.emitVaniMessage(data);
  }

  // Individual connection
  handleSocketConnection(socket) {
    const
      broker = this,
      socketId = Math.random().toString().substring(2),
      incomingBufferHandler = new BufferHandler(function(data) {
        data.senderId = socketId;
        broker.handleSocketMessage(data);
      });

    function sendToSocket(data) {
      if (data.senderId === socketId) {
        // do nothing
      } else if (!socket.writable) {
        console.error('un-writable socket', socketId);
      } else {
        socket.write(JSON.stringify(data) + '\n');
      }
    }
    this.emitter.on('for socket', sendToSocket);

    socket.on('data', function(chunk) {
      incomingBufferHandler.pump(chunk);
    });

    socket.on('end', function() {
      // console.log('disconnected - with grace');
      broker.emitter.off('for socket', sendToSocket);
    });

    socket.on('error', function(err) {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        // console.log('disconnected - without grace');
        socket.end();
        socket.destroy();
        broker.emitter.off('for socket', sendToSocket);
      } else {
        console.error('Socket Error', err);
      }
    });
  }
}

module.exports = VaniManager;