const
  https = require('https'),
  fs = require('fs'),
  path = require('path');

function getIndex(docId) {
  const filePath = path.join('./', `.index-${docId}`);
  console.log(docId, filePath);

  if (!fs.existsSync(filePath))
    return {};

  const
    index = JSON.parse(fs.readFileSync(filePath)),
    folderPath = path.join('./', index.docPath);

  index.folderContents = getFolderContents(folderPath);

  return index;
}

function getFolderContents(folderPath) {
  const
    all = fs.readdirSync(folderPath),
    files = [],
    folders = [];
  
  all.forEach(name => {
    const isFolder = fs.lstatSync(path.join(folderPath, name)).isDirectory();
    if (isFolder)
      folders.push(name);
    else
      files.push(name);
  });
  return { files, folders };
}

function setIndex(docId, index) {
  const indexPath = path.join('./', `.index-${docId}`);;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return index;
}

function initialize({ docId, docPath }) {
  console.log(docId, docPath);
  const
    folderPath = path.join('./', docPath),
    index = { docPath };
  
  console.log('Initializing for ', docId, index);

  if (fs.existsSync(folderPath)) {
    fs.rmdirSync(folderPath, { recursive: true });
  }
  fs.mkdirSync(folderPath, { recursive: true });
  
  return setIndex(docId, index);
}


function addFile({ docId, file }) {
  const index = getIndex(docId);

  console.log('docId', docId);
  console.log('saving file', file.filename, 'version', file.version);

  const
    folderPath = index.docPath.join('/'),
    filePath = path.join('./', folderPath, file.filename);

  if (file.type === 'DocFile') {
    fs.writeFileSync(filePath, file.content);
    updateFileIndex(docId, file.filename, file.version);
    return Promise.resolve();

  } else if (file.type === 'StoreFile') {
    const writeStream = fs.createWriteStream(filePath);
    
    return (new Promise((resolve, reject) => {
      https.get(file.downloadUrl, response => {
        response.pipe(writeStream);
        response.on('error', reject);
        response.on('end', _ => {
          updateFileIndex(docId, file.filename, file.version);
          resolve();
        });
      });
    }));
  }

  return Promise.reject('Unknown type');
}

function updateFileIndex(docId, filename, version) {
  const
    index = getIndex(docId),
    created = (new Date()).toISOString();
  index.files = index.files || {};
  index.files[filename] = { version, created };
  setIndex(docId, index);
}

function removeFileIndex(docId, filename) {
  const index = getIndex(docId);
  index.files = index.files || {};
  delete index.files[filename];
  setIndex(docId, index);
}

function deleteFile({ docId, filename }) {
  const index = getIndex(docId);

  console.log('docId', docId);
  console.log('Deleting file :', filename);

  const
    folderPath = index.docPath.join('/'),
    filePath = path.join('./', folderPath, filename);
  
  fs.unlinkSync(filePath);
  removeFileIndex(docId, filename);

  return Promise.resolve();
}

module.exports = { getIndex, setIndex, initialize, addFile, deleteFile }