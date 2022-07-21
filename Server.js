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
  sessionMiddleware = session({
    secret: 'kat-man-do',
    resave: false,
    saveUninitialized: false
  });



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
    app.use(sessionMiddleware);
    app.use(bodyParser.json());
    app.use('/disk', diskServer.router);
    app.use('/auth', authServer.router);
    app.use(express.static(path.join(__dirname, 'static')));
    app.use('*', (req, res) => res.status(404).send('404 not found'));

    // Socket Server: processes
    const
      io = new SocketServer(httpServer, { cors: corsPolicy }),
      processServer = new ProcessServer({ io });

    io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

    io.use((socket, next) => {
      const session = socket.request.session;
      next(session && session.authenticated ? null : new Error('authentication error'));
    });

    httpServer.listen(config.serverPort, () => {
      console.log('Server running on port', config.serverPort)
    });

    // Vani Broker: messaging
    const vaniBroker = new VaniBroker({ port: config.vaniPort, processServer });
    vaniBroker.listen(_ => console.log('Vani running on port', config.vaniPort));
  }
}

module.exports = Server;