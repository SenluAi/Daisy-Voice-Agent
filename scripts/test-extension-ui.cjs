const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-extension-ui-"));
  const screenshots = path.resolve(__dirname, `../../work/extension-ui-${require("../package.json").version}`);
  fs.mkdirSync(screenshots, { recursive: true });
  const plugin = path.join(root, "external-plugin");
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "daisy-ui-echo-fixture", version: "1.0.0", main: "index.cjs", daisy: {},
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN','unexpected')\"" } }));
  fs.writeFileSync(path.join(plugin, "index.cjs"), "exports.inject=['daisy']; exports.apply=ctx=>ctx.daisy.registerTool({name:'echo',description:'Echo test',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},args=>String(args.text));");
  let application;
  try {
    const env = { ...process.env, DAISY_EXTENSION_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "extension-ui-fixture.cjs")], env, timeout: 30000 });
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    await page.getByRole("button", { name: "插件技能", exact: true }).click();
    await page.getByRole("heading", { name: "DSH Plugin Hub", exact: true }).waitFor();
    await page.getByRole("list", { name: "市场插件", exact: true }).waitFor({ timeout: 60000 });
    const real = await page.evaluate(() => window.diriAPI.extensionsRequest("catalog", { limit: 3 }));
    assert.ok(real.catalogTotal > 10000);
    assert.ok(real.entries.every(x => x.id && x.repository));
    await page.screenshot({ path: path.join(screenshots, "market.png") });
    await page.getByRole("searchbox", { name: "搜索插件市场" }).fill("dsh-plugin-hub");
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="市场插件"] .ext-row').length === 1);
    await page.getByRole("tab", { name: "已安装", exact: true }).click();
    await page.getByRole("list", { name: "已安装插件", exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "启用DSH Plugin Hub", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "导入外部插件", exact: true }).click();
    await page.getByRole("button", { name: "信任并选择插件", exact: true }).click();
    await page.getByRole("heading", { name: "daisy-ui-echo-fixture", exact: true }).waitFor({ timeout: 60000 });
    const echo = await application.evaluate(async () => {
      const manager = global.extensionTestManager;
      const tools = JSON.parse(await manager.execute('extension_list_tools', '{}'));
      const tool = tools.find(x => x.name === 'echo');
      return manager.execute('extension_call_tool', JSON.stringify({id:tool.id,args_json:'{"text":"中文插件测试"}'}));
    });
    assert.equal(echo, "中文插件测试");
    const installed = await page.evaluate(() => window.diriAPI.extensionsRequest("snapshot"));
    assert.equal(installed.plugins.find(x => x.name === "daisy-ui-echo-fixture").status, "ready");
    const pluginFolders = fs.readdirSync(path.join(root, "extensions/plugins"));
    assert.equal(pluginFolders.length, 1);
    assert.equal(fs.existsSync(path.join(root, "extensions/plugins", pluginFolders[0], "SCRIPT_RAN")), false);
    await page.screenshot({ path: path.join(screenshots, "installed.png") });
    await page.getByRole("tab", { name: "技能 Skill", exact: true }).click();
    await page.getByRole("button", { name: "添加 Skill", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("会议纪要整理");
    await page.getByLabel("描述", { exact: true }).fill("整理真实会议记录和待办事项");
    await page.getByLabel("内容", { exact: true }).fill("只根据提供的会议记录整理，不编造结论。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("heading", { name: "会议纪要整理", exact: true }).waitFor();
    const skill = await page.evaluate(async () => {
      const snapshot = await window.diriAPI.extensionsRequest('snapshot');
      return window.diriAPI.extensionsRequest('readSkill', {id:snapshot.skills[0].id});
    });
    assert.equal(skill.name, "会议纪要整理");
    await page.getByRole("button", { name: "编辑 会议纪要整理", exact: true }).click();
    await page.getByLabel("描述", { exact: true }).fill("提取会议决议和负责人与截止时间");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("switch", { name: "启用会议纪要整理", exact: true }).uncheck();
    await page.waitForFunction(async () => !(await window.diriAPI.extensionsRequest('snapshot')).skills[0].enabled);
    await page.getByRole("switch", { name: "启用会议纪要整理", exact: true }).check();
    await page.screenshot({ path: path.join(screenshots, "skills.png") });
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".extensions-panel");
      return { width: panel.clientWidth, content: panel.scrollWidth, allButtonsNamed: [...panel.querySelectorAll('button')].every(b => !!(b.textContent.trim() || b.getAttribute('aria-label'))) };
    });
    assert.ok(geometry.content <= geometry.width + 2);
    assert.equal(geometry.allButtonsNamed, true);
    await page.getByRole("tab", { name: "插件市场", exact: true }).click();
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: "编辑 MCP 配置 JSON", exact: true }).click();
    await page.getByLabel("配置", { exact: true }).fill('{"mcpServers":{"off":{"command":"node","args":[],"disabled":true}}}');
    await page.getByRole("button", { name: "保存并应用", exact: true }).click();
    await page.getByRole("heading", { name: "off", exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "mcp.png") });
    await page.getByRole("button", { name: "编辑 MCP 配置 JSON", exact: true }).click();
    await page.getByLabel("配置", { exact: true }).fill("{broken");
    await page.getByRole("button", { name: "保存并应用", exact: true }).click();
    await page.getByRole("alert").waitFor();
    const unchanged = await page.evaluate(() => window.diriAPI.extensionsRequest("mcpConfig"));
    assert.ok(JSON.parse(unchanged).mcpServers.off);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("tab", { name: "技能 Skill", exact: true }).click();
    await page.getByRole("button", { name: "删除 会议纪要整理", exact: true }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.waitForFunction(async () => (await window.diriAPI.extensionsRequest('snapshot')).skills.length === 0);
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(900, 721); });
    await page.getByRole("tab", { name: "插件市场", exact: true }).click();
    await page.getByRole("tab", { name: "市场", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索插件市场" }).fill("");
    await page.getByRole("list", { name: "市场插件", exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "market-900.png") });
    const scroll = await page.evaluate(() => {
      const el = document.querySelector('.settings-page-scroll');
      el.scrollTop = el.scrollHeight;
      return { top: el.scrollTop, overflow: el.scrollHeight > el.clientHeight };
    });
    assert.equal(scroll.overflow, true);
    assert.ok(scroll.top > 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, realCatalog: real.catalogTotal, pluginImportNoScripts: true, skillsCrud: true, mcpValidation: true, scroll: true, screenshots }));
  } catch (error) {
    if (application) {
      const page = await application.firstWindow();
      console.error((await page.locator('body').innerText()).slice(-7000));
      await page.screenshot({path:path.join(screenshots,'failure.png')}).catch(() => {});
    }
    throw error;
  } finally {
    await application?.close();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(!relative.startsWith('..') && path.basename(root).startsWith('daisy-extension-ui-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
