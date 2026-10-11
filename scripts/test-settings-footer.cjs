const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { _electron } = require("playwright-core");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-settings-footer-"));
  const screenshots = path.resolve(__dirname, `../../work/settings-footer-${require("../package.json").version}`);
  fs.mkdirSync(screenshots, { recursive: true });
  const installed = process.argv.includes("--installed");
  const executablePath = installed ? path.join(process.env.LOCALAPPDATA, "Programs/Daisy/Daisy.exe") : require("electron");
  let app;
  try {
    const env = { ...process.env, DAISY_EXTENSION_TEST_ROOT: root, DAISY_SETTINGS_FOOTER_TEST: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath, args: installed ? [] : [path.join(__dirname, "extension-ui-fixture.cjs")], env });
    if (installed) {
      const version = await app.evaluate(async ({ app }) => {
        await app.whenReady();
        const path = process.mainModule.require("node:path");
        await process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js")).getExtensionManager().start();
        const window = process.mainModule.require(path.join(app.getAppPath(), "dist/main/windows/settingsWindow.js")).createSettingsWindow(true);
        if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once("did-finish-load", resolve));
        return app.getVersion();
      });
      assert.equal(version, require("../package.json").version);
    }
    const page = installed ? app.windows().find(window => window.url().includes("renderer-settings/settings.html")) : await app.firstWindow();
    assert.ok(page, "settings window is available");
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const footer = page.locator("footer");
    const history = footer.getByRole("button", { name: "对话历史", exact: true });
    const save = footer.getByRole("button", { name: "保存设置", exact: true });
    const expectations = [
      ["模型配置", 0, 1, "model"], ["任务动态", 0, 0, "tasks"], ["插件技能", 0, 0, "extensions"],
      ["语音播报", 0, 1, "tts"], ["长期记忆", 1, 0, "memory"], ["系统设置", 0, 1, "system"],
    ];
    for (const [width, height] of [[1100, 886], [900, 721]]) {
      let settingsContentHeight;
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()
        .find(window => window.webContents.getURL().includes("renderer-settings/settings.html")).setSize(...size), [width, height]);
      for (const [label, histories, saves, id] of expectations) {
        await page.getByRole("button", { name: label, exact: true }).click();
        assert.equal(await history.count(), histories, label + " history");
        assert.equal(await save.count(), saves, label + " save");
        if (label === "模型配置") {
          for (const section of ["推理模型", "联网搜索", "语音识别", "语音唤醒"]) {
            await page.getByRole("button", { name: section, exact: true }).click();
            assert.equal(await history.count(), 0, section);
            assert.equal(await save.count(), 1, section);
          }
        }
        const contentHeight = await page.locator(".settings-page-scroll").evaluate(element => element.clientHeight);
        if (id === "model") settingsContentHeight = contentHeight;
        if (["tasks", "extensions"].includes(id)) {
          assert.equal(await footer.count(), 0, label + " footer removed");
          assert.equal(await page.getByText("配置项与后台服务动态同步", { exact: true }).count(), 0);
          assert.ok(contentHeight >= settingsContentHeight + 80, label + " uses the freed footer space");
        } else {
          const bounds = await footer.boundingBox();
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify({ label, bounds, viewport }));
        }
        if (!installed) await page.screenshot({ path: path.join(screenshots, `${id}-${width}.png`) });
      }
    }
    if (!installed) {
      for (const label of ["模型配置", "语音播报", "系统设置"]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await save.click();
        await page.getByText("✓ 保存成功，已同步到 daisy.env", { exact: true }).waitFor();
      }
      assert.equal(await app.evaluate(() => global.settingsTestSaves), 3);
      await app.evaluate(() => { global.settingsTestTaskFailure = true; });
      await page.getByRole("button", { name: "任务动态", exact: true }).click();
      await page.getByRole("alert").getByText("读取任务动态失败", { exact: true }).waitFor();
      assert.equal(await footer.count(), 0, "errors do not recreate the footer");
      await app.evaluate(() => { global.settingsTestTaskFailure = false; });
      await page.getByRole("button", { name: "长期记忆", exact: true }).click();
      await history.click();
      await page.getByText("暂无对话历史", { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(installed ? "PASS actual installed version, all page/subtab footer buttons and window layout (read-only)"
      : "PASS per-page footer buttons, all model subtabs, retained saving/history, large/default window layout; no live configuration writes");
    if (!installed) console.log(`Screenshots: ${screenshots}`);
  } finally {
    await app?.close();
    if (installed) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executablePath, [], { cwd: path.dirname(executablePath), env, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    }
    assert.ok(path.basename(root).startsWith("daisy-settings-footer-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
