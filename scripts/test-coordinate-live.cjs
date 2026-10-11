// Explicit opt-in: injects real clicks only into a temporary local test window.
const assert = require("node:assert/strict");
const { app, BrowserWindow, screen } = require("electron");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window;
async function main() {
  if (!process.argv.includes("--run")) throw new Error("Pass --run to test real clicks in the isolated test window");
  app.setAppPath(path.resolve(__dirname, ".."));
  const { desktopClick } = require("../dist/main/control/windows.js");
  const { capturePrimaryScreenDataUrl } = require("../dist/main/vision/screenCapture.js");
  const { createFloatWindow } = require("../dist/main/windows/floatWindow.js");
  const { captureAutomationFrame, measureCoordinateChange } = require("../dist/main/automation/screenSettler.js");
  const { VisualTaskRuntime } = require("../dist/main/automation/visualTaskRuntime.js");
  const display = screen.getPrimaryDisplay();
  window = new BrowserWindow({ x: display.bounds.x + 80, y: display.bounds.y + 80, width: 640, height: 460, frame: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:white;font:16px Arial">
    <div style="padding:40px;display:grid;grid-template-columns:repeat(4,100px);gap:24px">
    ${Array.from({ length: 12 }, (_, i) => `<button id="b${i}" style="width:100px;height:48px">Target ${i}</button>`).join("")}
    </div><div id="motion" style="position:absolute;left:540px;top:0;width:100px;height:100%;background:white;pointer-events:none"></div>
    <script>window.hits=[];document.addEventListener('click',e=>{if(e.target.id)window.hits.push(e.target.id)});</script></body></html>`));
  window.show();
  window.focus();
  await wait(300);
  const positions = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button'),b=>{const r=b.getBoundingClientRect();return {id:b.id,x:r.x+r.width/2,y:r.y+r.height/2}})`);
  const content = window.getContentBounds();
  const physical = screen.dipToScreenRect(null, display.bounds);
  const results = [];
  for (const maxWidth of [900, 1800]) {
    const capture = await capturePrimaryScreenDataUrl([], maxWidth);
    for (const target of positions) {
      const point = screen.dipToScreenPoint({ x: Math.round(content.x + target.x), y: Math.round(content.y + target.y) });
      const x = (point.x - physical.x) * capture.width / physical.width;
      const y = (point.y - physical.y) * capture.height / physical.height;
      const start = performance.now();
      assert.match(await desktopClick(x, y, capture.width, capture.height), /已点击/);
      await wait(30);
      const hits = await window.webContents.executeJavaScript("window.hits");
      assert.equal(hits.at(-1), target.id);
      results.push(+(performance.now() - start - 30).toFixed(2));
    }
  }
  const orb = createFloatWindow();
  await wait(250);
  const target = positions[5];
  orb.setPosition(Math.round(content.x + target.x - 50), Math.round(content.y + target.y - 50));
  orb.showInactive();
  const capture = await capturePrimaryScreenDataUrl([orb]);
  const point = screen.dipToScreenPoint({ x: Math.round(content.x + target.x), y: Math.round(content.y + target.y) });
  const oldCount = (await window.webContents.executeJavaScript("window.hits")).length;
  assert.match(await desktopClick((point.x - physical.x) * capture.width / physical.width,
    (point.y - physical.y) * capture.height / physical.height, capture.width, capture.height), /已点击/);
  await wait(50);
  const hits = await window.webContents.executeJavaScript("window.hits");
  assert.equal(hits.length, oldCount + 1, "orb must not intercept the test target");
  assert.equal(hits.at(-1), target.id);
  const runtime = new VisualTaskRuntime();
  runtime.start("点击测试按钮");
  const before = await captureAutomationFrame();
  runtime.lastObservation = before;
  await window.webContents.executeJavaScript("document.getElementById('motion').style.background='black'");
  await wait(100);
  const first = positions[0];
  const firstPoint = screen.dipToScreenPoint({ x: Math.round(content.x + first.x), y: Math.round(content.y + first.y) });
  const args = { x: (firstPoint.x - physical.x) * before.width / physical.width, y: (firstPoint.y - physical.y) * before.height / physical.height,
    screenshot_width: before.width, screenshot_height: before.height, target: first.id };
  assert.equal(await runtime.validateCoordinateAction("desktop_click", JSON.stringify(args)), null);
  const preflightChange = measureCoordinateChange(before, runtime.lastObservation, [args.x, args.y]);
  assert.ok(preflightChange.globalRatio > 0.01, "reproduce the old global-change veto");
  assert.equal(preflightChange.reason, null);
  assert.match(await desktopClick(args.x, args.y, before.width, before.height), /已点击/);
  await wait(50);
  const finalHits = await window.webContents.executeJavaScript("window.hits");
  assert.equal(finalHits.length, 26);
  assert.equal(finalHits.at(-1), first.id);
  const sorted = [...results].sort((a, b) => a - b);
  console.log(JSON.stringify({ scope: "isolated local window, real mouse, no external messages", display: {
    id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, physicalBounds: physical,
  }, clicks: finalHits.length, expected: 26, thumbnailWidths: [900, 1800], orbPassthrough: true, stableTargetWithBackgroundChange: preflightChange,
  actionMsMedian: sorted[Math.floor(sorted.length / 2)], actionMsMax: sorted.at(-1) }, null, 2));
}
app.whenReady().then(main).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
