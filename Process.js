const
  _ = require('lodash'),
  pidusage = require('pidusage'),
  Emitter = require('events').EventEmitter,
  exec = require('child_process').exec,
  path = require('path'),
  kill = require('tree-kill'),
  TC = require('./misc').TERMINAL_COLORS;

class Process {
  constructor({ caller }) {
    this.id = (new Date).getTime().toString();
    this.caller = caller;
    this.emitter = new Emitter();
  }

  run(opts) {
    this.runOpts = opts;

    const
      { command, env, subPath } = opts,
      _env = _.extend({}, process.env, env),
      _cwd = path.join(process.cwd(), subPath);

    var child = this.child = exec(command, { cwd: _cwd, env: _env });

    child.on('error', err => {
      this.status = 'error';
      this.emit('error', err);
    })

    child.stdout.on('data', (data) => {
      this.emit('stdout', data.toString());
    });

    child.stderr.on('data', (data) => {
      this.emit('stderr', data.toString());
    });

    child.on('close', (code) => {
      this.status = 'ended';
      this.exitCode = code;
      console.log(`${TC.OKBLUE}Process ended:${TC.ENDC}`, this.pid)
      this.emit('close', code);
    });

    this.status = 'running';
    this.pid = this.child.pid;

    console.log(`${TC.OKGREEN}Process started${TC.ENDC}`)
    console.log(`  by: ${TC.UNDERLINE}${this.caller.docPath}${TC.ENDC}`)
    console.log('  pid:', this.pid);
    console.log(`  cmd: ${TC.BOLD}${command}${TC.ENDC}`);
  }

  json() {
    return {
      'id': this.id,
      'caller': this.caller,
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
    if (this.status === 'running') {
      console.log(`${TC.WARNING}Killing:${TC.ENDC}`, this.pid);
      kill(this.pid);
    }
  }

  destroy() {
    this.stop();
    this.emitter.removeAllListeners();
  }
}

module.exports = Process;