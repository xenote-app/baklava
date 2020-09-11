const
  fs = require('fs'),
  net = require('net'),
  BufferHandler = require('./BufferHandler.js');

const dispatch = (socket, obj) => socket.write(JSON.stringify(obj) + '\n');

class VaniBroker {
  directories = {};

  getDirectory(channel) {
    if (!this.directories[channel]) {
      this.directories[channel] = {
        servers: new Set(),
        clients: new Set(),
        sockets: {}
      }
    }
    return this.directories[channel];
  }

  register({ socket, channel, type, resolveId }) {
    const { servers, clients, sockets } = this.getDirectory(channel);

    socket.channel = channel;
    socket.id = Math.random();
    socket.type = type;
    sockets[socket.id] = socket;

    if (type === 'server')
      servers.add(socket.id);
    else
      clients.add(socket.id);

    dispatch(socket, { resolveId });
  }

  handleMessage(request) {
    const
      { to, recepientId, senderId, channel } = request,
      { servers, sockets } = this.getDirectory(channel);

    if (to === 'server') {
      servers.forEach(id => dispatch(sockets[id], request));
    } else if (to === 'recepient') {
      if (sockets[recepientId])
        dispatch(sockets[recepientId], request);
    } else {
      for (id in sockets) {
        if (id !== senderId)
          dispatch(socket, request);
      }
    }
  }

  unregister(socket) {
    const { servers, clients, sockets } = this.getDirectory(socket.channel);
    servers.delete(socket.id);
    clients.delete(socket.id);
    delete sockets[socket.id];
  }

  handleSocketEnd = (socket) => {
    this.unregister(socket);
  }

  debug() {
    console.log.apply(console, arguments);
  }

  constructor(o) {
    this.port = o.port;
    this.processServer = o.processServer;
    this.processServer.emitter.on('vani data', data => this.handleMessage(data));
    this.createServer();
  }

  createServer() {
    const server = this.server = net.createServer((socket) => {
      const bufferHandler = new BufferHandler(request => {
        if (request.topic === 'register') {
          this.register({
            socket: socket,
            channel: request.channel,
            type: request.type,
            resolveId: request.resolveId
          });

        } else if (request.topic === 'message') {
          const data = Object.assign({}, request, {
            senderId: socket.id,
            channel: socket.channel
          });
          this.handleMessage(data);
          this.processServer.io.emit('vani data', data);

        } else {
          this.debug('handler not found:', request.topic);
          
        }
      });

      socket.on('data', chunk => bufferHandler.pump(chunk));
      socket.on('end', _ => this.handleSocketEnd(socket));
    });

    server.on('error', err => { throw err });
  }

  listen(cb) {
    if (fs.existsSync(this.port))
      fs.unlinkSync(this.port);

    this.server.listen(this.port, cb);
  }
}

module.exports = VaniBroker;