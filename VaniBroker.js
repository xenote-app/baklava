const
  fs = require('fs'),
  net = require('net'),
  Emitter = require('events').EventEmitter,
  BufferHandler = require('./BufferHandler.js');

function dispatch(socket, obj) { socket.write(JSON.stringify(obj) + '\n') };

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

  handleSocketConnection(socket) {
    const
      broker = this,
      bufferHandler = new BufferHandler(function(data) { broker.handleSocketMessage(data) });
    
    function send(data){ socket.write(JSON.stringify(data) + '\n'); };
    this.emitter.on('for socket', send);
    socket.on('data', function(chunk) { bufferHandler.pump(chunk); });
    socket.on('end', function() { broker.emitter.off('for socket', send); });
  }
}

module.exports = VaniBroker;