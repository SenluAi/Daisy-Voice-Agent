const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const ts = require("typescript");
const originalLoad = Module._load;
const originalFetch = global.fetch;
let toolResult = "已执行后台命令";
Module._load = function (name, parent, isMain) {
  if (name === "electron") return { nativeImage: {} };
  if (name.endsWith("/utils/logger")) return { log() {}, logError() {} };
  if (name.endsWith("/config/env")) return { config: { llm: { apiKey: "test-only", baseUrl: "https://example.test", model: "test", thinkingEnabled: false } } };
  if (name.endsWith("/memory/shortTermMemory")) return { recordToolMemory() {} };
  if (name === "./screenSettler") return { async captureAutomationFrame() { return {}; } };
  if (name.endsWith("/control/platform")) return { async executeTool() { return toolResult; } };
  return originalLoad.call(this, name, parent, isMain);
};
const { describeStepProgress } = require("../dist/main/automation/taskReporting.js");
const { VisualTaskRuntime } = require("../dist/main/automation/visualTaskRuntime.js");
const { DeepSeekClient } = require("../dist/main/llm/deepseek.js");
const { createErrorEnvelope, serializeErrorEnvelope } = require("../dist/main/automation/errorEnvelope.js");
function response(delta) { return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`); }
async function main() {
  const cases = [
    ["desktop_click", { target: "登录按钮" }, "已点击坐标 (20, 30)", "点击“登录按钮”。"],
    ["desktop_click", { target: "Login" }, "OK", "点击“登录”。"],
    ["desktop_click", { target: "C:/secret/private.txt" }, "OK", "点击当前按钮。"],
    ["open_url", { url: "https://example.test/?token=secret" }, "已打开", "打开目标网站。"],
    ["open_url", {}, "页面正在加载", "页面正在加载。"],
    ["type_text", { text: "secret password" }, "已输入", "在当前输入框填写文字。"],
    ["desktop_scroll", { direction: "down" }, "OK", "向下滚动当前区域。"],
    ["press_keys", { keys: "Ctrl+W" }, "OK", "关闭当前页面。"],
    ["press_keys", { keys: "Ctrl+S" }, "OK", "保存当前内容。"],
    ["confirm_staged_attachment", {}, "CONFIRMED", "确认发送附件。"],
  ];
  for (const [tool, args, result, expected] of cases) {
    const report = describeStepProgress(tool, JSON.stringify(args), result);
    assert.equal(report, expected);
    assert.ok(report.length <= 40);
    assert.equal((report.match(/[。！？]/g) || []).length, 1);
    assert.doesNotMatch(report, /第\d+步|后台处理|正在继续|private|secret|password|CONFIRMED|坐标/);
  }
  for (const result of ["", "  \n", "桌面点击失败: blocked", "无法点击按钮", serializeErrorEnvelope(createErrorEnvelope("tool", "execution_failed", "FAILED", "failed"))]) {
    assert.equal(describeStepProgress("desktop_click", '{"target":"发送"}', result), undefined);
  }
  for (const tool of ["screen_snapshot", "get_frontmost_application"]) {
    assert.equal(describeStepProgress(tool, "{}", "已读取当前屏幕。\n前台应用：当前最前面的应用是：QQ.exe（标题：聊天）\n截图：C:/private/screen.png"), undefined);
  }
  const runtime = new VisualTaskRuntime();
  runtime.start("测试逐步汇报");
  for (let i = 0; i < 4; i++) {
    runtime.state.beginAction("run_shell_command", "{}");
    const verified = await runtime.verifyAction("run_shell_command", "{}", null, "已执行命令");
    assert.equal(verified.progressReport, "执行后台命令。", "first, second, third and fourth steps all report individually");
  }
  runtime.state.beginAction("run_shell_command", "{}");
  assert.equal((await runtime.verifyAction("run_shell_command", "{}", null, "")).progressReport, undefined);

  const client = new DeepSeekClient();
  let calls = 0;
  const progress = [];
  const acks = [];
  const finals = [];
  client.on("task_progress", (text) => {
    progress.push(text);
    return new Promise(() => {}); // A slow audio consumer must not hold up the next model/action round.
  });
  client.on("tool_ack", (text) => acks.push(text));
  client.on("done", (result) => finals.push(result));
  global.fetch = async () => {
    calls++;
    if (calls <= 2) return response({ content: "I will write a file in C:/private", tool_calls: [{ index: 0, id: `file-${calls}`, function: { name: "create_file", arguments: JSON.stringify({ path: `C:/private/test-${calls}.txt` }) } }] });
    return response({ content: "处理完成。" });
  };
  await client.sendMessage("执行后台任务");
  assert.deepEqual(progress, ["保存目标文件。"], "two important operations produce just one report");
  assert.deepEqual(acks, [], "raw model acknowledgements must not overlap step progress");
  assert.equal(finals[0].speech, "处理完成。");
  assert.equal(calls, 3, "next model round and final result proceed while progress audio is unresolved");
  toolResult = "";
  const empty = new DeepSeekClient();
  calls = 0;
  empty.on("task_progress", () => assert.fail("empty tool result must remain silent"));
  await empty.sendMessage("执行后台任务");

  const cadence = new DeepSeekClient();
  cadence.visualTask.start("测试重要进度");
  const reports = [];
  cadence.on("task_progress", (text) => reports.push(text));
  cadence.reportImportantProgress("open_url", "打开目标网站。");
  cadence.reportImportantProgress("screen_snapshot", undefined);
  cadence.reportImportantProgress("list_directory", "查看当前目录的文件。");
  cadence.reportImportantProgress("create_file", undefined);
  assert.equal(reports.length, 0, "inspection and missing results cannot advance cadence");
  cadence.reportImportantProgress("type_text", "在当前输入框填写文字。");
  assert.deepEqual(reports, ["在当前输入框填写文字。"]);
  cadence.reportImportantProgress("open_contact_chat", "搜索目标联系人。");
  cadence.reportImportantProgress("press_keys", "执行当前快捷键操作。");
  assert.equal(reports.length, 1, "minor second action waits for the third action");
  cadence.reportImportantProgress("copy_file_to_clipboard", "暂存文件附件。");
  assert.equal(reports.at(-1), "搜索目标联系人。", "third action selects only the important operation, not all three");
  for (let i = 0; i < 3; i++) cadence.reportImportantProgress("run_shell_command", "执行后台命令。");
  assert.equal(reports.length, 2, "a block of minor operations stays silent");
  cadence.reportImportantProgress("open_url", "页面正在加载。");
  cadence.reportImportantProgress("press_keys", "执行当前快捷键操作。");
  cadence.reportImportantProgress("copy_file_to_clipboard", "暂存文件附件。");
  assert.equal(reports.at(-1), "打开目标网站。", "buffered loading status cannot be repeated as current");
  cadence.reportImportantProgress("press_keys", "执行当前快捷键操作。");
  cadence.reportImportantProgress("open_url", "页面正在加载。");
  assert.equal(reports.at(-1), "页面正在加载。", "current verified loading status is still allowed");
  cadence.reportImportantProgress("confirm_staged_attachment", "确认发送附件。");
  const beforeFinish = reports.length;
  cadence.finishTask("completed");
  assert.equal(reports.length, beforeFinish, "remaining progress is discarded, not flushed at completion");
  assert.equal(cadence.pendingImportantProgress, undefined);
  assert.equal(cadence.progressActionCount, 0);
  for (const tool of ["screen_snapshot", "get_frontmost_application"]) {
    const observation = new DeepSeekClient();
    calls = 0;
    toolResult = "已读取当前屏幕。前台应用是QQ";
    observation.on("task_progress", () => assert.fail("internal observation must not report progress"));
    observation.on("tool_ack", () => assert.fail("internal observation must not announce a model acknowledgement"));
    global.fetch = async () => ++calls === 1 ? response({ content: "查看当前屏幕。", tool_calls: [{ index: 0, id: "observation", function: { name: tool, arguments: "{}" } }] }) : response({ content: "当前任务结果已确认。" });
    await observation.sendMessage("继续执行当前任务");
    assert.equal(calls, 2, "observation still executes and the task continues normally");
  }

  // Execute the real handler without booting Electron or touching the microphone.
  const source = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const handler = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleLLMRequest");
  assert.ok(handler);
  const events = [];
  class Client extends EventEmitter {
    async sendMessage() {}
    getConversation() { return []; }
  }
  const context = {
    DeepSeekClient: Client, currentSessionId: 1, automationTaskInProgress: 0,
    ensureConversation: () => ({ getMessages: () => [], setMessages() {} }),
    stopAutoHideTimer() {}, armTaskStopListening() {}, log() {}, logError() {},
    updateState(state, message) { events.push([state, message]); },
    announceToUser(message) { events.push(["progress", message]); return new Promise(() => {}); },
    cancelAnnouncements() { events.push(["cancel"]); },
    addChatEntry() {}, splitForPipeline: (text) => [text],
    speakResponse(text) { events.push(["final", text]); }, synthesizeRemaining() {},
    finishTurnWithContinuousWindow() {}, startAutoHideTimer() {}, isSpeaking: false,
    config: { wakeWord: { startListeningTimeoutMs: 30000 } },
  };
  const script = ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(script + '\nhandleLLMRequest("测试任务");', context);
  context.llmClient.emit("task_progress", "点击登录按钮。");
  assert.deepEqual(events.filter(([name]) => name === "progress"), [["progress", "点击登录按钮。"]], "eligible progress is announced immediately, not held until another report");
  context.llmClient.emit("task_progress", "向下滚动页面。");
  assert.deepEqual(events.filter(([name]) => name === "progress").map((item) => item[1]), ["点击登录按钮。", "向下滚动页面。"]);
  context.llmClient.emit("tool_start", "desktop_scroll");
  assert.equal(context.automationTaskInProgress, 1, "next action starts even with unresolved synthesis/playback");
  context.llmClient.emit("tool_end", "desktop_scroll");
  context.llmClient.emit("task_outcome", { status: "completed" });
  context.llmClient.emit("done", { display: "文件已发送。", speech: "文件已发送。" });
  assert.equal(events.at(-1)[0], "final");
  assert.equal(events.filter(([name]) => name === "cancel").length, 2);
  const previous = events.length;
  context.currentSessionId++;
  context.llmClient.emit("task_progress", "旧任务进度。");
  assert.equal(events.length, previous, "stale sessions cannot announce progress");
  console.log("PASS: important progress every 2-3 valid actions, minor/inspection/no-result silence, no stale loading status, nonblocking speech, final-result priority and session isolation.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
});
