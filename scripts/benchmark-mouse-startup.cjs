// Read-only startup benchmark: no clicks, scrolling, typing, or QQ messages.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const execute = promisify(execFile);
const helper = path.resolve(__dirname, "../assets/bin/daisy-automation-helper.exe");
const script = path.join(os.tmpdir(), `daisy-mouse-probe-${process.pid}.ps1`);
const source = `$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyMouseProbe {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
}
"@
Write-Output 'MOUSE_READY'
`;
async function samples(executable, args) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = await execute(executable, args, { windowsHide: true, timeout: 10000 });
    if (result.stdout.trim() !== "MOUSE_READY") throw new Error("unexpected probe output");
    times.push(+(performance.now() - start).toFixed(2));
  }
  return { samplesMs: times, medianMs: [...times].sort((a, b) => a - b)[2] };
}
async function main() {
  if (process.platform !== "win32") throw new Error("Windows-only benchmark");
  fs.writeFileSync(script, source);
  const baseline = await samples("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
  const native = await samples(helper, ["mouse-probe", "click", "0", "0", "0", "0", "down"]);
  console.log(JSON.stringify({ scope: "read-only process startup and binding; not full task or injected action time", baseline, native, reductionPercent: +((1 - native.medianMs / baseline.medianMs) * 100).toFixed(2) }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (fs.existsSync(script)) fs.unlinkSync(script);
});
