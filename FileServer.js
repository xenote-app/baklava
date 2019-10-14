const
  express = require('express'),
  disk = require('./helpers/disk');

class FileSyncServer {
  constructor() {
    const router = this.router = express.Router();

    // index
    router.get('/article/:articleId/index', (req, res) => {
      const
        articleId = req.params.articleId,
        index = disk.getIndex(articleId);
      
      res.send(index);
    });

    // post
    router.post('/article/:articleId/files/', (req, res) => {
      const
        articleId = req.params.articleId,
        file = req.body;
      
      disk
        .updateFile(articleId, file)
        .then(done => {
          res.send('Done.');
        })
        .catch(e => {
          console.error(e);
          res.status(500).send(e);
        })
    });

    // delete
    router.delete('/article/:articleId/files/:fileName', (req, res) => {
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