const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

// Real installed packages, isolated state; never read or change Daisy's model keys.
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-installed-compat-"));
  const screenshots = path.resolve(__dirname, `../../work/installed-plugin-compat-${require("../package.json").version}`);
  fs.mkdirSync(screenshots, { recursive: true });
  let app;
  try {
    const env = { ...process.env, DAISY_EXTENSION_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "extension-ui-fixture.cjs")], env, timeout: 30000 });
    await app.firstWindow();
    const result = await app.evaluate(async () => {
      const fs = global.extensionTestRequire("node:fs");
      const path = global.extensionTestRequire("node:path");
      const source = path.join(process.env.APPDATA, "Daisy/extensions");
      const manager = global.extensionTestManager;
      manager.pluginsRoot = path.join(source, "plugins");
      const names = ["dsh-our-free-model", "@js2hou/dsh-mcp-manager", "managed-agents", "dsh-media-dock"];
      manager.plugins = JSON.parse(fs.readFileSync(path.join(source, "plugins.json"), "utf8")).filter(x => names.includes(x.name))
        .map(({ id, name, version, source, directory }) => ({ id, name, version, source, directory, enabled: true,
          config: name === "managed-agents" ? { autoStart: true } : {}, status: "disabled" }));
      for (const plugin of manager.plugins) await manager.load(plugin);
      return manager.snapshot().plugins.filter(x => !x.builtin).map(({ id, name, status, error, toolCount, panelAvailable }) => ({ id, name, status, error, toolCount, panelAvailable }));
    });
    console.log(JSON.stringify(result));
    assert.equal(result.length, 4);
    for (const item of result) assert.equal(item.status, "ready", `${item.name}: ${item.error}`);

    const tools = await app.evaluate(async () => JSON.parse(await global.extensionTestManager.execute("extension_list_tools", "{}")));
    const agents = tools.find(x => x.name === "list_agents");
    assert.ok(agents, "Real SandBase MCP tools missing");
    const output = await app.evaluate(async (_electron, id) => global.extensionTestManager.execute("extension_call_tool", JSON.stringify({ id, args_json: "{}" })), agents.id);
    assert.ok(output && !/MCP tool error|unauthorized|fetch failed/i.test(output));
    console.log("PASS real managed-agents authenticated MCP list_agents");
    const managed = result.find(x => x.name === "managed-agents");
    const pid = await app.evaluate((_electron, id) => global.extensionTestManager.bundles.get(id).service.child.pid, managed.id);
    await app.evaluate(async (_electron, id) => global.extensionTestManager.request("togglePlugin", { id, enabled: false }), managed.id);
    let stopped = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") stopped = true; else throw error; }
      if (stopped) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(stopped, "Disabled SandBase service is still running");
    await assert.rejects(() => app.evaluate(async (_electron, id) => global.extensionTestManager.execute("extension_call_tool", JSON.stringify({ id, args_json: "{}" })), agents.id));
    const restarted = await app.evaluate(async (_electron, id) => global.extensionTestManager.request("togglePlugin", { id, enabled: true }), managed.id);
    assert.equal(restarted.plugins.find(x => x.id === managed.id).status, "ready");
    assert.ok(await app.evaluate(async (_electron, id) => global.extensionTestManager.execute("extension_call_tool", JSON.stringify({ id, args_json: "{}" })), agents.id));
    console.log("PASS managed service disable cleanup and real restart/MCP reconnection");

    const mcp = result.find(x => x.name === "@js2hou/dsh-mcp-manager");
    const panel = await openPanel(app, mcp.id);
    const errors = [];
    panel.on("pageerror", error => errors.push(error.message));
    await panel.getByText("MCP", { exact: true }).first().waitFor();
    await panel.getByRole("button", { name: /新增|添加/ }).first().waitFor();
    const rpc = async (endpoint, payload) => panel.evaluate(async ({ endpoint, payload }) => {
      const response = await fetch("/_daisy/rpc", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "/mcp-manager", endpoint, payload }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }, { endpoint, payload });
    assert.equal((await rpc("list")).ok, true);
    const fixtureConfig = { serverName: "compat", transport: "stdio", command: process.execPath,
      args: [path.join(__dirname, "test-extension-mcp.cjs"), "--stdio-fixture"], env: { FIXTURE_ENV: "test-env-secret" }, reconnect: { enabled: false } };
    assert.equal((await rpc("add", { id: "compat-fixture", config: fixtureConfig })).ok, true);
    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      connected = (await rpc("list")).value.servers.some(x => x.id === "compat-fixture" && x.fiberPhase === "active" && x.toolCount === 5);
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(connected, "MCP manager did not actually connect the added server");
    assert.equal((await rpc("probe", { id: "compat-fixture" })).value.ok, true);
    const echo = await app.evaluate(async () => global.extensionTestManager.execute("extension_call_tool",
      JSON.stringify({ id: "mcp:compat-fixture:echo", args_json: JSON.stringify({ text: "插件 MCP 中文测试" }) })));
    assert.match(echo, /插件 MCP 中文测试/);
    await rpc("setEnabled", { id: "compat-fixture", enabled: false });
    const disabled = await rpc("list");
    assert.equal(disabled.value.servers.find(x => x.id === "compat-fixture").enabled, false);
    assert.equal((await rpc("update", { id: "compat-fixture", config: { ...fixtureConfig, toolCallTimeoutMs: 5000 } })).ok, true);
    await rpc("remove", { id: "compat-fixture" });
    assert.equal((await rpc("list")).value.servers.length, 0);
    await panel.screenshot({ path: path.join(screenshots, "mcp-manager.png") });
    assert.deepEqual(errors, []);
    console.log("PASS official MCP panel, Chinese locale, real connection/tool/probe and add/update/disable/remove");

    const free = result.find(x => x.name === "dsh-our-free-model");
    const freePanel = await openPanel(app, free.id);
    const freeErrors = [];
    freePanel.on("pageerror", error => freeErrors.push(error.message));
    await freePanel.getByRole("tab", { name: /Our Free Model|免费模型/ }).waitFor();
    await freePanel.locator(".ofm_shell").waitFor();
    assert.equal(await freePanel.locator(".panel-error").count(), 0);
    assert.equal(await freePanel.locator(".ofm_error").count(), 0);
    const response = await freePanel.evaluate(async () => {
      const response = await fetch("/api/our-free-model/summary");
      return { status: response.status, body: await response.json() };
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.distribution, "managed");
    assert.ok(Array.isArray(response.body.catalog));
    await freePanel.waitForFunction(async () => (await (await fetch("/api/our-free-model/summary")).json()).channels?.state !== "pending", undefined, { timeout: 20000 });
    const channels = await freePanel.evaluate(async () => (await (await fetch("/api/our-free-model/summary")).json()).channels);
    assert.equal(channels.state, "ready", channels.error);
    const accountList = await freePanel.evaluate(async () => {
      const response = await fetch("/_daisy/rpc", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "/api", endpoint: "channel-pack", payload: { method: "account.list", payload: { provider: "buddy" } } }) });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(accountList.status, 200, JSON.stringify(accountList.body));
    assert.equal(accountList.body.ok, true, JSON.stringify(accountList.body));
    assert.deepEqual(accountList.body.value.accounts, []);
    await freePanel.getByRole("tab", { name: /白嫖模型接入|Free channels/ }).click();
    await freePanel.getByText("WorkBuddy 国内版", { exact: true }).waitFor();
    await freePanel.screenshot({ path: path.join(screenshots, "free-model-channels.png") });
    assert.equal(await freePanel.locator(".ofm_error").count(), 0);
    console.log("PASS real channel-pack mounted, authenticated account.list RPC and account channel panel");
    assert.ok(tools.some(x => x.name === "dsh_generate_text"));
    assert.ok(tools.some(x => x.name === "dsh_list_models"));
    if (process.argv.includes("--live-model")) {
      const listId = tools.find(x => x.id.startsWith(`plugin:${free.id}:`) && x.name === "dsh_list_models").id;
      let models = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        models = JSON.parse(await app.evaluate(async (_electron, id) => global.extensionTestManager.execute("extension_call_tool", JSON.stringify({ id, args_json: "{}" })), listId));
        if (models.length) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.ok(models.length, "Free upstream has not advertised available models on this network");
      const summary = await freePanel.evaluate(async () => (await (await fetch("/api/our-free-model/summary")).json()));
      const available = new Set(summary.catalog.filter(x => x.availability === "available").map(x => x.id));
      const model = models.find(x => available.has(x.id)) || models.find(x => /flash|chat|kimi/i.test(x.id)) || models[0];
      const id = tools.find(x => x.id.startsWith(`plugin:${free.id}:`) && x.name === "dsh_generate_text").id;
      const reply = await app.evaluate(async (_electron, args) => global.extensionTestManager.execute("extension_call_tool", JSON.stringify({ id: args.id,
        args_json: JSON.stringify({ provider: args.provider, model: args.model, prompt: "用中文简短回复：插件兼容测试成功。" }) })), { id, provider: model.provider, model: model.id });
      assert.ok(JSON.parse(reply).text.trim());
      console.log("PASS real free-model upstream response (synthetic test prompt only)");
    }
    await freePanel.screenshot({ path: path.join(screenshots, "free-model.png") });
    await verifyPanelLayout(freePanel);
    await freePanel.setViewportSize({ width: 720, height: 640 });
    await verifyPanelLayout(freePanel);
    await freePanel.screenshot({ path: path.join(screenshots, "free-model-720.png") });
    assert.deepEqual(freeErrors, []);
    console.log("PASS official free-model panel, authenticated API and real adapter registry");
    console.log("PASS all four installed plugins with isolated application state");
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1200));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function openPanel(app, id) {
  const before = app.windows();
  await app.evaluate(async (_electron, id) => global.extensionTestManager.request("openPluginPanel", { id }), id);
  const panel = app.windows().find(x => !before.includes(x)) || await app.waitForEvent("window");
  await panel.waitForLoadState();
  return panel;
}

async function verifyPanelLayout(panel) {
  const layout = await panel.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    buttons: [...document.querySelectorAll(".ofm_shell header button")].map(button => ({
      text: button.textContent.trim(), width: button.getBoundingClientRect().width,
    })),
  }));
  assert.equal(layout.overflow, false, "Plugin panel overflows horizontally");
  for (const button of layout.buttons) if (button.text.length > 2) assert.ok(button.width > 40, `Plugin button constrained by host CSS: ${button.text}`);
}
