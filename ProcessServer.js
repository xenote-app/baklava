const
  { getMachineInfo } = require('./helpers/machine'),
  Process = require('./Process'),
  _ = require('lodash');

class ProcessServer {
  constructor() {
    this.processes = {}
  }  

  listen(io) {
    this.io = io;
    this.io.on('connection', this.handleConnection);
  }

  index = () => {
    return _.reduce(this.processes, (r, p, k) => { r[k] = p.json(); return r; }, {});
  }

  handleConnection = (socket) => {
    console.log('connected', socket.id);
    socket.emit('a machine', { machine: getMachineInfo() });

    socket.on('disconnect', _ => {
      console.log('disconnected', socket.id);
    });
    
    socket.on('q process index', _ => {
      socket.emit('a process index', { index: this.index() });
    });

    socket.on('start process', opts => {
      this.startProcess(opts);
    });
  }

  startProcess = (opts) => {
    var { id, articleId, callerId } = opts;
    var p = this.processes[id];

    if (p) {
      console.log('process with id exists.', p.id);
      p.destroy();
    }
    
    p = new Process(id, articleId, callerId);
    this.processes[id] = p;

    p.on('stdout', d => this.handleProcessEvent(p, 'stdout', d));
    p.on('stderr', d => this.handleProcessEvent(p, 'stderr', d));
    p.on('message', d => this.handleProcessEvent(p, 'message', d));
    p.on('close', d => this.handleProcessEvent(p, 'close', d));
    p.run(opts);

    this.io.emit('a process index', { index: this.index() });
  }

  stopProcess(id) {
    this.processes[id].stop();
  }

  handleProcessEvent = (p, type, data) => {
    this.io.emit('d process', { id: p.id, type: type, data: data});
    
    if (type === 'close')
      this.io.emit('u process', p.json());
  }
}

module.exports = ProcessServer;