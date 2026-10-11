const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");
const originalLoad = Module._load;
const originalFetch = global.fetch;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-automation-test-"));
let captures = 0;
let saves = 0;
let decodes = 0;
let encodes = 0;
let toolsExecuted = 0;
let drift = 0.2;
let targetDrift = 0.3;
let geometry = "test-layout";
let verificationFails = false;
const frame = () => ({ dataUrl: "data:image/png;base64,AA==", width: 1800, height: 1000, geometry, capturedAt: Date.now(), sample: Buffer.alloc(160 * 90 * 4) });
const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 1800, height: 1000 }),
  resize() { return this; },
  toBitmap: () => Buffer.alloc(160 * 90 * 4),
  toJPEG() { encodes++; return Buffer.from("jpeg"); },
};
async function saveScreenCapture() {
  const file = path.join(directory, `screen-${++saves}.png`);
  await fs.promises.writeFile(file, Buffer.from("synthetic-screen"));
  return { path: file, width: 1800, height: 1000 };
}
Module._load = function (name, parent, isMain) {
  if (name === "electron") return { nativeImage: { createFromBuffer() { decodes++; return image; }, createFromDataURL: () => image } };
  if (name.endsWith("/utils/logger")) return { log() {} };
  if (name.endsWith("/config/env")) return { config: { llm: { apiKey: "test-only", baseUrl: "https://example.test", model: "test", thinkingEnabled: false } } };
  if (name.endsWith("/memory/shortTermMemory")) return { recordToolMemory() {} };
  if (name.endsWith("/windows/floatWindow")) return { getFloatWindow: () => null };
  if (name.endsWith("/windows/panelWindow")) return { getPanelWindow: () => null };
  if (name.endsWith("/vision/screenCapture")) return {
    saveScreenCapture,
    async capturePrimaryScreenDataUrl() { captures++; return frame(); },
  };
  if (name === "./screenSettler") return {
    async captureAutomationFrame() { captures++; return frame(); },
    calculateScreenChangeRatio: () => drift,
    calculateTargetChangeRatio: () => targetDrift,
    measureCoordinateChange: (before, after) => ({ globalRatio: drift, targetRatio: targetDrift, contextRatio: targetDrift,
      reason: before.geometry !== after.geometry ? "display_layout_changed" : targetDrift > 0.12 ? "target_changed" : null }),
    async waitForScreenStable() {
      if (verificationFails) throw new Error("capture failed");
      return { frame: frame(), screenshotPath: (await saveScreenCapture()).path, settled: false, changeRatio: drift, elapsedMs: 250 };
    },
  };
  if (name.endsWith("/control/platform")) return { async executeTool() { toolsExecuted++; return "已执行"; } };
  return originalLoad.call(this, name, parent, isMain);
};
const { DeepSeekClient } = require("../dist/main/llm/deepseek.js");
const { waitForModelIO } = require("../dist/main/automation/modelWait.js");
const { waitForScreenStable } = require("../dist/main/automation/screenSettler.js");
function response(content) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
}
async function main() {
  const results = [];
  const measured = async (name, run) => {
    const start = performance.now();
    await run();
    results.push({ name, elapsedMs: +(performance.now() - start).toFixed(2) });
  };
  await measured("fresh-screen-recovery-and-cache", async () => {
    const client = new DeepSeekClient();
    client.visualTask.start("打开目标按钮");
    assert.equal(JSON.parse(client.normalizeToolResult("desktop_click", "桌面点击失败: input blocked")).ok, false);
    for (const name of ["desktop_double_click", "desktop_right_click", "desktop_scroll", "desktop_drag"]) {
      const definition = require("../dist/main/llm/tools.js").availableTools.find((tool) => tool.function.name === name);
      const args = { x: 20, y: 30, end_x: 40, end_y: 50, screenshot_width: 1800, screenshot_height: 1000, direction: "down", target: "可见目标" };
      assert.ok(definition);
      assert.equal(client.validateModelOutput("", [{ id: name, function: { name, arguments: JSON.stringify(args) } }]), null);
    }
    client.visualTask.lastObservation = frame();
    const result = await client.executeToolCalls([{ id: "click", function: { name: "desktop_click", arguments: JSON.stringify({ x: 20, y: 30, screenshot_width: 1800, screenshot_height: 1000, target: "目标按钮" }) } }]);
    assert.equal(toolsExecuted, 0, "changed screen must prevent the click");
    assert.equal(captures, 1);
    assert.equal(saves, 1, "reuse the already-captured live frame");
    assert.match(JSON.parse(result[0].content).error.correction, /无需重复/);
    const first = await client.withSnapshotContext([], result);
    const second = await client.withSnapshotContext([], result);
    assert.equal(first.at(-1).content[1].image_url.url, second.at(-1).content[1].image_url.url);
    assert.match(first.at(-1).content[0].text, /1800x1000/);
    assert.equal(decodes, 1);
    assert.equal(encodes, 1);
    assert.equal(client.lastToolResults, result, "structured error screenshots must be retained for repair");
    await fs.promises.utimes(client.screenshotCache.path, new Date(), new Date(Date.now() + 1000));
    await client.withSnapshotContext([], result);
    assert.equal(decodes, 2, "changed files invalidate the cache");
    await assert.rejects(client.withSnapshotContext([], [{ content: `截图：${path.join(directory, "missing.png")}\n` }]), /暂停操作/);
    // A subsequent action on an unchanged live screen is allowed, with one-action-per-turn protection intact.
    drift = 0;
    targetDrift = 0;
    client.visualTask.beginTurn();
    assert.equal(await client.visualTask.validateCoordinateAction("desktop_click", '{"x":20,"y":30,"screenshot_width":1800,"screenshot_height":1000}'), null);
    targetDrift = 0.3;
    assert.match(await client.visualTask.validateCoordinateAction("desktop_click", '{"x":20,"y":30,"screenshot_width":1800,"screenshot_height":1000}'), /未执行/);
    targetDrift = 0;
    geometry = "changed-dpi";
    assert.match(await client.visualTask.validateCoordinateAction("desktop_click", '{"x":20,"y":30,"screenshot_width":1800,"screenshot_height":1000}'), /未执行/);
    const capturesBeforeInvalid = captures;
    assert.match(await client.visualTask.validateCoordinateAction("desktop_click", '{"x":-1,"y":30,"screenshot_width":1800,"screenshot_height":1000}'), /未执行/);
    assert.equal(captures, capturesBeforeInvalid);
    assert.equal(client.visualTask.reserveAction("desktop_click"), null);
    assert.match(client.visualTask.reserveAction("type_text"), /已经执行/);
  });
  await measured("rejected-preflight-loop-recovery", async () => {
    const client = new DeepSeekClient();
    client.visualTask.start("点击可见的登录按钮");
    client.originalUserRequest = "点击可见的登录按钮";
    client.visualTask.lastObservation = frame();
    const initialTools = toolsExecuted;
    targetDrift = 0.3;
    let restarts = 0;
    for (let index = 0; index < 9; index++) {
      client.visualTask.beginTurn();
      const result = await client.executeToolCalls([{ id: `reject-${index}`, function: { name: "desktop_click", arguments: '{"x":100,"y":100,"screenshot_width":1800,"screenshot_height":1000,"target":"登录"}' } }]);
      const error = JSON.parse(result[0].content);
      assert.equal(error.error.code, "STALE_SCREEN_COORDINATES");
      if (client.pendingLoopDecision?.kind === "soft_restart") restarts++;
      const next = await client.prepareNextTurn(result);
      assert.equal(next.allowTools, index < 8);
      if (index === 8) assert.equal(error.error.retryable, false);
    }
    assert.equal(restarts, 1);
    assert.equal(client.visualTask.state.snapshot().outcome, "difficult");
    assert.equal(toolsExecuted, initialTools, "rejected preflights must never reach the input executor");
    targetDrift = 0;
  });
  await measured("restart-preserves-checkpoint-and-guards", async () => {
    const client = new DeepSeekClient();
    client.originalUserRequest = "把会议纪要发给北辰后整理文件";
    client.visualTask.start(client.originalUserRequest);
    client.visualTask.state.beginAction("create_file", JSON.stringify({ path: "C:/桌面/会议纪要.txt" }));
    client.visualTask.state.completeStep("会议纪要已创建");
    client.pendingLoopDecision = { kind: "soft_restart", reason: "没有进展" };
    client.commandExecutionCounts.set("same-action", 6);
    const next = await client.prepareNextTurn([]);
    assert.match(JSON.stringify(next.messages), /会议纪要已创建/);
    assert.match(JSON.stringify(next.messages), /不要重做已成功/);
    assert.equal(client.commandExecutionCounts.get("same-action"), 6);
    verificationFails = true;
    const verification = await client.visualTask.verifyAction("desktop_click", "{}", frame(), "已点击");
    assert.match(verification.feedback, /不能确认结果.*不要重复/);
    verificationFails = false;
  });
  await measured("tool-budget-and-stream-done", async () => {
    const client = new DeepSeekClient();
    client.visualTask.start("复杂任务");
    client.visualTask.state.beginAction("write_file", "{}");
    client.visualTask.state.completeStep("写入成功");
    client.toolCallCounts.set("desktop_click", 8);
    client.toolCallCounts.set("screen_snapshot", 8);
    let cancelled = 0;
    global.fetch = async (_url, options) => {
      const names = JSON.parse(options.body).tools.map((t) => t.function.name);
      assert.ok(names.includes("desktop_click"));
      assert.ok(names.includes("screen_snapshot"));
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "已处理当前目标。" } }] })}\n\ndata: [DONE]\n\n`)); },
        cancel() { cancelled++; },
      }));
    };
    await client.streamChat([{ role: "user", content: "复杂任务" }]);
    assert.equal(cancelled, 1, "DONE terminates the stream without waiting for the server to close it");
  });
  await measured("timeout-cancel-without-retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(waitForModelIO(() => { calls++; return new Promise(() => {}); }, controller, 25), /不会自动重试/);
    assert.equal(calls, 1);
    assert.ok(controller.signal.aborted);
    const ordinary = new AbortController();
    assert.equal(await waitForModelIO(async () => "ok", ordinary, 10), "ok");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ordinary.signal.aborted, false, "success clears the timer");
    const userStop = new AbortController();
    const operation = waitForModelIO(() => new Promise((_, reject) => userStop.signal.addEventListener("abort", () => reject(new Error("user stop")), { once: true })), userStop, 500);
    userStop.abort();
    await assert.rejects(operation, /user stop/);
    assert.equal(toolsExecuted, 0);
  });
  await measured("interleaved-tool-arguments-and-truncation", async () => {
    const client = new DeepSeekClient();
    client.visualTask.start("检查文件");
    let calls = 0;
    let received;
    client.executeToolCalls = async (tools) => {
      received = tools;
      return tools.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "检查结果" }));
    };
    global.fetch = async () => {
      if (++calls > 1) return response("已检查文件。");
      const deltas = [
        { tool_calls: [
          { index: 0, id: "front", function: { name: "get_frontmost_application", arguments: "{" } },
          { index: 1, id: "file", function: { name: "read_file", arguments: '{"path":' } },
        ] },
        { tool_calls: [{ index: 0, function: { arguments: "}" } }, { index: 1, function: { arguments: '"C:/真实文件.txt"}' } }] },
      ];
      return new Response(deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n");
    };
    await client.streamChat([{ role: "user", content: "检查文件" }]);
    assert.equal(received.length, 2);
    assert.deepEqual(JSON.parse(received[0].function.arguments), {});
    assert.deepEqual(JSON.parse(received[1].function.arguments), { path: "C:/真实文件.txt" });
    const incomplete = new DeepSeekClient();
    incomplete.visualTask.start("操作");
    const delta = { tool_calls: [{ index: 0, id: "clock", function: { name: "get_current_time", arguments: "{}" } }] };
    global.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    await assert.rejects(incomplete.streamChat([]), /中途断开/);
    global.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
    await assert.rejects(incomplete.streamChat([]), /未完整结束/);
    assert.equal(toolsExecuted, 0);
    const blocked = new DeepSeekClient();
    blocked.visualTask.start("仅说明障碍");
    calls = 0;
    global.fetch = async () => ++calls === 1 ? new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`) : response("操作已暂停。");
    await blocked.streamChat([], { allowTools: false });
    assert.equal(toolsExecuted, 0, "a model cannot bypass disabled tools");
  });
  await measured("model-failure-does-not-go-blind", async () => {
    const client = new DeepSeekClient();
    client.visualTask.start("视觉任务");
    let calls = 0;
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }];
    global.fetch = async () => { calls++; return new Response("service unavailable", { status: 503 }); };
    await assert.rejects(client.streamChat(messages), /503/);
    assert.equal(calls, 1, "503 must not trigger text-only fallback or automatic replay");
    calls = 0;
    global.fetch = async (_url, options) => {
      calls++;
      if (calls === 1) return new Response("image input is not supported", { status: 400 });
      assert.equal(JSON.parse(options.body).tools, undefined);
      return response("模型不支持图像，操作已暂停。");
    };
    await client.streamChat(messages);
    assert.equal(client.visualTask.state.snapshot().outcome, "needs_user");
    assert.equal(toolsExecuted, 0);
  });
  await measured("single-250ms-post-action-sample", async () => {
    const oldCaptures = captures;
    const oldSaves = saves;
    const start = performance.now();
    const result = await waitForScreenStable(frame());
    assert.ok(performance.now() - start >= 240);
    assert.equal(captures - oldCaptures, 1);
    assert.equal(saves - oldSaves, 1);
    assert.equal(result.probes, 1);
    assert.equal(result.settled, false);
    const stoppedCaptures = captures;
    await assert.rejects(waitForScreenStable(frame(), { minWaitMs: 1, shouldStop: () => true }), /取消/);
    assert.equal(captures, stoppedCaptures);
  });
  console.log(JSON.stringify({ scope: "local simulated model/tools; real timers and filesystem; no QQ messages sent", results }, null, 2));
  console.log("PASS: fresh-screen reuse, cache and dimensions, checkpoint, tool budget, stream completion, timeout/cancel, vision failure and single-sample verification.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});
