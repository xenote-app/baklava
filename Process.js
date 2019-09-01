const
  _ = require('lodash'),
  pidusage = require('pidusage'),
  Emitter = require('events').EventEmitter,
  spawn = require('child_process').spawn,
  path = require('path');

class Process {
  constructor(id, articleId, callerId) {
    this.id = id;
    this.articleId = articleId;
    this.callerId = callerId;

    this.emitter = new Emitter();
  }

  run(opts) {
    this.runOpts = opts;
    console.log('running', opts);

    var
      { command, env, args, cwd } = opts,
      childEnv = _.extend({}, process.env, env);
    
    if (childEnv['path+'])
      childEnv.PATH = `${childEnv['path+']}:${childEnv.PATH}`;
    
    cwd = cwd || path.join(process.cwd(), this.articleId);

    var child = this.child = spawn(command, args, {
      cwd: cwd,
      env: childEnv
    });

    child.stdout.on('data', (data) => {
      this.emit('stdout', data.toString());
    });

    child.stderr.on('data', (data) => {
      this.emit('stderr', data.toString());
    });

    child.on('message', message => {
      this.emit('message', message);
    });

    child.on('close', (code) => {
      this.status = 'exit';
      this.exitCode = code;
      this.emit('close', code);
    });

    this.status = 'running';
    this.pid = this.child.pid;
  }

  json() {
    return {
      'id': this.id,
      'articleId': this.articleId,
      'callerId': this.callerId,
      'pid': this.child.pid,
      'opts': this.runOpts,
      'status': this.status,
      'exitCode': this.exitCode
    }
  }

  getUsage(cb) {
    var pid = this.child && this.child.pid;
    if (!pid || this.status !== 'running')
      cb(null, { memory: 0, cpu: 0 });
    pidusage.stat(pid, cb);
  }

  emit(type, data) {
    this.emitter.emit(type, data);
  }
  
  on(type, cb) {
    this.emitter.on(type, cb);
  }

  stdoutPipe(stream) {
    this.child.stdout.pipe(stream);
  }

  stderrPipe(stream) {
    tis.child.stderr.pipe(stream);
  }

  stdinPipe(stream) {
    this.child.stdin.pipe(stream);
  }

  stop() {
    if (!this.status === 'running')
      this.child.kill();
  }

  destroy() {
    this.stop();
    this.emitter.removeAllListeners();
  }
}

module.exports = Process;