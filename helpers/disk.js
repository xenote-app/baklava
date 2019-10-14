const
  https = require('https'),
  fs = require('fs'),
  path = require('path');

function getIndex(articleId) {
  if (!articleId)
    throw 'No Article Id';

  const
    folderPath = path.join('./', articleId),
    filePath = path.join(folderPath, '.index');

  if (!fs.existsSync(filePath))
    return {};

  return JSON.parse(fs.readFileSync(filePath));
}

function setIndex(articleId, index) {
  const
    folderPath = path.join('./', articleId),
    filePath = path.join(folderPath, '.index');

  if (!fs.existsSync(folderPath))
    fs.mkdirSync(folderPath);

  fs.writeFileSync(filePath, JSON.stringify(index, null, 2));
}

function updateFile(articleId, file) {
  const
    folderPath = path.join('./', articleId),
    filePath = path.join(folderPath, file.filename);

  if (!fs.existsSync(folderPath))
    fs.mkdirSync(folderPath);

  if (file.content) {
    fs.writeFileSync(filePath, file.content);
    updateIndex(articleId, file);
    return Promise.resolve();
  }
  if (file.downloadUrl) {
    const writeStream = fs.createWriteStream(filePath);
    return (new Promise((resolve, reject) => {
      https.get(file.downloadUrl, response => {
        response.pipe(writeStream);
        response.on('error', reject);
        response.on('end', _ => {
          updateIndex(articleId, file);
          resolve();
        });
      });
    }));
  }
}

function updateIndex(articleId, file) {
  const index = getIndex(articleId);
  index[file.filename] = { filename: file.filename, version: file.version }
  setIndex(articleId, index);
}


function deleteFile(articleId, filename, cb) {
  console.log(`Deleting file "${filename}" from "${articleId}"`)
  cb(null);
  return null;
}

module.exports = { getIndex, setIndex, updateFile, updateIndex, deleteFile }