const
  https = require('https'),
  http = require('http'),
  fs = require('fs'),
  path = require('path'),
  TC = require('../misc').TERMINAL_COLORS;

function getIndex(docId) {
  const filePath = path.join('./', `.index-${docId}`);
  
  if (!fs.existsSync(filePath))
    return {};

  const
    index = JSON.parse(fs.readFileSync(filePath)),
    folderPath = path.join('./', index.docPath);

  index.folderContents = getFolderContents(folderPath);

  return index;
}

function getFolderContents(folderPath) {
  const all = fs.readdirSync(folderPath);
  
  return all.map(name => {
    const stat = fs.lstatSync(path.join(folderPath, name));
    return ({
      name: name,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      atime: stat.atime,
      mtime: stat.mtime
    })
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
    index = { docPath, files: {} };
  
  console.log('Initializing for ', docId, index);

  if (fs.existsSync(folderPath)) {
    fs.rmdirSync(folderPath, { recursive: true });
  }
  fs.mkdirSync(folderPath, { recursive: true });
  
  return setIndex(docId, index);
}


async function addFile({ docId, file }) {
  const
    index = getIndex(docId),
    folderPath = index.docPath,
    filePath = path.join('./', folderPath, file.filename);

  console.log(`Saving file: "${filePath}" version ${file.version}`);

  if (file.type === 'DocFile') {
    fs.writeFileSync(filePath, file.content);
    updateFileIndex(docId, file.filename, file.version);
    return;

  } else if (file.type === 'StoreFile') {
    const
      writeStream = fs.createWriteStream(filePath),
      url = file.downloadUrl,
      protocol = url && url.startsWith('https') ? https : http;
    
    console.log('Downloading and saving URL:', url);
    await new Promise((resolve, reject) => {
      protocol.get(url, response => {
        response.pipe(writeStream);
        response.on('error', reject);
        response.on('end', _ => {
          updateFileIndex(docId, file.filename, file.version);
          resolve();
        });
      });
    });
  } else {
   throw new('Unknown type');

  }
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
    folderPath = index.docPath,
    filePath = path.join('./', folderPath, filename);
  
  fs.unlinkSync(filePath);
  removeFileIndex(docId, filename);

  return Promise.resolve();
}

function getFilePath(docId, filename) {
  return path.resolve(path.join('./', getIndex(docId).docPath, filename));
}

module.exports = { getIndex, setIndex, initialize, addFile, deleteFile, getFilePath }