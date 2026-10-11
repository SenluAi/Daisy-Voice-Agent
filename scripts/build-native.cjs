const { execSync } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") {
  const nodeInclude = path.resolve(process.execPath, "../../include/node");
  execSync(
    `xcrun clang++ -std=c++17 -fobjc-arc -bundle -undefined dynamic_lookup -framework Foundation -framework CoreGraphics -framework AppKit -I"${nodeInclude}" native/window-selector.mm -o assets/bin/daisy-window-selector.node`,
    { stdio: "inherit" }
  );
  console.log("[build:native] macOS native overlay built.");
} else if (process.platform === "win32") {
  const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const source = path.resolve("native/windows/DaisyAutomationHelper.cs");
  const output = path.resolve("assets/bin/daisy-automation-helper.exe");
  if (!fs.existsSync(csc)) throw new Error(`Windows C# compiler not found: ${csc}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(csc, [
    "/nologo",
    "/target:exe",
    `/out:${output}`,
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    source,
  ], { stdio: "inherit" });
  console.log(`[build:native] Windows automation helper built: ${output}`);
  const wechatSource = path.resolve("native/windows/DaisyWechatInputHost.cs");
  const wechatOutput = path.resolve("assets/bin/daisy-wechat-input-host.exe");
  execFileSync(csc, [
    "/nologo",
    "/target:exe",
    `/out:${wechatOutput}`,
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    wechatSource,
  ], { stdio: "inherit" });
  console.log(`[build:native] Windows WeChat input host built: ${wechatOutput}`);
  const spaceSource = path.resolve("native/windows/DaisySpaceHoldListener.cs");
  const spaceOutput = path.resolve("assets/bin/daisy-space-hold-listener.exe");
  execFileSync(csc, [
    "/nologo",
    "/target:exe",
    `/out:${spaceOutput}`,
    "/reference:System.dll",
    spaceSource,
  ], { stdio: "inherit" });
  console.log(`[build:native] Windows Space hold listener built: ${spaceOutput}`);
} else {
  console.log(
    `[build:native] Skipping native module build on ${process.platform}. ` +
      `Daisy uses Electron setAlwaysOnTop on this platform; the native overlay module is macOS-only.`
  );
}
