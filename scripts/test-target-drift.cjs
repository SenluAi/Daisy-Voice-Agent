const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "electron") return {};
  if (name.endsWith("/vision/screenCapture") || name.endsWith("/windows/floatWindow") || name.endsWith("/windows/panelWindow")) return {};
  return originalLoad.call(this, name, parent, isMain);
};
try {
  const { calculateTargetChangeRatio, calculateScreenChangeRatio } = require("../dist/main/automation/screenSettler.js");
  const frame = () => ({ width: 1800, height: 1000, bitmap: Buffer.alloc(1800 * 1000 * 4), sample: Buffer.alloc(160 * 90 * 4) });
  const before = frame();
  const after = frame();
  assert.equal(calculateTargetChangeRatio(before, after, 600, 400), 0);
  for (let row = 388; row <= 412; row++) {
    for (let col = 588; col <= 612; col++) after.bitmap.fill(255, (row * 1800 + col) * 4, (row * 1800 + col) * 4 + 3);
  }
  assert.equal(calculateScreenChangeRatio(before, after), 0, "global downsampling can miss a small moved control");
  assert.ok(calculateTargetChangeRatio(before, after, 600, 400) > 0.12);
  assert.equal(calculateTargetChangeRatio(before, after, 0, 0), 0);
  assert.equal(calculateTargetChangeRatio(before, after, 1799, 999), 0);
  assert.equal(calculateTargetChangeRatio(before, { ...after, width: 1799 }, 600, 400), 1);
  assert.equal(calculateTargetChangeRatio(before, { ...after, bitmap: Buffer.alloc(0) }, 600, 400), 1);
  console.log("PASS: local full-resolution drift, stable/edge targets, dimension and bitmap guards.");
} finally { Module._load = originalLoad; }
