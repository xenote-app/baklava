const
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');

function hashPassword(password) {
  const
  	salt = crypto.randomBytes(128).toString('base64'),
  	iterations = 10000,
  	hash = crypto.pbkdf2Sync(password, salt, iterations, 128, 'sha256').toString('base64');
  return { salt, iterations, hash };
}

function isPasswordCorrect({ salt, hash, iterations, password }) {
	const hash_ = crypto.pbkdf2Sync(password, salt, iterations, 128, 'sha256').toString('base64');
  return hash === hash_;
}


const PASSWORDS_FILENAME = '.passwords.db.json';

function getPasswordsFilePath() {
	return path.join('./', PASSWORDS_FILENAME);
}

function passwordsFileExists() {
	return fs.existsSync(getPasswordsFilePath());
}

function fetchPasswords() {
  if (!passwordsFileExists())
    return {};
  return JSON.parse(fs.readFileSync(getPasswordsFilePath()));
}

function fetchUsers() {
	return Object.keys(fetchPasswords());
}

function savePasswords(passwords) {
  fs.writeFileSync(getPasswordsFilePath(), JSON.stringify(passwords, null, 2));
}

const
  usernameRegex = /^(?=[a-zA-Z0-9._]{4,20}$)(?!.*[_.]{2})[^_.].*[^_.]$/,
  passwordRegex = /^[A-Za-z\d@$!%*#?&]{4,20}$/

function setPassword({ username, password }) {
	if (!usernameRegex.test(username) || !passwordRegex.test(password))
		throw new Error('Invalid username or password.');

	const passwords = fetchPasswords();
	passwords[username] = hashPassword(password);
	savePasswords(passwords);
}

function checkPassword({ username, password }) {
	const hashed = fetchPasswords()[username];
	if (!hashed)
		return false;
	const { salt, hash, iterations } = hashed;
	return isPasswordCorrect({ salt, hash, iterations, password });
}

module.exports = { setPassword, checkPassword, passwordsFileExists, fetchUsers };