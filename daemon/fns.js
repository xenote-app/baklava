const
  { spawn } = require('child_process'),
  fs = require('fs'),
  path = require('path'),
  logFilePath = 'daemon.log',
  pidFilePath = '.pid',
  net = require('net'),
  config = require('../config'),
  kill = require('tree-kill');

async function launchDaemon() {
  const daemon = spawn('node', [path.join(__dirname, 'launcher.js')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await savePid(daemon.pid);
  console.log('Dameon launched.\nPID:', daemon.pid, '\nstdout:', logFilePath);
  process.exit();
}

function isPortTaken() {
  return new Promise(function(resolve, reject) {
    const server = net.createServer();
    server.listen(1823, null, function() {
      server.close();
      resolve(false);
    });
    server.on('error', function(err) {
      if (err.code === 'EADDRINUSE') { resolve(true); }
      else { reject(err); }
    });
  });
}

async function checkDaemonStatus() {
  console.log(
    'Baklava deamon is ' + ((await isPortTaken()) ? 'running.' : 'not running.')
  );
}

async function killDaemon() {
  if (!(await isPortTaken())) {
    console.log('Daemon is not running.');
    return;
  }
  const pid = await getPid();
  console.log('Killing process', pid);
  kill(pid);
}

// Get the current process id
function savePid(pid) {
  return new Promise(function(resolve, reject) {
    fs.writeFile(pidFilePath, pid.toString(), function(err) {
      if (err) { reject(err); }
      else { resolve(); }
    });
  });
}

function getPid() {
  return new Promise(function(resolve, reject) {
    fs.readFile(pidFilePath, 'utf8', function(err, data) {
      if (err) { reject(err); }
      else { resolve(parseInt(data.trim(), 10)); }
    });
  });
}


module.exports = { launchDaemon, checkDaemonStatus, killDaemon, isPortTaken };