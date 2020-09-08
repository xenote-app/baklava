const
  https = require('https'),
  fs = require('fs'),
  path = require('path');

function getIndex(articleId) {
  const filePath = path.join('./', `.index-${articleId}`);
  console.log(articleId, filePath);

  if (!fs.existsSync(filePath))
    return {};

  const
    index = JSON.parse(fs.readFileSync(filePath)),
    folderPath = path.join('./', index.articlePath.join('/'));

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

function deleteContent(contentPath) {
  return {}
}

function setIndex(articleId, index) {
  const indexPath = path.join('./', `.index-${articleId}`);;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return index;
}

function initialize({ articleId, articlePath }) {
  const
    folderPath = path.join('./', articlePath.join('/')),
    index = { articlePath };
  
  console.log('Initializing for ', articleId, index);

  if (fs.existsSync(folderPath)) {
    fs.rmdirSync(folderPath, { recursive: true });
  }
  fs.mkdirSync(folderPath, { recursive: true });
  
  return setIndex(articleId, index);
}


function addFile({ articleId, file }) {
  const index = getIndex(articleId);

  console.log('articleId', articleId);
  console.log('saving file', file.filename, 'version', file.version);

  const
    folderPath = index.articlePath.join('/'),
    filePath = path.join('./', folderPath, file.filename);

  if (file.type === 'DocFile') {
    fs.writeFileSync(filePath, file.content);
    updateFileIndex(articleId, file.filename, file.version);
    return Promise.resolve();

  } else if (file.type === 'StoreFile') {
    const writeStream = fs.createWriteStream(filePath);
    
    return (new Promise((resolve, reject) => {
      https.get(file.downloadUrl, response => {
        response.pipe(writeStream);
        response.on('error', reject);
        response.on('end', _ => {
          updateFileIndex(articleId, file.filename, file.version);
          resolve();
        });
      });
    }));
  }

  return Promise.reject('Unknown type');
}

function updateFileIndex(articleId, filename, version) {
  const
    index = getIndex(articleId),
    created = (new Date()).toISOString();
  index.files = index.files || {};
  index.files[filename] = { version, created };
  setIndex(articleId, index);
}

function removeFileIndex(articleId, filename) {
  const index = getIndex(articleId);
  index.files = index.files || {};
  delete index.files[filename];
  setIndex(articleId, index);
}

function deleteFile({ articleId, filename }) {
  const index = getIndex(articleId);

  console.log('articleId', articleId);
  console.log('Deleting file :', filename);

  const
    folderPath = index.articlePath.join('/'),
    filePath = path.join('./', folderPath, filename);
  
  fs.unlinkSync(filePath);
  removeFileIndex(articleId, filename);

  return Promise.resolve();
}

module.exports = { getIndex, setIndex, initialize, addFile, deleteFile }