#!/usr/bin/env node

const
  { createCerts } = require('../certs'),
  program = require('commander'),
  Server = require('../Server'),
  { passwordsFileExists, fetchPasswords, setPassword, deleteUsername } = require('../helpers/password'),
  { launchDaemon, checkDaemonStatus, killDaemon, isPortTaken } = require('../daemon/fns');


program.version('0.1');

function checkInitialized() {
  if (!passwordsFileExists()) {
    console.log('Baklava is not initialized for this folder.');
    console.log('Run "baklava init" to initialize.');
    return false;
  }
  return true;
}

program.command('launch')
  .description('Starts baklava on this folder')
  .action(function() {
    if (!checkInitialized())
      return;
    isPortTaken().then(function(taken) {
      if (taken) {
        console.log('Baklava is already running.')
        return;
      }
      const server = new Server();
      server.start();      
    })
  });

const daemon  = program.command('daemon')
daemon.description('Daemonize baklava');

daemon.command('launch')
  .description('Launches baklava as a background process on this folder.')
  .action(function() {
    if (!checkInitialized()) return;
    launchDaemon();
  });

daemon.command('status')
  .description('Checks the status of the daemon.')
  .action(function() { checkDaemonStatus(); });

daemon.command('kill')
  .description('Kills a daemon.')
  .action(function() { killDaemon(); });

program.command('init')
  .option('-p, --password <password>', 'Set a password for the project')
  .option('-u, --username <username>', 'Set a password for the project')
  .description('Initializes folder.')
  .action(async function(options) {
    if (passwordsFileExists()) {
      console.log('The folder is already initialized.')
      console.log('Run "baklava launch" to launch.')
      return;
    }

  const
    username = options.username || 'admin',
    password = options.password || await askPassword(`🔑 Enter a new password for baklava user '${username}':`);

  trySetPassword({ username, password });
  console.log('Initialized');
  console.log('username:', username);
  console.log('password:', password);
});

program.command('list-users')
  .description('List all usernames')
  .action(function() {
    for (let username in fetchPasswords()) {
      console.log(username);
    }
  });

program.command('create-user')
  .description('List all usernames')
  .argument('<username>', 'Username for which to change password of.')
  .action(async function(username) {
    if (fetchPasswords()[username])
      return console.error('A user already exists with the username: ' + username);

    const password = await askPassword(`Password for user "${username}": `);
    trySetPassword({ username, password })
  });

program.command('set-password')
  .description('Set password for a user')
  .argument('<username>', 'Username to change password of.')
  .action(async function(username) {
    if (!fetchPasswords()[username])
      return console.error('Cannot find user with username: ' + username);

    const password = await askPassword(`Password for user "${username}": `);
    trySetPassword({ username, password })
  });

program.command('delete-user')
  .description('Delete a user')
  .argument('<username>', 'Username to delete.')
  .action(function(username) {
    try {
      deleteUsername(username);
      console.log(`User "${username}" has been removed.`);
    }
    catch(e) {
      console.error(e.message);
    }
  });

program.command('create-certs')
  .description('Creates SSL Certificates to allow HTTPS.')
  .action(createCerts);

function trySetPassword({ username, password }) {
  try {
    setPassword({ username, password });
  } catch (e) {
    console.error(e.message);
  }  
}

async function askPassword(question='Password: ') {
  const password = await (new Promise(function(resolve) {
    const readline = require('readline').createInterface(process.stdin, process.stdout);
    readline.question(question, function(answer) {
      resolve(answer);
      readline.close();
    });
  }));
  return password;
}


program.parse(process.argv);

if (program.args.length == 0)
  console.log(program.helpInformation());