const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { config } = require("../dist/main/config/env.js");
const { GlobalShortcut } = require("../dist/main/shortcut/globalShortcut.js");

class FakePoller extends EventEmitter {
  usesNativeSpaceHold = false;
  start() {}
  configure() {}
  setPaused() {}
  kill() {}
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Space starts once only after a hold and releases once", async (t) => {
  const previous = config.shortcut.globalShortcut;
  config.shortcut.globalShortcut = "Space";
  const poller = new FakePoller();
  const shortcut = new GlobalShortcut(undefined, poller);
  t.after(() => {
    shortcut.destroy();
    config.shortcut.globalShortcut = previous;
  });

  const pressed = [];
  let released = 0;
  shortcut.on("pressed", (pressedAt) => pressed.push(pressedAt));
  shortcut.on("released", () => { released += 1; });

  poller.emit("pressed");
  await delay(50);
  poller.emit("released");
  await delay(300);
  assert.equal(pressed.length, 0, "typing a space must not start a session");

  poller.emit("pressed");
  await delay(340);
  assert.equal(pressed.length, 1);
  assert.ok(Date.now() - pressed[0] >= 300, "hold duration starts at physical key-down");
  poller.emit("pressed");
  assert.equal(pressed.length, 1, "auto-repeat must not start a second session");
  poller.emit("released");
  poller.emit("released");
  assert.equal(released, 1);
});

test("native Space hold starts immediately after its own threshold", async (t) => {
  const previous = config.shortcut.globalShortcut;
  config.shortcut.globalShortcut = "Space";
  const poller = new FakePoller();
  poller.usesNativeSpaceHold = true;
  const shortcut = new GlobalShortcut(undefined, poller);
  t.after(() => {
    shortcut.destroy();
    config.shortcut.globalShortcut = previous;
  });

  let pressedAt = 0;
  let released = 0;
  shortcut.on("pressed", (time) => { pressedAt = time; });
  shortcut.on("released", () => { released += 1; });
  const thresholdReachedAt = Date.now();
  poller.emit("pressed");
  assert.ok(pressedAt > 0 && pressedAt <= thresholdReachedAt - 290);
  poller.emit("released");
  assert.equal(released, 1);
});

test("changing shortcut cancels a pending Space hold", async (t) => {
  const previous = config.shortcut.globalShortcut;
  config.shortcut.globalShortcut = "Space";
  const poller = new FakePoller();
  const shortcut = new GlobalShortcut(undefined, poller);
  t.after(() => {
    shortcut.destroy();
    config.shortcut.globalShortcut = previous;
  });

  let pressed = 0;
  shortcut.on("pressed", () => { pressed += 1; });
  poller.emit("pressed");
  shortcut.updateShortcut("RightAlt");
  await delay(320);
  assert.equal(pressed, 0);
  poller.emit("pressed");
  assert.equal(pressed, 1, "other shortcuts still activate immediately");
});
