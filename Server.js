const
  path = require('path'),
  express = require('express'),
  cors = require('cors'),
  bodyParser = require('body-parser'),
  AuthServer = require('./AuthServer'),
  DiskServer = require('./DiskServer'),
  ProcessServer = require('./ProcessServer'),
  VaniBroker = require('./VaniBroker'),
  config = require('./config'),
  SocketServer = require('socket.io').Server,
  session = require('express-session'),
  jwt = require('jsonwebtoken');


corsPolicy = {
  origin: 'http://localhost:3000',
  credentials: true,
  // methods: ['GET', 'POST']
}

class Server {
  start() {
    // HTTP Server: auth and sync
    const
      app = express(),
      httpServer = require('http').createServer(app),
      authServer = new AuthServer(),
      diskServer = new DiskServer();
    
    app.use(cors(corsPolicy));
    app.use(bodyParser.json());
    app.use('/disk', diskServer.router);
    app.use('/auth', authServer.router);
    app.use(express.static(path.join(__dirname, 'static')));
    app.use('*', (req, res) => res.status(404).send('404 not found'));

    // Socket Server: processes
    const
      io = new SocketServer(httpServer, { cors: corsPolicy }),
      processServer = new ProcessServer({ io });

    io.use((socket, next) => {
      authenticateToken(socket.handshake.query && socket.handshake.query.token)
        .then(next)
        .catch(err => next(new Error('Authentication error')));
    });

    httpServer.listen(config.serverPort, () => {
      console.log('Server running on port', config.serverPort)
    });

    // Vani Broker: messaging
    const vaniBroker = new VaniBroker({ port: config.vaniPort, processServer });
    vaniBroker.listen(_ => console.log('Vani running on port', config.vaniPort));
  }
}


async function authenticateToken(token) {
  jwt.verify(token, config.secret);
}

module.exports = Server;