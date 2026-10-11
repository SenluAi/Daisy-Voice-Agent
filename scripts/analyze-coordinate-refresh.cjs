const { app } = require("electron");
const path = require("node:path");
async function main() {
  app.setAppPath(path.resolve(__dirname, ".."));
  const { loadAutomationFrame, measureCoordinateChange } = require("../dist/main/automation/screenSettler.js");
  const [x, y, ...files] = process.argv.slice(2);
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || files.length < 2) throw new Error("Usage: electron analyze-coordinate-refresh.cjs x y before.png after.png [...]");
  let before = await loadAutomationFrame(files[0]);
  const rows = [];
  for (const file of files.slice(1)) {
    const after = await loadAutomationFrame(file);
    rows.push({ file: path.basename(file), ...measureCoordinateChange(before, after, [Number(x), Number(y)]) });
    before = after;
  }
  console.log(JSON.stringify({ scope: "read-only archived screenshot comparison; no input injected", target: [Number(x), Number(y)], rows }, null, 2));
}
app.whenReady().then(main).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
