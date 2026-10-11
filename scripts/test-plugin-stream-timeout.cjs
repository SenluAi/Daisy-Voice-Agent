const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HarnessServer } = require("../dist/main/extensions/harnessServer");

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-plugin-stream-"));
  const server = new HarnessServer(temporary, temporary, undefined, async () => ({}));
  const nativeTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 30000 ? 80 : ms, ...args);
  const abort = new AbortController();
  try {
    server.register({ path: "/events", kind: "exact", handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("data: ready\n\n");
    } });
    server.register({ path: "/partial-error", kind: "exact", handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }); res.write("partial"); throw new Error("fixture failure");
    } });
    server.register({ path: "/hang", kind: "exact", handler: () => {} });
    const { origin, token } = await server.start();
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(origin + "/events", { headers, signal: abort.signal });
    const reader = response.body.getReader();
    assert.match(Buffer.from((await reader.read()).value).toString(), /ready/);
    await new Promise(resolve => nativeTimeout(resolve, 200));
    const broken = await fetch(origin + "/partial-error", { headers }).then(r => r.text()).catch(() => "connection closed");
    assert.equal(broken, "connection closed");
    assert.equal((await fetch(origin + "/hang", { headers })).status, 504);
    await reader.cancel();
    console.log("PASS persistent SSE survives timeout; partial errors close safely; ordinary hung requests still time out");
  } finally {
    abort.abort(); server.close(); global.setTimeout = nativeTimeout;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
