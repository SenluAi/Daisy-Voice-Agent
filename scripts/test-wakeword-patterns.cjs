const assert = require("node:assert/strict");
const test = require("node:test");
const { findWakeWord, extractWakeCommand } = require("../dist/main/wakeword/patterns.js");

test("matches wake-word spellings observed in Daisy logs", () => {
  for (const text of [
    "你好 daesy", "你好 dansi", "你好 desis", "你好 basy",
    "dancy", "dansi", "desis", "daisy", "你好 dais", "嘿戴西",
  ]) {
    assert.ok(findWakeWord(text), `missed: ${text}`);
  }
});

test("does not wake on ordinary words or incomplete spellings", () => {
  for (const text of ["basic", "你好 basic", "basis", "dance", "你好 dance", "你好 d", "你好 bas"]) {
    assert.equal(findWakeWord(text), null, `false wake: ${text}`);
  }
});

test("keeps the command after a wake word", () => {
  assert.equal(extractWakeCommand("你好 dansi 打开浏览器"), "打开浏览器");
  assert.equal(extractWakeCommand("dancy，帮我搜索"), "帮我搜索");
});
