const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PluginLlmRegistry } = require("../dist/main/extensions/llmRegistry");
const { readBundle, resolveBundleConfig } = require("../dist/main/extensions/bundle");
const { parseMcpPatch, mcpPatch, applyMcpPatch } = require("../dist/main/extensions/harnessMcp");
const { validate } = require("../dist/main/extensions/mcp");

(async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { LlmAdapter } = await import("@deepseek-ai/dsh-llm");
  const context = new Context();
  const registry = new PluginLlmRegistry(context);
  const service = registry.service();
  let closed = false;
  const adapter = new class extends LlmAdapter {
    providerInfo(id) { return { id, name: "Fixture" }; }
    async listModels(provider) { return [{ id: "fixture", name: "Fixture", provider }]; }
    async *stream(options) {
      if (options.signal?.aborted) throw new Error("aborted");
      try {
        const prompt = options.messages[0].content[0].text;
        yield { type: "text-delta", text: "中文响应" };
        yield { type: "finish", reason: prompt === "failure" ? { kind: "error", failure: { code: "TEST", message: "upstream refused" } } : { kind: "stop" } };
      } finally { closed = true; }
    }
  };
  const handle = service.registerAdapter(["fixture"], adapter);
  assert.equal((await registry.listModels())[0].provider, "fixture");
  assert.deepEqual(await registry.generate({ provider: "fixture", model: "fixture", prompt: "hello" }), { text: "中文响应" });
  assert.equal(closed, true);
  await assert.rejects(() => registry.generate({ provider: "fixture", model: "fixture", prompt: "failure" }), /upstream refused/);
  await assert.rejects(() => registry.generate({ provider: "fixture", model: "invented", prompt: "hello" }), /not advertised/);
  assert.throws(() => service.registerAdapter(["fixture"], adapter), { code: "DUPLICATE_ADAPTER" });
  assert.throws(() => handle.replace(["fixture", "fixture"]), { code: "DUPLICATE_ADAPTER" });
  assert.equal(service.listProviders().length, 1);
  handle.replace(["replacement"]);
  assert.equal(service.listProviders()[0].id, "replacement");
  handle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.listProviders().length, 0);
  assert.throws(() => handle.replace(["again"]), /disposed/);
  await context.fiber.dispose();
  console.log("PASS real Cordis LLM registry, atomic replacements, actual stream/errors and scoped disposal");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-bundle-contract-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dsh: { bundle: { patch: "patch.yml" } } }));
    fs.writeFileSync(path.join(root, "patch.yml"), `- insert:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      args:\n        - !!js dshHomePath('profiles/web/node_modules/fixture/dist/mcp.js')\n`);
    const layers = readBundle(root);
    assert.equal(resolveBundleConfig(layers[0].config, root).args[0], path.join(root, "dist/mcp.js"));
    assert.throws(() => resolveBundleConfig({ path: { __jsExpr: "process.exit(0)" } }, root), /不支持/);
    assert.throws(() => resolveBundleConfig({ path: { __jsExpr: "dshHomePath('profiles/web/node_modules/another/file.js')" } }, root), /其他包/);
    assert.throws(() => resolveBundleConfig({ path: { __jsExpr: "dshHomePath('profiles/web/node_modules/fixture/../../outside')" } }, root), /路径无效/);
    assert.throws(() => resolveBundleConfig({ path: { __jsExpr: "process.env.DEEPSEEK_API_KEY ?? ''" } }, root), /不支持/);
    const config = validate(JSON.stringify({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: ["fixture.js"], cwd: root, env: { FIXTURE: "local" },
      serverName: "fixture", toolCallTimeoutMs: 5000, disabled: true, failOnStartupError: false, reconnect: { enabled: false } } } }));
    assert.deepEqual(parseMcpPatch(mcpPatch(config)), config);
    const source = JSON.stringify({ mcpServers: { untouched: { command: "node", disabled: true } } });
    const addition = { mcpServers: { ...JSON.parse(source).mcpServers, new: { command: "node", disabled: true } } };
    assert.deepEqual(applyMcpPatch(source, mcpPatch(addition)).mcpServers.untouched, JSON.parse(source).mcpServers.untouched);
    assert.throws(() => parseMcpPatch("- insert:\n  - id: bad\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      command: !!js process.exit(0)\n"), /unknown scalar tag/);
    assert.throws(() => validate(JSON.stringify({ mcpServers: { test: { command: "node", cwd: "relative" } } })), /absolute/);
    assert.throws(() => validate(JSON.stringify({ mcpServers: { test: { command: "node", toolCallTimeoutMs: 300000 } } })), /timeout/);
    console.log("PASS inert bundle expressions, path/env boundaries and MCP configuration round trip");
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
