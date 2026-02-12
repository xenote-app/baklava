const path = require("path"),
  fs = require("fs"),
  express = require("express"),
  cors = require("cors"),
  SocketServer = require("socket.io").Server,
  session = require("express-session"),
  jwt = require("jsonwebtoken"),
  http = require("http"),
  https = require("https"),
  bodyParser = require("body-parser"),
  AuthServer = require("./AuthServer"),
  DiskServer = require("./DiskServer"),
  KernelServer = require("./kernel/Server"),
  ProcessManager = require("./ProcessManager"),
  WebSocketManager = require("./WebSocketManager"),
  VaniManager = require("./VaniManager"),
  MCPRelay = require("./MCPRelay"),
  config = require("./config"),
  { showInstallMessage } = require("./kernel/checkInstall");

corsPolicy = {
  origin: [
    "http://localhost:3000",
    "https://xenote-app.web.app",
    "https://xenote.com",
  ],
  credentials: true,
  // methods: ['GET', 'POST']
};

class Server {
  start() {
    // HTTP Server: auth and sync
    const app = express(),
      authServer = new AuthServer(),
      diskServer = new DiskServer(),
      kernelServer = new KernelServer(),
      httpServer = http.createServer(app);

    app.use(cors(corsPolicy));
    app.use(bodyParser.json());
    app.use("/disk", diskServer.router);
    app.use("/auth", authServer.router);
    app.use(express.static(path.join(__dirname, "static")));
    app.use("*", function (req, res) {
      res.status(404).send("404 not found");
    });

    // Process Manager
    const processManager = new ProcessManager();

    // Web Socket Server Manager
    const io = new SocketServer({ cors: corsPolicy }),
      webSocketManager = new WebSocketManager({ io, processManager });

    io.use(function (socket, next) {
      authenticateToken(socket.handshake.query && socket.handshake.query.token)
        .then(next)
        .catch(function (err) {
          next(new Error("Authentication error"));
        });
    });

    httpServer.listen(config.httpPort, function () {
      console.log("📡  HTTP Server running on port", config.httpPort);
    });
    io.attach(httpServer);

    // Kernel Socket Middleware
    if (kernelServer.installed) {
      io.use(function (socket, next) {
        kernelServer.handleSocket(socket);
        next();
      });
    }

    // MCP Socket Middleware
    const mcpRelay = new MCPRelay({ port: config.mcpPort });
    io.use(function (socket, next) {
      mcpRelay.handleSocket(socket);
      next();
    });

    // HTTPS Suppoer
    if (config.httpsPort) {
      const keyPath = path.join(config.certsDir, "private-key.pem"),
        certPath = path.join(config.certsDir, "certificate.pem"),
        { colors } = require("./helpers/colors");

      if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        // console.log(
        //   colors.yellow +
        //   'Run "baklava create-certs" to create SSL Certs and support HTTPS.\n' +
        //   colors.reset
        // );
      } else {
        const httpsServer = https.createServer(
          {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
          app,
        );
        httpsServer.listen(config.httpsPort, function () {
          console.log(`📡  HTTPS Server running on port`, config.httpsPort);
        });
        io.attach(httpsServer);
      }
    }

    // Vani Manager
    const vaniManager = new VaniManager({
      port: config.vaniPort,
      webSocketManager,
      processManager,
    });
    vaniManager.listen(function () {
      console.log("📡  Vani running on port", config.vaniPort);
    });

    // MCP Relay HTTP (for Claude Desktop)
    mcpRelay.listen(function () {
      console.log("📡  MCP Relay running on port", config.mcpPort);
    });

    console.log("⊹ ࣪ ﹏𓊝﹏𓂁﹏⊹ ࣪ ˖");

    // const { colors } = require('./helpers/colors');
    if (kernelServer.installed) {
      console.log("🪐  Jupyter Kernel is ready.");
    } else {
      showInstallMessage(kernelServer.installStatus);
    }
  }
}

async function authenticateToken(token) {
  jwt.verify(token, config.secret);
}

module.exports = Server;
