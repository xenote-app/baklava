const
  os = require('os'),
  ifaces = os.networkInterfaces();

function interfaces() {
  result = [];
  Object.keys(ifaces).forEach(function(ifname) {
    ifaces[ifname].forEach(function (iface) {
      if (iface.internal !== false) return;

      result.push({
        'address': iface.address,
        'netmask': iface.netmask,
        'family': iface.family,
        'mac': iface.mac
      });
    });
  });
  return result;
}

function getMachineInfo() {
  return {
    'user': process.env.USER,
    'pid': process.pid,
    'platform': process.platform,
    'interfaces': interfaces(),
    'cpus': os.cpus(),
    'memory': os.totalmem(),
    'hostname': os.hostname(),
    'cwd': process.cwd()
  }
}

module.exports = { getMachineInfo }