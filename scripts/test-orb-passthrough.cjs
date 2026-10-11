const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
let ignored = false;
const window = {
  isDestroyed: () => false, loadFile() {}, setAlwaysOnTop() {}, setContentProtection() {},
  setIgnoreMouseEvents(value) { ignored = value; }, showInactive() {}, moveTop() {},
  getPosition: () => [0, 0], setPosition() {}, on() {}, webContents: { on() {}, isDestroyed: () => false, send() {} },
};
Module._load = function (name, parent, isMain) {
  if (name === "electron") return { BrowserWindow: function () { return window; }, screen: { getPrimaryDisplay: () => ({ bounds: {} }) } };
  if (name === "./macosOverlay") return { configureMacOSOverlay() {}, setMacOSOverlayVisible() {}, raiseMacOSOverlay() {} };
  if (name === "./floatPosition") return { calculateFloatWindowBounds: () => ({ x: 0, y: 0 }), FLOAT_ORB_SIZE: 100 };
  if (name.endsWith("/utils/logger")) return { log() {} };
  return originalLoad.call(this, name, parent, isMain);
};
async function main() {
  const orb = require("../dist/main/windows/floatWindow.js");
  orb.createFloatWindow();
  assert.equal(ignored, false);
  await orb.withFloatMousePassthrough(async () => {
    assert.equal(ignored, true);
    orb.showFloatWindow();
    assert.equal(ignored, true, "state updates must not re-enable interception during input");
    await orb.withFloatMousePassthrough(async () => assert.equal(ignored, true));
    assert.equal(ignored, true, "nested operation must keep the outer operation protected");
  });
  assert.equal(ignored, false);
  await assert.rejects(orb.withFloatMousePassthrough(async () => { throw new Error("cancelled"); }), /cancelled/);
  assert.equal(ignored, false, "failure/cancellation restores orb interaction");
  console.log("PASS: orb interaction, nested passthrough, show-state updates, failure/cancellation restoration.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
