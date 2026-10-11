const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
const originalFetch = global.fetch;
let toolExecutions = 0;

Module._load = function (name, parent, isMain) {
  if (name === "electron") return { nativeImage: {} };
  if (name.endsWith("/utils/logger")) return { log() {}, logError() {} };
  if (name.endsWith("/config/env")) return { config: { llm: { apiKey: "test-only", baseUrl: "https://example.test", model: "test", thinkingEnabled: false } } };
  if (name.endsWith("/memory/shortTermMemory")) return { recordToolMemory() {}, buildShortTermMemoryContext() { return ""; } };
  if (name === "./screenSettler") return {};
  if (name.endsWith("/control/platform")) return { async executeTool(name) { toolExecutions++; return name === "set_timer" ? "已设置60秒倒计时" : "当前时间为十点"; } };
  return originalLoad.call(this, name, parent, isMain);
};

const { DeepSeekClient } = require("../dist/main/llm/deepseek.js");
const { VisualTaskRuntime } = require("../dist/main/automation/visualTaskRuntime.js");
const { MAX_TASK_ROUNDS, TASK_ROUND_LIMIT_MESSAGE, describeToolOutcome, summarizeTaskProgress } = require("../dist/main/automation/taskReporting.js");
const { createErrorEnvelope, serializeErrorEnvelope } = require("../dist/main/automation/errorEnvelope.js");

function response(delta) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}

function startClient(count) {
  const client = new DeepSeekClient();
  client.originalUserRequest = "把会议纪要发给北辰";
  client.visualTask.start(client.originalUserRequest);
  client.chatLoopCount = count;
  return client;
}

async function main() {
  assert.equal(MAX_TASK_ROUNDS, 200);
  assert.match(TASK_ROUND_LIMIT_MESSAGE, /已达200轮.*自动停止.*继续执行/);
  assert.equal(describeToolOutcome("run_shell_command", "{}", "已找到会议纪要.txt\nC:\\private\\file.txt"), "已找到会议纪要.txt");
  assert.doesNotMatch(describeToolOutcome("run_shell_command", "{}", "C:\\private\\file.txt"), /private|后台处理|继续执行任务/);
  assert.match(describeToolOutcome("create_file", '{"path":"C:\\\\桌面\\\\会议纪要.txt"}', ""), /会议纪要\.txt/);
  assert.match(describeToolOutcome("run_shell_command", "null", ""), /未返回/);
  assert.match(describeToolOutcome("create_file", "{}", serializeErrorEnvelope(createErrorEnvelope("tool", "execution_failed", "FAILED", "无法写入文件"))), /无法写入/);
  assert.doesNotMatch(describeToolOutcome("run_shell_command", "{}", "已完成一项后台处理，正在继续执行任务。"), /已完成一项后台处理|继续执行任务/);

  const runtime = new VisualTaskRuntime();
  runtime.start("整理文件");
  let progress;
  for (let i = 0; i < 3; i++) {
    runtime.state.beginAction("run_shell_command", "{}");
    progress = await runtime.verifyAction("run_shell_command", "{}", null, `已找到第${i + 1}个目标文件`);
    assert.equal(progress.progressReport, "执行后台命令。", "runtime generates a candidate; the client filters importance and cadence");
  }
  assert.doesNotMatch(progress.progressReport, /第1个目标文件.*第2个目标文件.*第3个目标文件/);
  assert.doesNotMatch(progress.progressReport, /后台处理|继续执行任务/);
  assert.equal(summarizeTaskProgress([]), "");

  let requests = 0;
  global.fetch = async () => {
    requests++;
    return response({ tool_calls: [{ index: 0, id: "clock", function: { name: "get_current_time", arguments: "{}" } }] });
  };
  const at199 = startClient(199);
  at199.visualTask.state.beginAction("create_file", '{"path":"会议纪要.txt"}');
  at199.visualTask.state.completeStep("已创建会议纪要.txt");
  let done;
  let outcome;
  let errors = 0;
  at199.on("done", (value) => { done = value; });
  at199.on("task_outcome", (value) => { outcome = value; });
  at199.on("error", () => { errors++; });
  await at199.streamChat([{ role: "user", content: at199.originalUserRequest }]);
  assert.equal(requests, 1, "round 200 is allowed; request 201 must not be sent");
  assert.equal(toolExecutions, 1);
  assert.equal(at199.chatLoopCount, 200);
  assert.equal(outcome.status, "difficult");
  assert.equal(errors, 0, "limit warning must use the final TTS channel, not the unspoken error channel");
  assert.ok(done.speech.startsWith(TASK_ROUND_LIMIT_MESSAGE));
  assert.match(done.speech, /已创建会议纪要\.txt.*尚未确认完成/);
  assert.ok(at199.getConversation().slice(-2).some((m) => m.content.includes('原始目标："把会议纪要发给北辰"')));

  requests = 0;
  const already200 = startClient(200);
  already200.on("done", () => {});
  await already200.streamChat([]);
  assert.equal(requests, 0);
  assert.equal(toolExecutions, 1);

  global.fetch = async () => { requests++; return response({ content: "已查询当前时间。" }); };
  const normal200 = startClient(199);
  normal200.on("done", (value) => { done = value; });
  normal200.on("task_outcome", (value) => { outcome = value; });
  await normal200.streamChat([{ role: "user", content: "查询时间" }]);
  assert.equal(normal200.chatLoopCount, 200);
  assert.equal(outcome.status, "completed", "a final answer on round 200 is still a valid completion");
  assert.doesNotMatch(done.speech, /步骤过多/);

  const resumed = new DeepSeekClient(at199.getConversation());
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.messages.some((m) => typeof m.content === "string" && m.content.includes('原始目标："把会议纪要发给北辰"')));
    return response({ content: "继续从会议纪要已创建的进度处理。" });
  };
  await resumed.sendMessage("继续执行");
  assert.equal(resumed.chatLoopCount, 1, "explicit continuation starts a new bounded run");
  assert.equal(resumed.originalUserRequest, "把会议纪要发给北辰", "continuation keeps the original goal for later limits and safety checks");
  const unrelated = new DeepSeekClient(at199.getConversation());
  assert.equal(unrelated.resolveTaskRequest("打开浏览器"), "打开浏览器");

  assert.equal(at199.validateModelOutput("已完成一项后台处理，正在继续执行任务。", []).error.code, "VAGUE_TASK_RESULT");
  assert.equal(at199.validateModelOutput("会议纪要已创建，尚未发送给北辰。", []), null);
  assert.equal(new DeepSeekClient().validateModelOutput("已完成当前步骤", []), null, "ordinary chat must not enter task-result correction");

  requests = 0;
  global.fetch = async () => {
    requests++;
    return response({ tool_calls: [{ index: 0, id: "timer", function: { name: "set_timer", arguments: '{"seconds":60}' } }] });
  };
  const shortTask = new DeepSeekClient();
  shortTask.on("done", (value) => { done = value; });
  shortTask.on("silent_done", () => assert.fail("short tasks should report their actual result"));
  await shortTask.sendMessage("设置60秒倒计时");
  assert.equal(requests, 1, "reporting a known tool result needs no extra model round");
  assert.match(done.speech, /已设置60秒倒计时/);

  const corrected = startClient(0);
  corrected.visualTask.state.beginAction("create_file", '{}');
  corrected.visualTask.state.completeStep("已创建会议纪要.txt");
  requests = 0;
  global.fetch = async (_url, options) => {
    requests++;
    if (requests === 1) return response({ content: "已完成一项后台处理，正在继续执行任务。" });
    assert.match(JSON.parse(options.body).messages.at(-1).content, /实际任务结果|具体结果/);
    return response({ content: "会议纪要已创建，尚未发送给北辰。" });
  };
  corrected.on("done", (value) => { done = value; });
  await corrected.streamChat([{ role: "user", content: corrected.originalUserRequest }]);
  assert.equal(requests, 2);
  assert.equal(done.speech, "会议纪要已创建，尚未发送给北辰。");
  console.log("PASS: 200-round boundary, no round 201, main TTS warning, resumable context, actual progress and final-result validation.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
});
