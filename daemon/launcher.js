const
  { spawn } = require('child_process'),
  fs = require('fs'),
  path = require('path'),
  logFilePath = 'daemon.log';


const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
const daemonProcess = spawn('node', [path.join(__dirname, 'launch.js')], {
  detached: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});
daemonProcess.stdout.pipe(logStream);
daemonProcess.stderr.pipe(logStream);
daemonProcess.unref();