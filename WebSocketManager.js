const
  { getMachineInfo } = require('./helpers/machine'),
  Emitter = require('events').EventEmitter;

class WebSocketManager {
  constructor({ io, processManager }) {
    this.io = io;
    this.processManager = processManager;
    this.emitter = new Emitter();
    this.io.on('connection', this.handleConnection.bind(this));

    processManager.emitter.on('event process', function(data) { io.emit('event process', data); } )
    processManager.emitter.on('data process', function(data) { io.emit('data process', data); } )
    processManager.emitter.on('remove process', function(data) { io.emit('remove process', data); } )
  }

  handleConnection(socket) {
    console.log('Connected: ', socket.id);
    const
      self = this,
      processManager = this.processManager;

    // Send on new connection.
    socket.emit('a machine', getMachineInfo());
    socket.emit('a process index', processManager.index());

    // listeners 
    socket.on('q process index', function() { return socket.emit('a process index', processManager.index()); });
    socket.on('start process', function(opts) { return processManager.startProcess(opts); });
    socket.on('kill process', function(id) { return processManager.killProcess(id) });
    socket.on('disconnect', function() { console.log('Disconnected :', socket.id); });
    socket.on('m stdin', function(data) { processManager.handleStdinMessage(data); });

    socket.on('vani', function(data) { self.emitter.emit('vani', data); });
  }

  emitVaniMessage(message) {
    this.io.emit('vani', message);
  }
}

module.exports = WebSocketManager;