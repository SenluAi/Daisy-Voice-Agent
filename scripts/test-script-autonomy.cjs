const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const originalLoad = Module._load;
const originalFetch = global.fetch;
const realShell = process.argv.includes("--real-shell") && process.platform === "win32";
const executions = [];
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "daisy-script-autonomy-"));
let windows;
let failWrite = false;

Module._load = function (name, parent, isMain) {
  if (name === "electron") return { nativeImage: {} };
  if (name.endsWith("/utils/logger")) return { log() {}, logError() {} };
  if (name.endsWith("/config/env")) return { config: { llm: { apiKey: "test-only", baseUrl: "https://example.test", model: "test", thinkingEnabled: false } } };
  if (name.endsWith("/memory/shortTermMemory")) return { recordToolMemory() {} };
  if (name === "./screenSettler") return {};
  if (["./officecli", "./ffmpegManager", "./openExternal", "./windowsAppResolver"].includes(name) || name.endsWith("/windows/floatWindow")) return {};
  if (name.endsWith("/control/platform")) return { async executeTool(name, json) {
    executions.push({ name, json });
    if (name === "write_file" && failWrite) return JSON.stringify({ ok: false, error: { code: "FIXTURE_WRITE_FAILED", message: "fixture-write-failure" } });
    if (realShell) {
      windows ??= originalLoad.call(Module, require.resolve("../dist/main/control/windows.js"), parent, false);
      return windows.executeTool(name, json);
    }
    return "script-result-" + executions.length;
  } };
  if (name.endsWith("/extensions/manager")) return { extensionPrompt: () => "", getExtensionManager: () => ({ async execute(name, json, signal) {
    executions.push({ name, json });
    if (!realShell) return "plugin-result-" + executions.length;
    const { callBackgroundPowerShell } = require("../dist/main/extensions/powerShellMcp.js");
    return callBackgroundPowerShell("execute_command", JSON.parse(JSON.parse(json).args_json), {}, signal);
  } }) };
  return originalLoad.call(this, name, parent, isMain);
};

const { DeepSeekClient } = require("../dist/main/llm/deepseek.js");
const { MAX_TASK_ROUNDS, TASK_ROUND_LIMIT_MESSAGE } = require("../dist/main/automation/taskReporting.js");
function response(delta) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}
function call(name, args, id = "test-call") {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

async function main() {
  for (const name of ["run_shell_command", "extension_call_tool"]) {
    const before = executions.length;
    const start = performance.now();
    const client = new DeepSeekClient();
    let requests = 0, done, outcome;
    client.on("done", value => { done = value; });
    client.on("task_outcome", value => { outcome = value; });
    client.on("error", error => assert.fail(error));
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (++requests > 12) return response({ content: "All 12 debug iterations completed." });
      assert.ok(body.tools.some(tool => tool.function.name === name), `${name} removed before iteration ${requests}`);
      const command = `Write-Output 'debug-iteration-${requests}'`;
      const args = name === "run_shell_command" ? { command, shell: "powershell" }
        : { id: "mcp:fixture:execute_command", args_json: JSON.stringify({ pipeline: command }) };
      return response({ tool_calls: [{ index: 0, ...call(name, args, `debug-${requests}`) }] });
    };
    await client.sendMessage("Run and debug the script until its checks pass.");
    assert.equal(executions.length - before, 12, "all iterations must execute automatically");
    assert.equal(client.toolCallCounts.get(name), 12);
    assert.equal(requests, 13, "no approval or format-repair round is needed");
    assert.equal(outcome.status, "completed");
    assert.equal(done.display, "All 12 debug iterations completed.");
    const results = client.getConversation().filter(message => message.role === "tool");
    assert.equal(results.length, 12);
    if (realShell) for (const [index, result] of results.entries()) assert.equal(result.content, `debug-iteration-${index + 1}`);
    console.log(`PASS ${name}: 12 automatic ${realShell ? "real background" : "simulated"} calls, ${(performance.now() - start).toFixed(1)}ms`);
  }

  const fixture = path.join(temporary, "debug-script.cjs");
  const command = `& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}'`;
  for (const name of ["run_shell_command", "extension_call_tool"]) {
    const edited = new DeepSeekClient();
    const beforeEdit = executions.length;
    let editRequests = 0;
    global.fetch = async () => {
      const index = editRequests++;
      if (index >= 24) return response({ content: "All edited script versions verified." });
      const version = Math.floor(index / 2) + 1;
      const args = name === "run_shell_command" ? { command, shell: "powershell" }
        : { id: "mcp:fixture:execute_command", args_json: JSON.stringify({ pipeline: command }) };
      const tool = index % 2 === 0 ? call("write_file", { path: fixture, content: `process.stdout.write('version-${version}');` }, `edit-${version}`)
        : call(name, args, `verify-${version}`);
      return response({ tool_calls: [{ index: 0, ...tool }] });
    };
    let editResult;
    edited.on("done", value => { editResult = value; });
    edited.on("error", error => assert.fail(error));
    await edited.sendMessage("Edit the script and rerun the same debug command after each change.");
    assert.equal(executions.length - beforeEdit, 24, "successful edits allow rerunning the same command");
    assert.equal(edited.toolCallCounts.get(name), 12);
    assert.equal(editResult.display, "All edited script versions verified.");
    if (realShell) {
      const versions = edited.getConversation().filter(message => message.role === "tool" && /^version-\d+$/.test(message.content));
      assert.deepEqual(versions.map(result => result.content), Array.from({ length: 12 }, (_, index) => `version-${index + 1}`),
        JSON.stringify(edited.getConversation().filter(message => message.role === "tool")));
    }
    console.log(`PASS ${name}: 12 edit/retest cycles with the same ${realShell ? "real Node script" : "simulated script"} command`);
  }

  const repeated = new DeepSeekClient();
  repeated.visualTask.start("Debug script");
  const beforeRepeated = executions.length;
  let repeatedResult;
  for (let index = 0; index < 8; index++) {
    repeated.visualTask.beginTurn();
    [repeatedResult] = await repeated.executeToolCalls([call("run_shell_command", { command: "Write-Output repeat", shell: "powershell" })]);
  }
  assert.equal(executions.length - beforeRepeated, 7, "identical-command protection remains active");
  assert.equal(JSON.parse(repeatedResult.content).error.code, "EXACT_COMMAND_LOOP");
  failWrite = true;
  repeated.visualTask.beginTurn();
  const [failedWrite] = await repeated.executeToolCalls([call("write_file", { path: fixture, content: "unused" })]);
  assert.equal(JSON.parse(failedWrite.content).error.code, "FIXTURE_WRITE_FAILED");
  failWrite = false;
  repeated.visualTask.beginTurn();
  [repeatedResult] = await repeated.executeToolCalls([call("run_shell_command", { command: "Write-Output repeat", shell: "powershell" })]);
  assert.equal(JSON.parse(repeatedResult.content).error.code, "EXACT_COMMAND_LOOP", "failed edits must not reset loop protection");

  const permission = new DeepSeekClient();
  permission.originalUserRequest = "Debug a script";
  permission.visualTask.start(permission.originalUserRequest);
  const beforePermission = executions.length;
  const [denied] = await permission.executeToolCalls([call("delete_file", { path: "unrequested-file.txt" })]);
  assert.equal(JSON.parse(denied.content).error.kind, "permission_required");
  assert.equal(executions.length, beforePermission, "unrequested destructive actions remain gated");

  const limited = new DeepSeekClient();
  limited.visualTask.start("Report current task status");
  limited.toolCallCounts.set("web_search", 8);
  let requests = 0;
  global.fetch = async (_url, options) => {
    if (++requests === 1) return response({ tool_calls: [{ index: 0, ...call("web_search", { query: "fixture" }) }] });
    const correction = JSON.parse(options.body).messages.at(-1).content;
    assert.match(correction, /TOOL_CALL_LIMIT_REACHED/);
    assert.match(correction, /\u4e0d\u662f\u6743\u9650/);
    return response({ content: "This tool reached its task call limit." });
  };
  await limited.streamChat([]);
  assert.equal(requests, 2);
  assert.equal(executions.length, beforePermission, "limited tools cannot execute through format repair");

  const lastRound = new DeepSeekClient();
  lastRound.visualTask.start("Debug script");
  lastRound.chatLoopCount = MAX_TASK_ROUNDS - 1;
  lastRound.toolCallCounts.set("run_shell_command", MAX_TASK_ROUNDS - 1);
  let done;
  lastRound.on("done", value => { done = value; });
  requests = 0;
  global.fetch = async (_url, options) => {
    requests++;
    assert.ok(JSON.parse(options.body).tools.some(tool => tool.function.name === "run_shell_command"));
    return response({ tool_calls: [{ index: 0, ...call("run_shell_command", { command: "Write-Output last-round", shell: "powershell" }) }] });
  };
  await lastRound.streamChat([]);
  assert.equal(requests, 1, "round 201 is not requested");
  assert.ok(done.speech.startsWith(TASK_ROUND_LIMIT_MESSAGE));
  assert.equal(lastRound.visualTask.state.snapshot().outcome, "difficult");
  console.log("PASS quota classification, repeated-command guard, destructive-action gate and 200-round boundary; no live configuration writes.");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(temporary), /^daisy-script-autonomy-/);
  fs.rmSync(temporary, { recursive: true, force: true });
});
