const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { _electron } = require("playwright-core");

// Launch the actual installed application, inspect readiness, then leave it running normally.
(async () => {
  const executablePath = path.join(process.env.LOCALAPPDATA, "Programs/Daisy/Daisy.exe");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath, env, timeout: 30000 });
    const snapshot = await app.evaluate(async ({ app, utilityProcess }) => {
      await app.whenReady();
      const path = process.mainModule.require("node:path");
      const { getExtensionManager } = process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js"));
      const manager = getExtensionManager();
      await manager.start();
      const diagnostics = [];
      if (manager.snapshot().plugins.some(x => x.enabled && x.status === "error")) {
        const fork = utilityProcess.fork.bind(utilityProcess);
        utilityProcess.fork = (file, args, options) => {
          const child = fork(file, args, { ...options, stdio: "pipe" });
          child.stderr?.on("data", bytes => diagnostics.push(String(bytes).slice(0, 6000)));
          return child;
        };
        const plugin = manager.plugins.find(x => x.name === "dsh-our-free-model");
        await manager.host.load({ id: plugin.id, directory: plugin.directory, config: manager.effectiveConfig(plugin) });
        utilityProcess.fork = fork;
      }
      return { version: app.getVersion(), plugins: manager.snapshot().plugins.filter(x => !x.builtin)
        .map(({ id, name, enabled, status, error, toolCount }) => ({ id, name, enabled, status, error, toolCount })), diagnostics };
    });
    console.log(JSON.stringify(snapshot));
    for (const plugin of snapshot.plugins.filter(x => x.enabled)) assert.equal(plugin.status, "ready", `${plugin.name}: ${plugin.error}`);
    if (process.argv.includes("--background-shell")) {
      const result = await app.evaluate(async ({ app }) => {
        const path = process.mainModule.require("node:path");
        const manager = process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js")).getExtensionManager();
        const tools = JSON.parse(await manager.execute("extension_list_tools", "{}"));
        const tool = tools.find(x => x.id === "mcp:pwsh:execute_command");
        if (!tool || tools.some(x => x.id === "mcp:pwsh:start_console")) throw new Error("Background adapter is unavailable");
        const pipeline = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleCheck { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
@{ text = $var1; visible = [ConsoleCheck]::IsWindowVisible([ConsoleCheck]::GetConsoleWindow()) } | ConvertTo-Json -Compress`;
        const output = JSON.parse(await manager.execute("extension_call_tool", JSON.stringify({ id: tool.id,
          args_json: JSON.stringify({ pipeline, var1: "安装版后台中文脚本成功" }) })));
        const windows = process.mainModule.require(path.join(app.getAppPath(), "dist/main/control/windows.js"));
        return { ...output,
          native: await manager.execute("extension_call_tool", JSON.stringify({ id: tool.id,
            args_json: JSON.stringify({ pipeline: "cmd /c echo installed-native-output" }) })),
          builtIn: await windows.runShellCommand("Write-Output '内置后台命令成功'", "powershell") };
      });
      assert.equal(result.visible, false);
      assert.equal(result.text, "安装版后台中文脚本成功");
      assert.equal(result.builtIn, "内置后台命令成功");
      assert.equal(result.native, "installed-native-output");
      console.log("PASS installed built-in shell and extension dispatcher capture Chinese scripts and native CLI output without a visible console");
    }
    const free = snapshot.plugins.find(x => x.name === "dsh-our-free-model");
    assert.equal(free.toolCount, 2);
    const previous = app.windows();
    await app.evaluate(async ({ app }, id) => {
      const path = process.mainModule.require("node:path");
      const { getExtensionManager } = process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js"));
      await getExtensionManager().request("openPluginPanel", { id });
    }, free.id);
    const panel = app.windows().find(x => !previous.includes(x)) || await app.waitForEvent("window");
    await panel.locator(".ofm_shell").waitFor();
    await panel.waitForFunction(async () => (await (await fetch("/api/our-free-model/summary")).json()).channels?.state === "ready", undefined, { timeout: 20000 });
    const channel = await panel.evaluate(async () => {
      const response = await fetch("/_daisy/rpc", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "/api", endpoint: "channel-pack", payload: { method: "account.list", payload: { provider: "buddy" } } }) });
      const body = await response.json();
      return response.ok && body.ok && Array.isArray(body.value.accounts);
    });
    assert.equal(channel, true);
    if (process.argv.includes("--soak")) {
      await new Promise(resolve => setTimeout(resolve, 35000));
      const status = await app.evaluate(({ app }, id) => {
        const path = process.mainModule.require("node:path");
        return process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js"))
          .getExtensionManager().snapshot().plugins.find(x => x.id === id);
      }, free.id);
      assert.equal(status.status, "ready", status.error);
      assert.equal((await panel.evaluate(async () => (await (await fetch("/api/our-free-model/summary")).json()).channels.state)), "ready");
      console.log("PASS installed plugin stays ready with its SSE panel open beyond 30 seconds");
    }
    await panel.getByRole("tab", { name: /白嫖模型接入|Free channels/ }).click();
    await panel.getByText("WorkBuddy 国内版", { exact: true }).waitFor();
    const screenshot = path.resolve(__dirname, `../../work/installed-plugin-compat-${snapshot.version}/actual-installed-channels.png`);
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await panel.screenshot({ path: screenshot });
    if (process.argv.includes("--live-model")) {
      const success = await app.evaluate(async ({ app }, id) => {
        const path = process.mainModule.require("node:path");
        const manager = process.mainModule.require(path.join(app.getAppPath(), "dist/main/extensions/manager.js")).getExtensionManager();
        const list = JSON.parse(await manager.execute("extension_call_tool", JSON.stringify({ id: `plugin:${id}:dsh_list_models`, args_json: "{}" })));
        const model = list.find(x => /flash|chat|kimi/i.test(x.id)) || list[0];
        if (!model) throw new Error("No upstream models advertised");
        const response = JSON.parse(await manager.execute("extension_call_tool", JSON.stringify({ id: `plugin:${id}:dsh_generate_text`,
          args_json: JSON.stringify({ provider: model.provider, model: model.id, prompt: "用中文简短回复：插件宿主测试成功。" }) })));
        return typeof response.text === "string" && !!response.text.trim();
      }, free.id);
      assert.equal(success, true);
      console.log("PASS actual installed plugin upstream generation (synthetic prompt only)");
    }
    console.log("PASS actual installed plugin channel state, authenticated RPC and real panel");
    console.log("PASS real installed startup and enabled-plugin readiness");
  } finally {
    if (app) await app.close().catch(() => {});
    const child = spawn(executablePath, [], { cwd: path.dirname(executablePath), env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
