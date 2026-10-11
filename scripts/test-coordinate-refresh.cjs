const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
let liveFrame;
let captures = 0;
let saves = 0;
const logs = [];
Module._load = function (name, parent, isMain) {
  if (name === "electron") return {};
  if (name.endsWith("/utils/logger")) return { log: (message) => logs.push(message) };
  if (name.endsWith("/windows/floatWindow") || name.endsWith("/windows/panelWindow")) return {};
  if (name.endsWith("/vision/screenCapture")) return { async saveScreenCapture() { saves++; return { path: "test-refresh.png" }; } };
  if (name === "./screenSettler") {
    const actual = originalLoad.call(this, name, parent, isMain);
    return { ...actual, async captureAutomationFrame() { captures++; return liveFrame; }, async waitForScreenStable() {
      return { frame: liveFrame, screenshotPath: "test-verify.png", changeRatio: 0.5, settled: false, elapsedMs: 250 };
    } };
  }
  return originalLoad.call(this, name, parent, isMain);
};
const frame = () => ({ width: 800, height: 600, bitmap: Buffer.alloc(800 * 600 * 4), sample: Buffer.alloc(160 * 90 * 4),
  dataUrl: "data:image/png;base64,AA==", geometry: "same-layout", capturedAt: Date.now() });
function fillRect(image, x, y, width, height) {
  for (let row = y; row < y + height; row++) image.bitmap.fill(255, (row * image.width + x) * 4, (row * image.width + x + width) * 4);
}
async function main() {
  const { VisualTaskRuntime } = require("../dist/main/automation/visualTaskRuntime.js");
  const { measureCoordinateChange } = require("../dist/main/automation/screenSettler.js");
  const before = frame();
  liveFrame = frame();
  liveFrame.sample.fill(255);
  fillRect(liveFrame, 0, 0, 150, 600);
  const args = JSON.stringify({ x: 400, y: 300, screenshot_width: 800, screenshot_height: 600 });
  const runtime = new VisualTaskRuntime();
  runtime.start("点击可见的按钮");
  runtime.lastObservation = before;
  assert.equal(measureCoordinateChange(before, liveFrame, [400, 300]).reason, null);
  assert.equal(await runtime.validateCoordinateAction("desktop_click", args), null, "background motion must not veto a stable target");
  assert.equal(saves, 0, "no pointless refresh or extra model turn for background motion");
  assert.equal(captures, 1);
  fillRect(liveFrame, 325, 220, 150, 55);
  assert.equal(measureCoordinateChange(before, liveFrame, [400, 300]).targetRatio, 0);
  assert.equal(measureCoordinateChange(before, liveFrame, [400, 300]).reason, "target_context_changed", "surroundings changing rejects an unchanged solid target centre");
  runtime.lastObservation = before;
  assert.match(await runtime.validateCoordinateAction("desktop_click", args), /target_context_changed/);
  assert.equal(saves, 1);
  fillRect(liveFrame, 388, 288, 25, 25);
  assert.equal(measureCoordinateChange(before, liveFrame, [400, 300]).reason, "target_changed");
  assert.equal(measureCoordinateChange(before, liveFrame, [40, 30, 400, 300]).reason, "target_changed", "drag checks both endpoints");
  assert.equal(measureCoordinateChange(before, { ...before, geometry: "new-dpi" }, [400, 300]).reason, "display_layout_changed");
  assert.equal(measureCoordinateChange(before, { ...before, bitmap: Buffer.alloc(0) }, [400, 300]).reason, "target_changed");
  const loop = new VisualTaskRuntime();
  loop.start("正常任务");
  const decisions = Array.from({ length: 9 }, () => loop.recordRejectedCoordinate("desktop_click", args).kind);
  assert.equal(decisions[3], "soft_restart");
  assert.equal(decisions[8], "difficult");
  liveFrame = { ...before, sample: Buffer.alloc(160 * 90 * 4, 255) };
  const animated = new VisualTaskRuntime();
  animated.start("验证无进展");
  let verification;
  for (let i = 0; i < 4; i++) {
    animated.state.beginAction("desktop_click", args);
    verification = await animated.verifyAction("desktop_click", args, before, "已点击桌面坐标");
  }
  assert.equal(verification.decision.kind, "soft_restart", "background animation is not evidence of successful clicking");
  assert.ok(logs.some((line) => /status=accepted.*stable_target/.test(line)));
  assert.ok(logs.some((line) => /status=rejected.*target_context_changed/.test(line)));
  console.log("PASS: unrelated motion accepted once, target/context/layout/drag guarded, rejected preflights bounded, animated backgrounds are not task progress, precise diagnostics.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
