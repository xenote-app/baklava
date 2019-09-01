#!/usr/bin/env node

var
  program = require('commander'),
  Server = require('../Server');


program.version('0.1');

program.command('launch')
  .description('Launches daemon.')
  .action(_ => {
    const server = new Server();
    server.start();
  });

program.parse(process.argv);

if (program.args.length == 0)
  console.log(program.helpInformation());