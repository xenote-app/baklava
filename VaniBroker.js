const
  fs = require('fs'),
  net = require('net'),
  Emitter = require('events').EventEmitter,
  BufferHandler = require('./BufferHandler.js');

const dispatch = (socket, obj) => socket.write(JSON.stringify(obj) + '\n');

class VaniBroker {
  constructor({ port, processServer }) {
    this.port = port;
    this.emitter = new Emitter();
    this.processServer = processServer;
    this.server = net.createServer(socket => this.handleSocketConnection(socket));
    processServer.emitter.on('vani message', data => this.handleVaniMessage(data));
  }

  listen = (cb) => {
    if (fs.existsSync(this.port))
      fs.unlinkSync(this.port);
    this.server.listen(this.port, cb);
  }

  handleVaniMessage = (data) => {
    this.emitter.emit('for socket', data);
  }

  handleSocketMessage = (data) => {
    this.emitter.emit('for socket', data);
    this.processServer.dispatchMessageToVaniSocket(data);
  }

  handleSocketConnection = (socket) => {
    const
      bufferHandler = new BufferHandler(data => this.handleSocketMessage(data)),
      send = data => socket.write(JSON.stringify(data) + '\n');
    this.emitter.on('for socket', send);
    socket.on('data', chunk => bufferHandler.pump(chunk));
    socket.on('end', () => this.emitter.off('for socket', send));
  }
}

module.exports = VaniBroker;