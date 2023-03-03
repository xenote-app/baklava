#!/usr/bin/env node

const
  program = require('commander'),
  Server = require('../Server'),
  { passwordsFileExists, fetchPasswords, setPassword, deleteUsername } = require('../helpers/password');


program.version('0.1');

program.command('launch')
  .description('Launches daemon.')
  .action(() => {
    if (!passwordsFileExists()) {
      console.log('Baklava is not initialized for this folder.');
      console.log('Run "baklava init" to initialize.');
      return;
    }
    const server = new Server();
    server.start();
  });

program.command('init')
  .description('Initializes folder.')
  .action(async () => {
    if (passwordsFileExists()) {
      console.log('The folder is already initialized.')
      console.log('Run "baklava launch" to launch.')
      return;
    }

    const
      username = 'admin',
      password = await askPassword(`Password for user "${username}":`);

    trySetPassword({ username, password });
    console.log('Initialized');
    console.log('username:', username);
    console.log('password:', password);
  });

program.command('list-users')
  .description('List all usernames')
  .action(() => {
    for (let username in fetchPasswords()) {
      console.log(username);
    }
  });

program.command('create-user')
  .description('List all usernames')
  .argument('<username>', 'Username for which to change password of.')
  .action(async (username) => {
    if (fetchPasswords()[username])
      return console.error('A user already exists with the username: ' + username);

    const password = await askPassword(`Password for user "${username}": `);
    trySetPassword({ username, password })
  });

program.command('set-password')
  .description('Set password for a user')
  .argument('<username>', 'Username to change password of.')
  .action(async (username) => {
    if (!fetchPasswords()[username])
      return console.error('Cannot find user with username: ' + username);

    const password = await askPassword(`Password for user "${username}": `);
    trySetPassword({ username, password })
  });

program.command('delete-user')
  .description('Delete a user')
  .argument('<username>', 'Username to delete.')
  .action((username) => {
    try {
      deleteUsername(username);
      console.log(`User "${username}" has been removed.`);
    }
    catch(e) {
      console.error(e.message);
    }
  });

function trySetPassword({ username, password }) {
  try {
    setPassword({ username, password });
  } catch (e) {
    console.error(e.message);
  }  
}

async function askPassword(question='Password: ') {
  const readline = require('node:readline/promises').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  // readline.stdoutMuted = true;
  // readline._writeToOutput = function _writeToOutput(stringToWrite) {}
  const password = await readline.question(question);
  readline.close();
  return password;
}


program.parse(process.argv);

if (program.args.length == 0)
  console.log(program.helpInformation());