const
  { getMachineInfo } = require('./helpers/machine'),
  Process = require('./Process'),
  Emitter = require('events').EventEmitter,
  config = require('./config'),
  _ = require('lodash');

class ProcessServer {
  constructor({ io }) {
    this.processes = {}
    this.emitter = new Emitter();
    this.io = io;
    this.io.on('connection', this.handleConnection.bind(this));
  }

  index() {
    return _.reduce(this.processes, function(r, p, k) { r[k] = p.json(); return r; }, {});
  }

  handleConnection(socket) {
    console.log('Connected: ', socket.id);
    const server = this;
    socket.emit('a machine', getMachineInfo());
    socket.emit('a process index', server.index());
    socket.on('q process index', function() { return socket.emit('a process index', server.index()); });
    socket.on('start process', function(opts) { return server.startProcess(opts); });
    socket.on('kill process', function(id) { return server.killProcess(id) });
    socket.on('disconnect', function() { console.log('Disconnected :', socket.id); });
    socket.on('vani', function(data) { server.emitter.emit('vani message', data); });
  }

  startProcess(opts) {
    const
      server = this,
      { command, elementId, docId, docPath, isCommon, appId  } = opts,
      p = new Process({ caller: { elementId, docId, isCommon, appId, docPath } });

    p.on('stdout', function(d) { server.handleProcessDataEvent(p, 'stdout', d); });
    p.on('stderr', function(d) { server.handleProcessDataEvent(p, 'stderr', d); });
    p.on('message', function(d) { server.handleProcessDataEvent(p, 'message', d); });
    
    p.on('error', function(err) {
      server.io.emit('event process', { process: p.json(), error: err.stack.toString(), event: 'error' })
    });

    p.on('close', function(d) {
      server.io.emit('event process', { process: p.json(), event: 'close' });
      setTimeout(function() { server.clearProcess(p.id) }, 10000);
    });

    // PYTHONPATH support
    const PYTHONPATH = process.env.PYTHONPATH ? `${process.cwd()}:${process.env.PYTHONPATH}` : process.cwd();

    p.run({
      command: command,
      env: { vaniPort: config.vaniPort, PYTHONPATH },
      subPath: docPath
    });
    server.processes[p.id] = p;
    server.io.emit('event process', { process: p.json(), event: 'start' });
  }

  killProcess(id) {
    this.processes[id].stop();
  }

  handleProcessDataEvent(p, type, data) {
    this.io.emit('data process', { id: p.id, type: type, data: data});
    if (type === 'message')
      this.emitter.emit('process message', { id: p.id, data: data });
  }

  clearProcess(id) {
    if (!this.processes[id])
      return;

    this.processes[id].destroy();
    delete this.processes[id];
    this.io.emit('remove process', id);
  }

  dispatchMessageToAllProcesses(message) {
    // for (let id in this.processes) {
    //   this.processes[id].send(message);
    // }
  }

  dispatchMessageToVaniSocket(message) {
    this.io.emit('vani', message);
  }
}

module.exports = ProcessServer;