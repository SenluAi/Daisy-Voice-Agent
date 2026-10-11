const { app } = require("electron");
const { performance } = require("node:perf_hooks");

async function main() {
  const tool = process.argv[2];
  const argsBase64 = process.argv[3] || "e30=";
  if (!tool) throw new Error("Usage: electron test-visual-action.cjs <tool> <base64-json>");

  const argsJson = Buffer.from(argsBase64, "base64").toString("utf8");
  const { executeTool } = require("../dist/main/control/windows.js");
  const { savePrimaryScreenSnapshot } = require("../dist/main/vision/screenCapture.js");
  const startedAt = performance.now();
  const result = await executeTool(tool, argsJson);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const snapshot = await savePrimaryScreenSnapshot([], `test-${tool}`);
  process.stdout.write(`${JSON.stringify({
    tool,
    elapsedMs: Math.round(performance.now() - startedAt),
    result,
    screenshot: snapshot.path,
    width: snapshot.width,
    height: snapshot.height,
  })}\n`);
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    app.exit(1);
  });
