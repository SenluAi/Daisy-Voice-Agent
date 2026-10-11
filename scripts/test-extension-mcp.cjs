const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

function fixtureServer(stats = { connections: 0, cancelled: 0 }) {
  stats.connections++;
  const server = new Server({ name: "local-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: (request.params?.cursor ? ["hold", "structured", "failure", "exception"] : ["echo"]).map((name) => ({
      name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: { text: { type: "string" } } },
    })),
    ...(request.params?.cursor ? {} : { nextCursor: "second-page" }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === "hold") return new Promise((_resolve, reject) => {
      extra.signal.addEventListener("abort", () => { stats.cancelled++; reject(new Error("Fixture cancelled")); }, { once: true });
    });
    if (request.params.name === "structured") return { content: [], structuredContent: { local: true } };
    if (request.params.name === "failure") return { isError: true, content: [{ type: "text", text: "Fixture tool failure" }] };
    if (request.params.name === "exception") throw new Error("SECRET_FROM_REMOTE_ERROR");
    return { content: [{ type: "text", text: request.params.arguments?.text ?? "echo" },
      { type: "resource", resource: { uri: "fixture://resource", text: "embedded resource", mimeType: "text/plain" } }] };
  });
  return server;
}

async function stdioFixture() {
  if (process.env.FIXTURE_ENV !== "test-env-secret") throw new Error("Missing fixture environment");
  if (process.env.DEEPSEEK_API_KEY || process.env.VOLCENGINE_ACCESS_TOKEN) throw new Error("Daisy credentials leaked into fixture");
  process.stderr.write("test-env-secret MUST NOT be logged by the manager\n");
  const server = fixtureServer();
  await server.connect(new StdioServerTransport());
}

function loadSource() {
  require.extensions[".ts"] = (loaded, filename) => {
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, filename);
  };
  const filename = path.resolve(__dirname, "../src/main/extensions/mcp.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

async function main() {
  const { McpManager, validate } = loadSource();
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "daisy-extension-mcp-"));
  const managers = [];
  const fixtureServers = [];
  const sessions = new Map();
  const sockets = new Set();
  const stats = { connections: 0, cancelled: 0 };
  const originalTimer = global.setTimeout;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousToken = process.env.VOLCENGINE_ACCESS_TOKEN;
  process.env.DEEPSEEK_API_KEY = "daisy-only-fixture-key";
  process.env.VOLCENGINE_ACCESS_TOKEN = "daisy-only-fixture-token";
  let accelerate = false;
  // Accelerate deadline timers only for deliberate hangs; all transports use the real SDK.
  global.setTimeout = (callback, ms, ...args) => originalTimer(callback, accelerate && [10000, 30000, 5000].includes(ms) ? 150 : ms, ...args);
  const listener = http.createServer((request, response) => {
    (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/hang") return;
      if (url.pathname === "/secret-error") { response.writeHead(500); response.end("test-header-secret"); return; }
      if (request.headers.authorization !== "Bearer test-header-secret") { response.writeHead(401); response.end("Unauthorized fixture"); return; }
      if (url.pathname === "/sse" && request.method === "GET") {
        const transport = new SSEServerTransport("/messages", response);
        const server = fixtureServer(stats);
        fixtureServers.push(server);
        sessions.set(transport.sessionId, transport);
        await server.connect(transport);
        return;
      }
      if (url.pathname === "/messages") {
        const transport = sessions.get(url.searchParams.get("sessionId"));
        assert.ok(transport instanceof SSEServerTransport);
        await transport.handlePostMessage(request, response);
        return;
      }
      if (url.pathname === "/mcp") {
        let transport = sessions.get(request.headers["mcp-session-id"]);
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => sessions.set(sessionId, transport) });
          const server = fixtureServer(stats);
          fixtureServers.push(server);
          await server.connect(transport);
        }
        await transport.handleRequest(request, response);
        return;
      }
      response.writeHead(404); response.end("Fixture not found");
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture failed");
      console.error(error);
      process.exitCode = 1;
    });
  });
  listener.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const manager = (name) => { const instance = new McpManager(path.join(temporary, name)); managers.push(instance); return instance; };
  const remote = (pathname, transport) => ({ url: base + pathname, ...(transport ? { transport } : {}), headers: { Authorization: "Bearer test-header-secret" } });
  const stdio = { command: process.execPath, args: [__filename, "--stdio-fixture"], env: { FIXTURE_ENV: "test-env-secret" } };
  const encode = (mcpServers) => JSON.stringify({ mcpServers });
  try {
    const instance = manager("main");
    assert.deepEqual(instance.snapshot(), []);
    assert.deepEqual(instance.listTools(), []);
    assert.deepEqual(JSON.parse(instance.readConfig()), { mcpServers: {} });
    assert.ok(!fs.existsSync(path.join(temporary, "main")), "constructor does not start or write configuration");
    const config = encode({ local: stdio, http: remote("/mcp"), sse: remote("/sse", "sse"),
      bad: { command: path.join(temporary, "missing-executable") }, disabled: { ...stdio, disabled: true } });
    assert.equal(Object.keys(validate(config).mcpServers).length, 5);
    await instance.saveConfig(config);
    await instance.start();
    assert.equal(instance.snapshot().find((entry) => entry.id === "local").status, "connected", "stdio fixture");
    assert.equal(instance.snapshot().find((entry) => entry.id === "http").status, "connected", "HTTP fixture");
    assert.equal(instance.snapshot().find((entry) => entry.id === "sse").status, "connected", "SSE fixture");
    assert.equal(instance.snapshot().find((entry) => entry.id === "bad").status, "error");
    assert.equal(instance.snapshot().find((entry) => entry.id === "disabled").status, "disabled");
    assert.equal(instance.listTools().length, 15, "both tool pages are discovered on every live transport");
    assert.doesNotMatch(JSON.stringify(instance.snapshot()), /test-env-secret|test-header-secret|env|headers/);
    for (const id of ["local", "http", "sse"]) {
      assert.equal(await instance.callTool(`mcp:${id}:echo`, { text: `${id} works` }), `${id} works\nembedded resource`);
      assert.equal(await instance.callTool(`mcp:${id}:structured`, {}), '{"local":true}');
      assert.equal(await instance.callTool(`mcp:${id}:failure`, {}), "MCP tool error: Fixture tool failure");
      await assert.rejects(instance.callTool(`mcp:${id}:exception`, {}), (error) => error.message === "MCP tool call failed");
    }
    const snapshot = instance.snapshot(); snapshot[0].status = "error";
    const tools = instance.listTools(); tools[0].inputSchema.type = "polluted";
    assert.equal(instance.snapshot()[0].status, "connected");
    assert.equal(instance.listTools()[0].inputSchema.type, "object");
    const diskBefore = instance.readConfig();
    const connectionsBefore = stats.connections;
    const invalid = ["not-json test-header-secret", "null", "[]", '{}', '{"mcpServers":[]}',
      encode({ "bad:id": stdio }), encode({ a: { command: 42 } }), encode({ a: { ...stdio, args: [1] } }),
      encode({ a: { ...stdio, env: { secret: 42 } } }), encode({ a: { ...stdio, disabled: "false" } }),
      encode({ a: { url: "file:///tmp/no" } }), encode({ a: { ...remote("/mcp"), command: "node" } }),
      encode({ a: { ...remote("/mcp"), transport: ["sse"] } }), encode({ a: { ...remote("/mcp"), headers: { Authorization: "secret\ninvalid" } } }),
      '{"mcpServers":{"__proto__":{"command":"node"}}}'];
    for (const json of invalid) {
      assert.throws(() => validate(json));
      await assert.rejects(instance.saveConfig(json));
      assert.equal(instance.readConfig(), diskBefore);
      assert.equal(instance.snapshot().find((entry) => entry.id === "http").status, "connected");
    }
    assert.equal(stats.connections, connectionsBefore);
    const rename = fs.renameSync;
    fs.renameSync = function (source, destination) {
      if (destination === path.join(temporary, "main", "mcp.json")) throw new Error("test-header-secret atomic rename failure");
      return rename.call(this, source, destination);
    };
    try {
      await assert.rejects(instance.saveConfig(encode({ replacement: remote("/mcp") })),
        (error) => error.message === "Unable to save MCP configuration");
    } finally { fs.renameSync = rename; }
    assert.equal(instance.readConfig(), diskBefore);
    assert.equal(stats.connections, connectionsBefore);
    assert.deepEqual(fs.readdirSync(path.join(temporary, "main")), ["mcp.json"]);
    assert.equal(await instance.callTool("mcp:http:echo", { text: "still live" }), "still live\nembedded resource");
    await assert.rejects(instance.callTool("mcp:missing:tool", {}), /unavailable/);
    await assert.rejects(instance.callTool("mcp:http:echo", []), /object/);

    const cancelled = new AbortController(); cancelled.abort("secret cancellation reason");
    await assert.rejects(instance.callTool("mcp:http:echo", {}, cancelled.signal), (error) => error.name === "AbortError" && !error.message.includes("secret"));
    const inFlight = new AbortController();
    const hold = instance.callTool("mcp:http:hold", {}, inFlight.signal);
    originalTimer(() => inFlight.abort(), 80);
    await assert.rejects(hold, (error) => error.name === "AbortError");
    accelerate = true;
    await assert.rejects(instance.callTool("mcp:http:hold", {}), (error) => error.name === "TimeoutError");
    accelerate = false;
    assert.equal(await instance.callTool("mcp:http:echo", { text: "after cancel" }), "after cancel\nembedded resource");

    const timeout = manager("timeout");
    accelerate = true;
    await timeout.saveConfig(encode({ hang: remote("/hang"), safe: { ...stdio, disabled: true } }));
    assert.equal(timeout.snapshot().find((entry) => entry.id === "hang").status, "connecting", "saving returns before a hanging server times out");
    await timeout.start();
    accelerate = false;
    assert.equal(timeout.snapshot().find((entry) => entry.id === "hang").status, "error");
    assert.match(timeout.snapshot().find((entry) => entry.id === "hang").error, /timed out/);
    const rejected = manager("redaction");
    await rejected.saveConfig(encode({ secret: remote("/secret-error") }));
    await rejected.start();
    assert.equal(rejected.snapshot()[0].status, "error");
    assert.doesNotMatch(JSON.stringify(rejected.snapshot()), /test-header-secret/);

    const changes = manager("changes");
    await changes.saveConfig(encode({ http: remote("/mcp") }));
    await changes.start();
    const changesBefore = stats.connections;
    await changes.start();
    assert.equal(stats.connections, changesBefore, "start retains an unchanged live connection");
    await changes.saveConfig(encode({ http: { ...remote("/mcp"), disabled: true } }));
    assert.equal(changes.snapshot()[0].status, "disabled");
    assert.deepEqual(changes.listTools(), []);
    await changes.saveConfig(encode({ http: remote("/mcp", "streamable-http") }));
    await changes.start();
    assert.equal(changes.snapshot()[0].status, "connected");
    fs.writeFileSync(path.join(temporary, "changes", "mcp.json"), "broken secret config");
    await changes.start();
    assert.equal(changes.snapshot().find((entry) => entry.id === "http").status, "connected");
    assert.ok(changes.snapshot().some((entry) => entry.status === "error"));
    await changes.saveConfig(encode({}));
    assert.deepEqual(changes.snapshot(), []);

    const concurrency = manager("concurrency");
    await Promise.all([concurrency.saveConfig(encode({ first: { ...stdio, disabled: true } })),
      concurrency.saveConfig(encode({ second: { ...stdio, disabled: true } }))]);
    assert.deepEqual(Object.keys(JSON.parse(concurrency.readConfig()).mcpServers), ["second"]);
    assert.deepEqual(concurrency.snapshot().map((entry) => entry.id), ["second"]);
    assert.deepEqual(fs.readdirSync(path.join(temporary, "concurrency")), ["mcp.json"]);
    const interrupted = manager("interrupted");
    const connecting = interrupted.saveConfig(encode({ hanging: remote("/hang") }));
    await new Promise((resolve) => originalTimer(resolve, 60));
    const closing = interrupted.close();
    await Promise.all([connecting, closing]);
    assert.deepEqual(interrupted.snapshot(), []);
    const running = instance.callTool("mcp:http:hold", {});
    const expectedAbort = assert.rejects(running, (error) => error.name === "AbortError");
    await instance.close();
    await expectedAbort;
    assert.deepEqual(instance.snapshot(), []);
    assert.deepEqual(instance.listTools(), []);

    const throwingClose = manager("throwing-close");
    await throwingClose.saveConfig(encode({ sse: remote("/sse", "sse") }));
    await throwingClose.start();
    const closeClient = Client.prototype.close;
    const closeTransport = SSEClientTransport.prototype.close;
    Client.prototype.close = async () => { throw new Error("SECRET_CLOSE_ENV"); };
    SSEClientTransport.prototype.close = async () => { throw new Error("SECRET_CLOSE_HEADER"); };
    try { await throwingClose.close(); } finally { Client.prototype.close = closeClient; SSEClientTransport.prototype.close = closeTransport; }
    assert.deepEqual(throwingClose.snapshot(), []);
    console.log("PASS: real local SDK stdio/HTTP/SSE, pagination, tool results, validation isolation, cancellation/timeouts, atomic saves, lifecycle races and close/error redaction.");
  } finally {
    accelerate = false;
    global.setTimeout = originalTimer;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousToken === undefined) delete process.env.VOLCENGINE_ACCESS_TOKEN; else process.env.VOLCENGINE_ACCESS_TOKEN = previousToken;
    await Promise.allSettled(managers.map((instance) => instance.close()));
    await Promise.allSettled(fixtureServers.map((server) => server.close()));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => listener.close(resolve));
    assert.ok(path.dirname(temporary) === fs.realpathSync(os.tmpdir()) && path.basename(temporary).startsWith("daisy-extension-mcp-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--stdio-fixture")) stdioFixture().catch(() => { process.exitCode = 1; });
else main().catch((error) => { console.error(error); process.exitCode = 1; });
