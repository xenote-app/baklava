const
  FileSyncServer = require('./FileSyncServer'),
  ProcessServer = require('./ProcessServer'),
  express = require('express'),
  cors = require('cors'),
  bodyParser = require('body-parser');

class Server {
  constructor(port=1823) {
    this.port = port
  }
  
  start() {
    const
      app = express(),
      http = require('http').createServer(app),
      io = require('socket.io')(http),
      fileSyncServer = new FileSyncServer(),
      processServer = new ProcessServer();
    
    processServer.listen(io);
    app.use(cors());
    app.use(bodyParser.json());
    app.use('/disk', fileSyncServer.router);
    app.use('*', (req, res) => res.status(404).send('404 not found'));
    
    http.listen(this.port, () => {
      console.log('Running on', this.port)
    });
  }
}

module.exports = Server;