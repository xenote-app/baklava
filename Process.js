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
      process = this,
      { command, env, subPath } = opts,
      _env = _.extend({}, process.env, env),
      _cwd = path.join(process.cwd(), subPath);

    var child = process.child = exec(command, { cwd: _cwd, env: _env });

    child.on('error', function(err) {
      process.status = 'error';
      process.emit('error', err);
    })

    child.stdout.on('data', function(data) {
      process.emit('stdout', data.toString());
    });

    child.stderr.on('data', function(data) {
      process.emit('stderr', data.toString());
    });

    child.on('close', function(code) {
      process.status = 'ended';
      process.exitCode = code;
      console.log(`${TC.OKBLUE}Process ended:${TC.ENDC}`, process.pid)
      process.emit('close', code);
    });

    process.status = 'running';
    process.pid = process.child.pid;

    console.log(`${TC.OKGREEN}Process started${TC.ENDC}`)
    console.log(`  by: ${TC.UNDERLINE}${process.caller.docPath}${TC.ENDC}`)
    console.log('  pid:', process.pid);
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