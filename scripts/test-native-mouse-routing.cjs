const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { promisify } = require("node:util");
const originalLoad = Module._load;
const file = path.join(os.tmpdir(), `daisy-mouse-test-${process.pid}.exe`);
fs.writeFileSync(file, "mock-helper");
const calls = [];
let fails = false;
let scale = 2;
let origin = { x: 0, y: 0 };
let passthrough = false;
function execFile(executable, args, options, callback) {
  execFile[promisify.custom](executable, args, options).then(
    ({ stdout, stderr = "" }) => callback(null, stdout, stderr), error => callback(error, "", ""));
  return { kill() {} };
}
execFile[promisify.custom] = async (executable, args, options) => {
  calls.push({ executable, args, options });
  assert.ok(passthrough, "all mouse paths must pass through the orb");
  if (fails) throw new Error("input may already have been injected");
  return { stdout: executable === file ? "MOUSE_EXECUTED" : "" };
};
Module._load = function (name, parent, isMain) {
  if (name === "node:child_process") return { execFile, exec() {} };
  if (name === "electron") return { screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920 / scale, height: 1080 / scale } }),
    dipToScreenRect: (_window, bounds) => ({ ...origin, width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }),
  } };
  if (name.endsWith("/windows/floatWindow")) return { async withFloatMousePassthrough(operation) {
    passthrough = true;
    try { return await operation(); } finally { passthrough = false; }
  } };
  if (name.endsWith("/config/env")) return { getBundledBin: () => file, config: {} };
  if (name.endsWith("/utils/logger")) return { log() {}, logError() {} };
  if (["./officecli", "./ffmpegManager", "./openExternal", "./windowsAppResolver"].includes(name)) return {};
  return originalLoad.call(this, name, parent, isMain);
};
async function main() {
  const mouse = require("../dist/main/control/windows.js");
  assert.match(await mouse.desktopClick(100, 200, 1920, 1080), /已点击/);
  assert.deepEqual(calls.at(-1).args, ["mouse-action", "click", "100", "200", "100", "200", "down"]);
  for (scale of [1, 1.25, 1.5, 2]) {
    await mouse.desktopClick(900, 500, 1800, 1000);
    assert.deepEqual(calls.at(-1).args.slice(2, 4), ["960", "540"], `physical coordinates at scale ${scale}`);
  }
  origin = { x: -1920, y: -1080 };
  await mouse.desktopClick(900, 500, 1800, 1000);
  assert.deepEqual(calls.at(-1).args.slice(2, 4), ["-960", "-540"]);
  origin = { x: 0, y: 0 };
  await mouse.desktopDoubleClick(100, 200, 1920, 1080);
  assert.equal(calls.at(-1).args[1], "double");
  await mouse.desktopRightClick(100, 200, 1920, 1080);
  assert.equal(calls.at(-1).args[1], "right");
  await mouse.desktopScroll(100, 200, 1920, 1080, "right");
  assert.equal(calls.at(-1).args[6], "right");
  await mouse.desktopDrag(100, 200, 300, 400, 1920, 1080);
  assert.deepEqual(calls.at(-1).args.slice(1, 6), ["drag", "100", "200", "300", "400"]);
  assert.ok(calls.every((call) => call.options.windowsHide));
  const count = calls.length;
  assert.match(await mouse.desktopClick(-1, 0, 1920, 1080), /无效/);
  assert.match(await mouse.desktopDrag(100, 200, 2000, 400, 1920, 1080), /无效/);
  assert.match(await mouse.desktopScroll(100, 200, 1920, 1080, "invalid"), /无效/);
  assert.equal(calls.length, count, "invalid requests must not inject input");
  fails = true;
  assert.match(await mouse.desktopClick(100, 200, 1920, 1080), /失败/);
  assert.equal(calls.length, count + 1, "a native failure must not replay through PowerShell");
  assert.equal(passthrough, false, "failure restores the orb");
  assert.ok(calls.every((call) => call.executable === file));
  fails = false;
  fs.unlinkSync(file);
  assert.match(await mouse.desktopClick(100, 200, 1920, 1080), /已点击/);
  assert.equal(calls.at(-1).executable, "powershell.exe", "absence still supports legacy installations");
  console.log("PASS: native click/double/right/scroll/drag, coordinate scaling and bounds, hidden launch, no replay on failure, missing-helper fallback.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  if (fs.existsSync(file)) fs.unlinkSync(file);
});
