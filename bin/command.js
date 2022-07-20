#!/usr/bin/env node

const
  program = require('commander'),
  Server = require('../Server'),
  { passwordsFileExists, setPassword } = require('../helpers/password');


program.version('0.1');

program.command('launch')
  .description('Launches daemon.')
  .action(_ => {
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
  .action(_ => {
    const
      username = 'admin',
      password = 'changeme' + Math.random().toString().substr(-4);
    setPassword({ username, password });
    console.log('Initialized');
    console.log('username:', username);
    console.log('password:', password);
  });


program.parse(process.argv);

if (program.args.length == 0)
  console.log(program.helpInformation());