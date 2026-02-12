const http = require("http"),
  express = require("express"),
  cors = require("cors"),
  { randomUUID } = require("crypto"),
  { Server } = require("@modelcontextprotocol/sdk/server/index.js"),
  {
    StreamableHTTPServerTransport,
  } = require("@modelcontextprotocol/sdk/server/streamableHttp.js"),
  {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    isInitializeRequest,
  } = require("@modelcontextprotocol/sdk/types.js");

class MCPRelay {
  constructor({ port }) {
    this.port = port;
    this.tools = [];
    this.claimedSocket = null; // the socket.io socket that claimed the MCP session
    this.pendingCalls = {};
    this.transports = {}; // sessionId -> StreamableHTTPServerTransport
    this.servers = {}; // sessionId -> MCP Server instance
  }

  listen(cb) {
    const self = this;

    // Express app for MCP HTTP endpoint (Claude Desktop connects here)
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.post("/", function (req, res) {
      self.handleMCPRequest(req, res);
    });
    app.get("/", function (req, res) {
      self.handleMCPGet(req, res);
    });
    app.delete("/", function (req, res) {
      self.handleMCPDelete(req, res);
    });

    const httpServer = http.createServer(app);
    httpServer.listen(this.port, cb);
  }

  // --- Socket.io middleware (called from Server.js like kernelServer) ---

  handleSocket(socket) {
    const self = this;

    socket.on("mcp", function (message) {
      var topic = message.topic;

      if (topic === "claim") {
        self.handleClaim(socket);
      } else if (topic === "release") {
        self.handleRelease(socket);
      } else if (topic === "register") {
        if (self.claimedSocket !== socket) {
          socket.emit("mcp", { topic: "error", error: "Not claimed" });
          return;
        }
        self.tools = message.tools || [];
        console.log("MCP: Registered", self.tools.length, "tools");
        self.notifyToolsChanged();
        socket.emit("mcp", { topic: "registered", count: self.tools.length });
      } else if (topic === "tool_result") {
        var pending = self.pendingCalls[message.id];
        if (pending) {
          clearTimeout(pending.timer);
          delete self.pendingCalls[message.id];

          if (message.error) {
            pending.resolve({
              isError: true,
              content: [{ type: "text", text: message.error }],
            });
          } else {
            pending.resolve({
              content: [
                {
                  type: "text",
                  text:
                    typeof message.result === "string"
                      ? message.result
                      : JSON.stringify(message.result),
                },
              ],
            });
          }
        }
      }
    });

    socket.on("disconnect", function () {
      if (self.claimedSocket === socket) {
        console.log("MCP: Claimed socket disconnected");
        self.claimedSocket = null;
        self.tools = [];
        self.rejectAllPending("Browser tab disconnected");
        self.notifyToolsChanged();
      }
    });
  }

  handleClaim(socket) {
    if (this.claimedSocket && this.claimedSocket !== socket) {
      socket.emit("mcp", {
        topic: "error",
        error: "Another tab has already claimed the MCP session",
      });
      return;
    }
    this.claimedSocket = socket;
    console.log("MCP: Session claimed by", socket.id);
    socket.emit("mcp", { topic: "claimed" });
  }

  handleRelease(socket) {
    if (this.claimedSocket !== socket) return;
    console.log("MCP: Session released by", socket.id);
    this.claimedSocket = null;
    this.tools = [];
    this.rejectAllPending("MCP session released");
    this.notifyToolsChanged();
    socket.emit("mcp", { topic: "released" });
  }

  // --- MCP HTTP handlers (for Claude Desktop) ---

  handleMCPRequest(req, res) {
    const self = this;
    const sessionId = req.headers["mcp-session-id"];
    console.log(
      "MCP POST:",
      req.body.method || req.body.type,
      sessionId
        ? "(session: " + sessionId.slice(0, 8) + "...)"
        : "(no session)",
    );

    if (sessionId && this.transports[sessionId]) {
      this.transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: function () {
          return randomUUID();
        },
        onsessioninitialized: function (sid) {
          self.transports[sid] = transport;
        },
      });

      transport.onclose = function () {
        const sid = transport.sessionId;
        if (sid) {
          delete self.transports[sid];
          delete self.servers[sid];
        }
      };

      const server = self.createMCPServer();
      server.connect(transport).then(function () {
        var sid = transport.sessionId;
        if (sid) self.servers[sid] = server;
        transport.handleRequest(req, res, req.body);
      });
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session" },
      id: null,
    });
  }

  handleMCPGet(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && this.transports[sessionId]) {
      this.transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).send("Invalid or missing session ID");
    }
  }

  handleMCPDelete(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && this.transports[sessionId]) {
      this.transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).send("Invalid or missing session ID");
    }
  }

  // --- MCP Server factory ---

  createMCPServer() {
    const self = this;

    const server = new Server(
      { name: "xenote-baklava", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, function () {
      console.log("MCP tools/list:", JSON.stringify(self.tools, null, 2));
      return { tools: self.tools };
    });

    server.setRequestHandler(CallToolRequestSchema, function (request) {
      const name = request.params.name;
      const args = request.params.arguments || {};

      if (!self.claimedSocket) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No browser tab connected. Open Xenote and claim the MCP session.",
            },
          ],
        };
      }

      var tool = null;
      for (var i = 0; i < self.tools.length; i++) {
        if (self.tools[i].name === name) {
          tool = self.tools[i];
          break;
        }
      }

      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown tool: " + name }],
        };
      }

      return self.forwardToolCall(name, args);
    });

    return server;
  }

  // --- Tool call forwarding ---

  forwardToolCall(name, args) {
    const self = this;
    const id = randomUUID();

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete self.pendingCalls[id];
        resolve({
          isError: true,
          content: [{ type: "text", text: "Tool call timed out after 30s" }],
        });
      }, 30000);

      self.pendingCalls[id] = { resolve: resolve, timer: timer };

      self.claimedSocket.emit("mcp", {
        topic: "tool_call",
        id: id,
        name: name,
        arguments: args,
      });
    });
  }

  rejectAllPending(reason) {
    for (var id in this.pendingCalls) {
      clearTimeout(this.pendingCalls[id].timer);
      this.pendingCalls[id].resolve({
        isError: true,
        content: [{ type: "text", text: reason }],
      });
    }
    this.pendingCalls = {};
  }

  notifyToolsChanged() {
    for (var sid in this.servers) {
      try {
        this.servers[sid].sendToolListChanged();
        console.log(
          "MCP: Notified session",
          sid.slice(0, 8) + "...",
          "of tools change",
        );
      } catch (e) {
        console.log(
          "MCP: Failed to notify session",
          sid.slice(0, 8) + "...",
          e.message,
        );
      }
    }
  }
}

module.exports = MCPRelay;
