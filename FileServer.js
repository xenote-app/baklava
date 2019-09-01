const
  express = require('express'),
  disk = require('./helpers/disk');

class FileSyncServer {
  constructor() {
    this.router = express.Router();

    // index
    this.router.get('/article/:articleId/index', (req, res) => {
      const
        articleId = req.params.articleId,
        index = disk.getIndex(articleId);
      
      res.send(index);
    });

    // post
    this.router.post('/article/:articleId/files/', (req, res) => {
      const
        articleId = req.params.articleId,
        file = req.body;
      
      disk.updateFile(articleId, file)
        .then(done => { res.send('Done.') })
        .catch(e => res.status(500).send(e))
    });

    // delete
    this.router.get('/article/:articleId/files/:fileName', (req, res) => {
      const
        articleId = req.params.articleId,
        fileName = req.params.fileName;
      
      disk.deleteFile(articleId, fileName, (err) => {
        if (!err) res.send('deleted');
      });
      // res.send(index);
    });
  }
}

module.exports = FileSyncServer;