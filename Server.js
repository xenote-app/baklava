const
  FileServer = require('./FileServer'),
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
      fileServer = new FileServer(),
      processServer = new ProcessServer(io);
    
    app.use(cors());
    app.use(bodyParser.json());
    app.use('/disk', fileServer.router);
    app.use('*', (req, res) => res.status(404).send('404 not found'));
    
    
    http.listen(this.port, () => {
      console.log('Running on', this.port)
    });
  }
}

module.exports = Server;