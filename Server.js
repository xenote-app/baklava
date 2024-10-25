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
  jwt = require('jsonwebtoken'),
  http = require('http'),
  https = require('https'),
  fs = require('fs');


corsPolicy = {
  origin: [
    'http://localhost:3000',
    'https://xenote-app.web.app',
    'https://xenote.com'
  ],
  credentials: true,
  // methods: ['GET', 'POST']
}

class Server {
  start() {
    // HTTP Server: auth and sync
    const
      app = express(),
      authServer = new AuthServer(),
      diskServer = new DiskServer(),
      httpServer = http.createServer(app);
    
    app.use(cors(corsPolicy));
    app.use(bodyParser.json());
    app.use('/disk', diskServer.router);
    app.use('/auth', authServer.router);
    app.use(express.static(path.join(__dirname, 'static')));
    app.use('*', (req, res) => res.status(404).send('404 not found'));
    
    // check https server
    var httpsServer = null;
    const
      keyPath = path.join(config.certsDir, 'private-key.pem'),
      certPath = path.join(config.certsDir, 'certificate.pem');

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      // console.log('SSL Certs not found for HTTPS. Run "baklava create-certs" to create new certs.');
    } else {
      httpsServer = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }, app);
    }
    
    // Socket Server: processes
    const
      io = new SocketServer({ cors: corsPolicy }),
      processServer = new ProcessServer({ io });

    io.use((socket, next) => {
      authenticateToken(socket.handshake.query && socket.handshake.query.token)
        .then(next)
        .catch(err => next(new Error('Authentication error')));
    });


    httpServer.listen(config.httpPort, () => {
      console.log('📡  HTTP Server running on port', config.httpPort)
    });
    io.attach(httpServer);

    if (httpsServer) {
      httpsServer.listen(config.httpsPort, () => {
        console.log(`📡  HTTPS Server running on port`, config.httpsPort);
      });
      io.attach(httpsServer);
    }

    // Vani Broker: messaging
    const vaniBroker = new VaniBroker({ port: config.vaniPort, processServer });
    vaniBroker.listen(() => console.log('📡  Vani running on port', config.vaniPort));

    console.log('⊹ ࣪ ﹏𓊝﹏𓂁﹏⊹ ࣪ ˖')
  }
}


async function authenticateToken(token) {
  jwt.verify(token, config.secret);
}

module.exports = Server;