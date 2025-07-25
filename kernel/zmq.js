let zmq;

try {
  zmq = require('zeromq');
} catch (e) {
  zmq = null;
}

module.exports = zmq;