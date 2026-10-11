const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-screen-geometry-"));
let id = 1;
let displays = 2;
let sources = [];
let changeDuringCapture = false;
const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 100, height: 60 }), toPNG: () => Buffer.from("synthetic-image") };
Module._load = function (name, parent, isMain) {
  if (name === "electron") return {
    app: { getPath: () => directory },
    screen: { getPrimaryDisplay: () => ({ id, bounds: { x: 0, y: 0, width: 100, height: 60 }, size: { width: 100, height: 60 }, scaleFactor: 1.25, rotation: 0 }), getAllDisplays: () => Array(displays).fill({}) },
    desktopCapturer: { async getSources() { if (changeDuringCapture) id++; return sources; } },
  };
  if (name.endsWith("/utils/logger")) return { log() {} };
  return originalLoad.call(this, name, parent, isMain);
};
async function main() {
  const capture = require("../dist/main/vision/screenCapture.js");
  sources = [{ display_id: "2", thumbnail }];
  await assert.rejects(capture.capturePrimaryScreenDataUrl(), /没有获取/);
  sources = [{ display_id: "2", thumbnail }, { display_id: "1", thumbnail }];
  const frame = await capture.capturePrimaryScreenDataUrl();
  const saved = await capture.saveScreenCapture(frame);
  assert.deepEqual(capture.getSavedObservation(saved.path), { geometry: frame.geometry, capturedAt: frame.capturedAt });
  sources = [{ display_id: "", thumbnail }];
  displays = 1;
  assert.ok((await capture.capturePrimaryScreenDataUrl()).geometry);
  changeDuringCapture = true;
  await assert.rejects(capture.capturePrimaryScreenDataUrl(), /布局已改变/);
  console.log("PASS: exact primary-screen source, ambiguous multi-display rejection, single-display fallback, timestamp/layout binding and capture-layout race.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});
