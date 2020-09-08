const
  express = require('express'),
  disk = require('./helpers/disk');

class FileSyncServer {
  constructor() {
    const router = this.router = express.Router();

    // index
    router.get('/article/:articleId/index', (req, res) => {
      res.send(disk.getIndex(req.params.articleId));
    });

    // folder content
    router.get('/article/:articleId/index/:folderPath', (req, res) => {
      res.send(disk.getFolderContent(req.params.folderPath));
    });

    // delete
    router.delete('/article/:articleId/index/:contentPath', (req, res) => {
      res.send(disk.delete(req.params.contentPath));
    });

    // initialize
    router.post('/article/:articleId/initialize', (req, res) => {
      res.send(disk.initialize({
        articleId: req.params.articleId,
        articlePath: req.body.articlePath
      }));
    });
    
    // post
    router.post('/article/:articleId/files/:filename', (req, res) => {
      disk
        .addFile({
          articleId: req.params.articleId,
          filename: req.params.filename,
          file: req.body
        })
        .then(_ => res.send('Done.'))
        .catch(e => { console.error(e); res.status(500).send(e); })
    });

    // delete
    router.delete('/article/:articleId/files/:filename', (req, res) => {
      disk
        .deleteFile({
          articleId: req.params.articleId,
          filename: req.params.filename
        })
        .then(_ => res.send('Done.'))
        .catch(e => { console.error(e); res.status(500).send(e); });
    });
  }
}

module.exports = FileSyncServer;