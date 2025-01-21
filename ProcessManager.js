const
  Process = require('./Process'),
  Emitter = require('events').EventEmitter,
  config = require('./config'),
  _ = require('lodash');


class ProcessMan {
  constructor() {
    this.processes = {}
    this.emitter = new Emitter();
  }

  index() {
    return _.reduce(this.processes, function(r, p, k) { r[k] = p.json(); return r; }, {});
  }

  startProcess(opts) {
    const
      self = this,
      { command, elementId, docId, docPath, isCommon, appId, envVariables } = opts,
      p = new Process({ caller: { elementId, docId, isCommon, appId, docPath } });

    p.on('stdout', function(d) { self.handleProcessDataEvent(p, 'stdout', d); });
    p.on('stderr', function(d) { self.handleProcessDataEvent(p, 'stderr', d); });
    p.on('message', function(d) { self.handleProcessDataEvent(p, 'message', d); });
    
    p.on('error', function(err) {
      self.emitter.emit('event process', { process: p.json(), error: err.stack.toString(), event: 'error' })
    });

    p.on('close', function(d) {
      self.emitter.emit('event process', { process: p.json(), event: 'close' });
      setTimeout(function() { self.clearProcess(p.id) }, 10000);
    });

    // PYTHONPATH and NODE_PATH support
    const PYTHONPATH = process.env.PYTHONPATH ? `${process.cwd()}:${process.env.PYTHONPATH}` : process.cwd();
    const NODE_PATH = process.env.NODE_PATH ? `${process.cwd()}:${process.env.NODE_PATH}` : process.cwd();

    p.run({
      command: command,
      env: Object.assign(
        { vaniPort: config.vaniPort, PYTHONPATH, NODE_PATH },
        envVariables || {}
      ),
      subPath: docPath
    });
    self.processes[p.id] = p;
    self.emitter.emit('event process', { process: p.json(), event: 'start' });
  }

  killProcess(id) {
    this.processes[id].stop();
  }

  handleProcessDataEvent(p, type, data) {
    this.emitter.emit('data process', { id: p.id, type: type, data: data});
    // if (type === 'message')
    //   this.emitter.emit('process message', { id: p.id, data: data });
  }

  clearProcess(id) {
    if (!this.processes[id])
      return;
    
    this.processes[id].destroy();
    delete this.processes[id];
    this.emitter.emit('remove process', id);
  }

  dispatchMessageToAllProcesses(message) {
    // for (let id in this.processes) {
    //   this.processes[id].send(message);
    // }
  }

  handleStdinMessage(data) {
    const process = this.processes[data.processId];
    if (process) {
      process.sendStdin(data.message);
      this.handleProcessDataEvent(process, 'stdin', data.message);
    }
  }
}

module.exports = ProcessMan;