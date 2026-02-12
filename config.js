const fs = require("fs");
var localConfig = {};

if (fs.existsSync("./config.json")) {
  try {
    const data = fs.readFileSync("./config.json", "utf8");
    localConfig = JSON.parse(data);
  } catch (e) {
    console.error('Error loading "config.json"');
    console.error(e);
    process.exit(1);
  }
  console.log('Local "config.json" loaded');
}

module.exports = Object.assign(
  {
    httpPort: 3456,
    httpsPort: 3457,
    vaniPort: 3458,
    mcpPort: 3459,
    certsDir: "./_certs",
  },
  localConfig,
  {
    secret: new Date().getTime().toString(),
  },
);
