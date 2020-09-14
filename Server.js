const
  express = require('express'),
  cors = require('cors'),
  bodyParser = require('body-parser'),
  FileSyncServer = require('./FileSyncServer'),
  ProcessServer = require('./ProcessServer'),
  VaniBroker = require('./VaniBroker'),
  config = require('./config');

class Server {  
  start() {
    const
      app = express(),
      http = require('http').createServer(app),
      io = require('socket.io')(http),
      fileSyncServer = new FileSyncServer(),
      processServer = new ProcessServer({ io: io }),
      vaniBroker = new VaniBroker({ port: config.vaniPort, processServer: processServer });
    
    app.use(cors());
    app.use(bodyParser.json());
    app.use('/disk', fileSyncServer.router);
    app.use('*', (req, res) => res.status(404).send('404 not found'));


    processServer.emitter.on('vani-message', data => vaniBroker.handleMessage(data));
    vaniBroker.emitter.on('vani-message', data => processServer.emit('vani-message', data));
    
    http.listen(config.serverPort, () => {
      console.log('Server running on port', config.serverPort)
    });
    vaniBroker.listen(_ => console.log('Vani running on port', config.vaniPort));
  }
}

module.exports = Server;