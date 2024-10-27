const
  https = require('https'),
  http = require('http'),
  fs = require('fs'),
  path = require('path'),
  TC = require('../misc').TERMINAL_COLORS;


function initializeIndex(docId, docPath) {
  const
    folderPath = path.join('./', docPath),
    index = { docPath, files: {} };
  
  console.log('Initializing index for ', docId, docPath);
  if (fs.existsSync(folderPath)) {
    fs.rmdirSync(folderPath, { recursive: true });
  }
  fs.mkdirSync(folderPath, { recursive: true });
  
  return setIndex(docId, index);
}


function getIndex(docId) {
  const filePath = path.join('./', `.index-${docId}`);
  return (!fs.existsSync(filePath) ? null : JSON.parse(fs.readFileSync(filePath)));
}


function setIndex(docId, index) {
  const indexPath = path.join('./', `.index-${docId}`);;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return index;
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


// Add if file exists
function checkExists(docPath, filename) {
  return !!fs.existsSync(path.join('./', docPath, filename));
}

function getResourceType(resPath) {
  try {
    const stats = fs.lstatSync(resPath);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null;
  } catch (err) {
    console.error('Error checking path:', err);
  }
  return null;
}

function getFolderContents(resPath) {
  return (
    fs
      .readdirSync(resPath, { withFileTypes: true })
      .map(function(file) { return ({ name: file.name, isDirectory: file.isDirectory() }); })
  );
}


async function addFile(docId, file) {
  const
    index = getIndex(docId),
    folderPath = index.docPath,
    filePath = path.join('./', folderPath, file.filename),
    dir = path.dirname(filePath);

  console.log(`Saving file: "${filePath}" version ${file.version}`);

  if (!fs.existsSync(dir)) {
    console.log('Creating folder', dir);
    fs.mkdirSync(dir, { recursive: true });
  }

  if (file.content) {
    const data = file.isBase64 ? Buffer.from(file.content, 'base64') : file.content;
    fs.writeFileSync(filePath, data);
    updateFileIndex(docId, file.filename, file.version);
    return;
  } else if (file.url) {    
    await downloadFile(filePath, file.url);
  } else {
   throw new Error('Unknown type');
  }
  updateFileIndex(docId, file.filename, file.version);
}


function downloadFile(filePath, downloadUrl) {
  const
    writeStream = fs.createWriteStream(filePath),
    protocol = downloadUrl.startsWith('https') ? https : http;

  console.log('Downloading and saving URL:', downloadUrl);
  new Promise(function(resolve, reject) {
    protocol.get(downloadUrl, function(response) {
      response.pipe(writeStream);
      response.on('error', reject);
      response.on('end', resolve);
    });
  });
}


function deleteFile(docId, filename) {
  const
    index = getIndex(docId),
    folderPath = index.docPath,
    filePath = path.join('./', folderPath, filename);
  
  console.log('Deleting file', docId, filename);
  removeFileIndex(docId, filename);
  fs.unlinkSync(filePath);
}

module.exports = {
  initializeIndex, getIndex, setIndex,
  checkExists, getResourceType, getFolderContents, addFile, deleteFile
}