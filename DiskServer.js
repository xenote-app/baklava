const
  express = require('express'),
  disk = require('./helpers/disk'),
  path = require('path');


class DiskServer {
  constructor() {
    const router = this.router = express.Router();

    // POST initialize
    router.post('/doc/:docId/initialize', (req, res) => {
      res.send(disk.initializeIndex(req.params.docId, req.body.docPath));
    });

    // GET index
    router.get('/doc/:docId/index', (req, res) => {
      const index = disk.getIndex(req.params.docId);
      
      // Add CWD
      index.cwd = path.resolve(process.cwd(), index.docPath);

      // Add file exists
      for (let filename in index.files) {
        index.files[filename].exists = disk.checkExists(index.docPath, filename);
      }
      res.send(index);
    });


    // GET Folder or File
    router.get('/doc/:docId/files/:subpath(*)', (req, res) => {
      const
        docPath = disk.getIndex(req.params.docId).docPath,
        resPath = path.join('./', docPath, req.params.subpath),
        type = disk.getResourceType(resPath);

      if (type === 'directory')
        res.send(disk.getFolderContents(resPath));
      else if (type === 'file')
        res.sendFile(path.resolve(resPath));
      else
        res.status(404).send('Resource not found');
    });

    // POST File
    router.post('/doc/:docId/files/', (req, res) => {
      disk
        .addFile(req.params.docId, req.body)
        .then(_ => res.send('Done.'))
        .catch(e => { console.error(e); res.status(500).send(e); })
    });

    // DELETE File
    router.delete('/doc/:docId/files/:filepath(*)', (req, res) => {
      disk.deleteFile(req.params.docId, req.params.filepath);
      res.send('Done.');
    });
  }
}

module.exports = DiskServer;