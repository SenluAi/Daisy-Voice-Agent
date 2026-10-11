const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-credentials-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require("electron"), [__filename, root], { env, stdio: "inherit", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on("exit", code => {
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    process.exitCode = code === 0 ? 0 : 1;
  });
} else {
  const { app, safeStorage } = require("electron");
  const root = path.resolve(process.argv[2]);
  app.setPath("userData", root);
  app.disableHardwareAcceleration();
  let host;
  app.whenReady().then(async () => {
    assert.ok(safeStorage.isEncryptionAvailable());
    const build = process.env.DAISY_EXTENSION_BUILD_ROOT || path.resolve(__dirname, "..");
    const { PluginHost } = require(path.join(build, "dist/main/extensions/pluginHost"));
    const { PluginCredentialStore } = require(path.join(build, "dist/main/extensions/credentialStore"));
    host = new PluginHost();
    fs.symlinkSync(path.resolve(__dirname, "../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const directory = path.join(root, "plugin");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "credentials-fixture", type: "module", main: "index.js",
      exports: { ".": "./index.js", "./client": "./client.js" }, dsh: { client: { inject: [] } } }));
    fs.writeFileSync(path.join(directory, "client.js"), "// No UI needed for this server contract fixture.");
    fs.writeFileSync(path.join(directory, "index.js"), `
      export const inject = ["credentials", "llm", "commands", "connection", "daisy"];
      export async function apply(ctx) {
        const initial = await ctx.credentials.describe("TEST_KEY");
        let updates = 0;
        ctx.on("credentials/reference-updated", () => { updates++; });
        ctx.commands.register({ name: "fixture", description: "Fixture", handler: async () => ({ kind: "done" }) });
        const removeFetch = ctx.connection.fetch.register({ path: "/api/fixture", methods: ["POST"], requestBody: "buffered", async fetch(request) {
          const envelope = await request.json();
          if (envelope.payload?.cancel) await new Promise((resolve, reject) => request.signal.addEventListener("abort", () => {
            cancelled = true; reject(new Error("Cancelled"));
          }, { once: true }));
          return Response.json({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value: envelope.payload } });
        } });
        let cancelled = false;
        ctx.daisy.registerTool({ name: "credential", description: "Fixture", inputSchema: { type: "object" } }, async args => {
          switch (args.action) {
            case "initial": return { initial, commands: ctx.commands.list({}).map(x => x.name), llm: !!ctx.get("llm"), updates };
            case "set": await ctx.credentials.set("TEST_KEY", args.value); return { info: await ctx.credentials.describe("TEST_KEY"), updates };
            case "resolve": return { result: await ctx.credentials.resolve(args.ref || "TEST_KEY") };
            case "unset": await ctx.credentials.unset("TEST_KEY"); return await ctx.credentials.describe("TEST_KEY");
            case "increment":
              await Promise.all(Array.from({ length: 10 }, () => ctx.credentials.modifyRecord("fixture/counter", async current => {
                await new Promise(resolve => setTimeout(resolve, 2));
                return { kind: "grant", payload: (current?.payload || 0) + 1 };
              })));
              return { record: await ctx.credentials.readRecord("fixture/counter"), list: await ctx.credentials.listRecords(), info: await ctx.credentials.describeRecord("fixture/counter") };
            case "unchanged": return await ctx.credentials.modifyRecord("fixture/counter", async () => undefined);
            case "delete": await ctx.credentials.deleteRecord("fixture/counter"); return { list: await ctx.credentials.listRecords() };
            case "cancelled": return { cancelled };
            case "remove-route": removeFetch(); return {};
          }
        });
      }
    `);
    process.env.DEEPSEEK_API_KEY = "fixture-main-secret";
    const entry = { id: "credential-a", directory };
    assert.equal((await host.load(entry)).status, "ready", JSON.stringify(host.status(entry.id)));
    const call = (id, args) => host.callTool(`plugin:${id}:credential`, args).then(JSON.parse);
    const initial = await call(entry.id, { action: "initial" });
    assert.equal(initial.initial.configured, false);
    assert.equal(initial.llm, true);
    assert.ok(initial.commands.includes("fixture"));
    assert.deepEqual(await call(entry.id, { action: "resolve", ref: "DEEPSEEK_API_KEY" }), {});
    const saved = await call(entry.id, { action: "set", value: "fixture-plugin-secret" });
    assert.equal(saved.updates, 1);
    assert.equal(saved.info.configured, true);
    assert.equal(JSON.stringify(saved).includes("fixture-plugin-secret"), false);
    const dataDir = path.join(root, "extensions/plugin-data", createHash("sha256").update(entry.id).digest("hex"));
    const file = path.join(dataDir, "credentials.enc");
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(Buffer.from("fixture-plugin-secret")), false);
    assert.equal(JSON.parse(safeStorage.decryptString(bytes)).references.TEST_KEY, "fixture-plugin-secret");
    assert.equal((await call(entry.id, { action: "increment" })).record.payload, 10);
    assert.equal((await call(entry.id, { action: "unchanged" })).payload, 10);
    const panel = host.panel(entry.id);
    assert.ok(panel);
    const headers = { authorization: `Bearer ${panel.token}`, "content-type": "application/json" };
    const request = { type: "client-request", rpcId: "fixture-request", method: "fixture", payload: { text: "中文 RPC" } };
    const target = `${panel.origin}/api/fixture`;
    assert.equal((await fetch(target)).status, 401);
    assert.equal((await fetch(target, { headers: { ...headers, origin: "https://example.org" } })).status, 403);
    assert.equal((await fetch(target, { headers })).status, 405);
    const response = await fetch(target, { method: "POST", headers, body: JSON.stringify(request) });
    assert.deepEqual(await response.json(), { type: "server-response", rpcId: request.rpcId, result: { ok: true, value: request.payload } });
    const bridged = await fetch(`${panel.origin}/_daisy/rpc`, { method: "POST", headers,
      body: JSON.stringify({ channel: "/api", endpoint: "fixture", payload: request.payload }) });
    assert.deepEqual(await bridged.json(), { ok: true, value: request.payload });
    const controller = new AbortController();
    const waiting = fetch(target, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ ...request, payload: { cancel: true } }) });
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 150));
    controller.abort(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await call(entry.id, { action: "cancelled" })).cancelled, true);
    await call(entry.id, { action: "remove-route" });
    assert.equal((await fetch(target, { method: "POST", headers, body: JSON.stringify(request) })).status, 404);
    console.log("PASS real buffered fetch routes, official RPC envelopes, authentication, origin/method checks, cancellation and scoped route removal");
    await host.unload(entry.id);
    await host.load(entry);
    assert.equal((await call(entry.id, { action: "resolve" })).result.value, "fixture-plugin-secret");
    assert.equal((await call(entry.id, { action: "initial" })).initial.configured, true);
    await host.load({ id: "credential-b", directory });
    assert.deepEqual(await call("credential-b", { action: "resolve" }), {});
    await call(entry.id, { action: "delete" });
    assert.equal((await call(entry.id, { action: "unset" })).configured, false);
    const store = new PluginCredentialStore();
    await assert.rejects(() => store.request(dataDir, { action: "set", ref: "../escape", value: "x" }), /Invalid credential/);
    await assert.rejects(() => store.request(dataDir, { action: "set", ref: "TEST_KEY", value: " " }), /Invalid credential value/);
    await assert.rejects(() => store.request(dataDir, { action: "record.write", key: "fixture/counter", revision: -1, record: { kind: "grant", payload: 1 } }), /已变化/);
    await assert.rejects(() => store.request(dataDir, { action: "describe", ref: "TEST_KEY" }, AbortSignal.abort()), /cancelled/);
    fs.writeFileSync(file, "invalid-encrypted-data");
    await assert.rejects(() => store.request(dataDir, { action: "describe", ref: "TEST_KEY" }), /无法读取/);
    assert.equal(fs.readFileSync(file, "utf8"), "invalid-encrypted-data");
    console.log("PASS official services during load, encrypted durable credentials, isolation, safe descriptions, events, serialized record updates, CAS, validation, cancellation and corruption protection");
  }).then(() => { host?.close(); app.exit(0); }, error => { console.error(error); host?.close(); app.exit(1); });
}
