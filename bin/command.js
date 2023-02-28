#!/usr/bin/env node

const
  program = require('commander'),
  Server = require('../Server'),
  { passwordsFileExists, fetchUsernames, setPassword } = require('../helpers/password');


program.version('0.1');

program.command('launch')
  .description('Launches daemon.')
  .action(() => {
    if (!passwordsFileExists()) {
      console.log('Baklava is not initialized for this folder.');
      console.log('Run "baklava init"');
      return;
    }
    const server = new Server();
    server.start();
  });

program.command('init')
  .description('Initializes folder.')
  .action(() => {
    const
      username = 'admin',
      password = 'changeme' + Math.random().toString().substr(-4);
    setPassword({ username, password });
    console.log('Initialized');
    console.log('username:', username);
    console.log('password:', password);
  });

program.command('list-users')
  .description('List all usernames')
  .action(() => {
    fetchUsernames().forEach(username => console.log(username));
  });

program.command('create-user')
  .description('List all usernames')
  .argument('<username>', 'Username for which to change password of.')
  .action(async (username) => {
    if (fetchUsernames().indexOf(username) !== -1)
      return console.error('A user already exists with the username: ' + username);

    try {
      const password = await askPassword(`Password for user "${username}": `);
      setPassword({ username, password })
    } catch (e) {
      console.error(e.message);
    }
  });


program.command('change-password')
  .description('Set password.')
  .argument('<username>', 'Username for which to change password of.')
  .action(async (username) => {
    if (fetchUsernames().indexOf(username) === -1)
      return console.error('Cannot find user with username: ' + username);

    try {
      const password = await askPassword(`Password for user "${username}": `);
      setPassword({ username, password });
    } catch (e) {
      console.error(e.message);
    }
  });

async function askPassword(question='Password :') {
  const readline = require('node:readline/promises').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  readline.stdoutMuted = true;
  readline._writeToOutput = function _writeToOutput(stringToWrite) {}
  const password = await readline.question(question);
  readline.close();
  return password;
}


program.parse(process.argv);

if (program.args.length == 0)
  console.log(program.helpInformation());