const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PluginCatalog, normalizeCatalog, catalogInstallTarget } = require("../dist/main/extensions/catalog");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-catalog-check-"));
  const originalFetch = global.fetch;
  const raw = { s: "example", o: "owner", n: "Example", c: "tools", d: "测试插件", r: { repo: "owner/example", npmPackage: "example-plugin" }, sg: 42, v: "verified", vr: "1.0.0" };
  const entry = normalizeCatalog(raw);
  assert.equal(entry.id, "owner/example");
  assert.equal(entry.version, "1.0.0");
  assert.equal(entry.verified, true);
  assert.equal(catalogInstallTarget(raw, entry), "example-plugin");
  assert.throws(() => catalogInstallTarget(raw, { ...entry, webInstallable: false }));
  const gitRaw = { ...raw, r: "owner/example", ic: "dsh plugin --profile web add https://github.com/owner/example/releases/download/v1/plugin.tgz" };
  assert.equal(catalogInstallTarget(gitRaw, normalizeCatalog(gitRaw)), "https://github.com/owner/example/releases/download/v1/plugin.tgz");
  assert.equal(catalogInstallTarget({ ...gitRaw, ic: "dsh plugin --profile web add evil && cmd.exe" }, normalizeCatalog(gitRaw)), "git+https://github.com/owner/example.git");
  assert.equal(catalogInstallTarget({ ...gitRaw, ic: "dsh plugin add https://github.com/wrong/repo/releases/download/v1/plugin.tgz" }, normalizeCatalog(gitRaw)), "git+https://github.com/owner/example.git");
  let calls = 0;
  global.fetch = async url => { calls++; return new Response(JSON.stringify(url.endsWith("stats.json") ? { total: 2, verified: 2 } : [raw, { ...raw, s: "second", n: "Second", sg: 2 }]), { status: 200 }); };
  const catalog = new PluginCatalog(root);
  let cached;
  try {
    const result = await catalog.query({ limit: 1 });
    assert.equal(result.entries[0].name, "Example");
    assert.equal(result.total, 2);
    assert.equal(calls, 2);
    assert.equal((await catalog.query({ search: "测试", category: "tools" })).total, 2);
    assert.equal(calls, 2, "fresh cache should not refetch on each search");
    cached = new PluginCatalog(root);
    assert.equal((await cached.query()).total, 2);
    assert.equal(calls, 2, "cache must survive restart");
    global.fetch = async () => { throw new Error("offline"); };
    const offline = await cached.query({ refresh: true });
    assert.equal(offline.total, 2);
    assert.equal(offline.stale, true);
    assert.equal(offline.error, "offline");
    assert.equal(offline.syncedAt, result.syncedAt);
    console.log("PASS: real DSH field contract, structured install sources, pagination/filtering, daily cache, restart and offline preservation.");
  } finally {
    catalog.close(); cached?.close(); global.fetch = originalFetch;
    assert.ok(path.basename(root).startsWith("daisy-catalog-check-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
