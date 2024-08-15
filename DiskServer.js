const
  express = require('express'),
  disk = require('./helpers/disk'),
  fs = require('fs');


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

    // get machine file
    router.get('/doc/:docId/files/:filename', (req, res) => {
      const filePath = disk.getFilePath(req.params.docId, req.params.filename);
      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
          // File does not exist
          console.error(`File not found: ${filePath}`);
          return res.status(404).send('File not found');
        }
        
        res.sendFile(filePath, (err) => {
          if (err) {
            console.error(`File failed to send: ${filePath}`, err);
            return res.status(500).send('Error sending file');
          }
        });
      });
    });
  }
}

module.exports = DiskServer;