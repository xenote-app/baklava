const
  fs = require('fs'),
  net = require('net'),
  Emitter = require('events').EventEmitter,
  BufferHandler = require('./BufferHandler.js');

// child -> socket -> bufferHandler -> broker's emitter -> vani -> * 

class VaniBroker {
  constructor({ port, processServer }) {
    this.port = port;
    this.emitter = new Emitter();
    this.processServer = processServer;
    const broker = this;
    this.server = net.createServer(function(socket) { broker.handleSocketConnection(socket); });
    processServer.emitter.on('vani message', function(data) { broker.handleVaniMessage(data); });
  }

  listen(cb) {
    if (fs.existsSync(this.port))
      fs.unlinkSync(this.port);
    this.server.listen(this.port, cb);
  }

  handleVaniMessage(data) {
    this.emitter.emit('for socket', data);
  }

  handleSocketMessage(data) {
    this.emitter.emit('for socket', data);
    this.processServer.dispatchMessageToVaniSocket(data);
  }

  // Individual connection
  handleSocketConnection(socket) {
    const
      broker = this,
      bufferHandler = new BufferHandler(function(data) { broker.handleSocketMessage(data) });

    function send(data) {
      if (socket.writable) {
        socket.write(JSON.stringify(data) + '\n');
      } else {
        console.error('Unwritable socket found.')
      }
    }
    this.emitter.on('for socket', send);

    socket.on('data', function(chunk) { bufferHandler.pump(chunk); });
    socket.on('end', function() {
      // console.log('disconnected - with grace');
      broker.emitter.off('for socket', send);
    });
    socket.on('error', function(err) {
      if (err.code === 'ECONNRESET') {
        // console.log('disconnected - without grace');
        socket.end();
        socket.destroy();
        broker.emitter.off('for socket', send);
      } else {
        console.error('Socket Error', error);
      }
    });
  }
}

module.exports = VaniBroker;