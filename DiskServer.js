const
  express = require('express'),
  disk = require('./helpers/disk');

class DiskServer {
  constructor() {
    const router = this.router = express.Router();

    // index
    router.get('/doc/:docId/index', (req, res) => {
      res.send(disk.getIndex(req.params.docId));
    });

    // folder content
    router.get('/doc/:docId/index/:folderPath', (req, res) => {
      res.send(disk.getFolderContent(req.params.folderPath));
    });

    // delete
    router.delete('/doc/:docId/index/:contentPath', (req, res) => {
      res.send(disk.delete(req.params.contentPath));
    });

    // initialize
    router.post('/doc/:docId/initialize', (req, res) => {
      res.send(disk.initialize({
        docId: req.params.docId,
        docPath: req.body.docPath
      }));
    });
    
    // post
    router.post('/doc/:docId/files/:filename', (req, res) => {
      disk
        .addFile({
          docId: req.params.docId,
          filename: req.params.filename,
          file: req.body
        })
        .then(_ => res.send('Done.'))
        .catch(e => { console.error(e); res.status(500).send(e); })
    });

    // delete
    router.delete('/doc/:docId/files/:filename', (req, res) => {
      disk
        .deleteFile({
          docId: req.params.docId,
          filename: req.params.filename
        })
        .then(_ => res.send('Done.'))
        .catch(e => { console.error(e); res.status(500).send(e); });
    });
  }
}

module.exports = DiskServer;