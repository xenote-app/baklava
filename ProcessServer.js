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
    this.io.on('connection', this.handleConnection);
  }

  index = () => {
    return _.reduce(this.processes, (r, p, k) => { r[k] = p.json(); return r; }, {});
  }

  handleConnection = (socket) => {
    console.log('connected', socket.id);
    socket.emit('a machine', getMachineInfo());
    socket.emit('a process index', this.index());
    socket.on('q process index', _ => socket.emit('a process index', this.index()));
    socket.on('start process', opts => this.startProcess(opts));
    socket.on('kill process', id => this.killProcess(id));
    socket.on('disconnect', _ => console.log('disconnected', socket.id));
    socket.on('vani-message', data => this.emitter.emit('vani-message', data));
  }

  startProcess = (opts) => {
    const
      { command, elementId, articleId, articlePath, isCommon, appId  } = opts,
      p = new Process({ caller: { elementId, articleId, isCommon, appId } });

    p.on('stdout', d => this.handleProcessDataEvent(p, 'stdout', d));
    p.on('stderr', d => this.handleProcessDataEvent(p, 'stderr', d));
    p.on('message', d => this.handleProcessDataEvent(p, 'message', d));
    
    p.on('error', err => {
      this.io.emit('event process', { process: p.json(), error: err.stack.toString(), event: 'error' })
    });

    p.on('close', d => {
      this.io.emit('event process', { process: p.json(), event: 'end' });
      setTimeout(_ => this.clearProcess(p.id), 10000);
    });

    p.run({
      command: command,
      env: { vaniPort: config.vaniPort },
      subPath: articlePath.join('/')
    });
    this.processes[p.id] = p;
    this.io.emit('event process', { process: p.json(), event: 'start' });
  }

  killProcess(id) {
    this.processes[id].stop();
  }

  handleProcessDataEvent(p, type, data) {
    this.io.emit('data process', { id: p.id, type: type, data: data});
  }

  clearProcess(id) {
    if (!this.processes[id])
      return;

    this.processes[id].destroy();
    delete this.processes[id];
    this.io.emit('remove process', id);
  }

  emit(topic, data) {
    this.io.emit(topic, data);
  }
}

module.exports = ProcessServer;