const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { commandScript, runBackgroundPowerShell, findPowerShell } = require("../dist/main/control/backgroundPowerShell");
const { McpManager } = require("../dist/main/extensions/mcp");
const { backgroundPowerShellTools, isPowerShellMcp, callBackgroundPowerShell } = require("../dist/main/extensions/powerShellMcp");

(async () => {
  if (process.platform !== "win32") return console.log("SKIP Windows background PowerShell");
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "daisy-background-"));
  const signal = new AbortController().signal;
  try {
    const config = { command: "C:\\Modules\\PowerShell.MCP.Proxy.exe", cwd: temporary, env: { FIXTURE_ENV: "isolated" } };
    assert.equal(isPowerShellMcp(config), true);
    assert.equal(isPowerShellMcp({ command: "unrelated.exe" }), false);
    const tools = backgroundPowerShellTools(["execute_command", "get_current_location", "start_console", "cancel", "wait_for_completion", "close_console"].map(name => ({ id: name, name, inputSchema: {} })));
    assert.deepEqual(tools.map(x => x.name), ["execute_command", "get_current_location"]);
    assert.doesNotMatch(tools[0].description, /primary tool|persistent pwsh/);
    const literal = "中文 '引号' $变量 `原文`\n第二行";
    const output = JSON.parse(await callBackgroundPowerShell("execute_command", {
      pipeline: "@{ literal = $var1; cwd = (Get-Location).Path; env = $env:FIXTURE_ENV; leak = $env:DEEPSEEK_API_KEY } | ConvertTo-Json -Compress", var1: literal,
    }, config, signal));
    assert.equal(output.literal, literal);
    assert.equal(fs.statSync(output.cwd, { bigint: true }).ino, fs.statSync(temporary, { bigint: true }).ino);
    assert.equal(output.env, "isolated");
    assert.equal(output.leak, null);
    const native = await callBackgroundPowerShell("execute_command", {
      pipeline: "& $var1 --version\ncmd /c echo native-command-output", var1: process.execPath,
    }, config, signal);
    assert.match(native, /v\d+\.\d+\.\d+/);
    assert.match(native, /native-command-output/);
    await assert.rejects(callBackgroundPowerShell("execute_command", { pipeline: "cmd /c exit 7" }, config, signal), error => error.code === 7);
    for (const executable of new Set(["powershell.exe", findPowerShell()])) {
      const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HiddenCheck { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
@{ text = '后台中文识别测试'; visible = [HiddenCheck]::IsWindowVisible([HiddenCheck]::GetConsoleWindow()) } | ConvertTo-Json -Compress`;
      const result = JSON.parse((await runBackgroundPowerShell(commandScript(script), { executable })).stdout);
      assert.equal(result.text, "后台中文识别测试"); assert.equal(result.visible, false);
    }
    const streams = await runBackgroundPowerShell("Write-Output 'stdout'; [Console]::Error.WriteLine('stderr')");
    assert.match(streams.stdout, /stdout/); assert.match(streams.stderr, /stderr/);
    await assert.rejects(runBackgroundPowerShell(commandScript("throw 'fixture-failure'")), /fixture-failure/);
    await assert.rejects(runBackgroundPowerShell(commandScript("cmd /c exit 7")), error => error.code === 7);
    await assert.rejects(callBackgroundPowerShell("execute_command", { pipeline: "Write-Output ok", timeout_seconds: 0 }, config, signal), /timeout/);
    await assert.rejects(callBackgroundPowerShell("start_console", {}, config, signal), /disabled/);
    const abort = new AbortController();
    const running = runBackgroundPowerShell("Start-Sleep -Seconds 30", { signal: abort.signal });
    setTimeout(() => abort.abort(), 500);
    await assert.rejects(running, { name: "AbortError" });
    await assert.rejects(runBackgroundPowerShell("Start-Sleep -Seconds 30", { timeout: 500 }), { name: "TimeoutError" });
    console.log("PASS hidden PS5/PS7, Chinese/literal variables, isolated env, native CLI output/exit codes, timeout and cancellation");
    if (process.argv.includes("--live-mcp")) {
      const root = path.join(process.env.APPDATA, "Daisy/extensions");
      const hash = fs.readFileSync(path.join(root, "mcp.json"));
      const manager = new McpManager(root);
      try {
        await manager.start();
        const tool = manager.listTools().find(x => x.name === "execute_command");
        assert.ok(tool); assert.equal(manager.listTools().some(x => x.name === "start_console"), false);
        assert.equal(await manager.callTool(tool.id, { pipeline: "Write-Output '真实MCP后台调用成功'" }), "真实MCP后台调用成功");
        assert.deepEqual(fs.readFileSync(path.join(root, "mcp.json")), hash);
        console.log("PASS actual configured PowerShell MCP uses Daisy background runner without config changes");
      } finally { await manager.close(); }
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
