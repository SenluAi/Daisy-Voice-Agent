const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { WechatInputAsrSession } = require("../dist/main/asr/wechatInput.js");

test("WeChat hold session forwards received text after release", { skip: process.platform !== "win32" }, async () => {
  const session = new WechatInputAsrSession("hold");
  let timeout;
  const result = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("WeChat session timed out")), 10000);
    session.once("final", (text) => { clearTimeout(timeout); resolve(text); });
    session.once("error", (message) => { clearTimeout(timeout); reject(new Error(message)); });
  });
  try {
    const ready = new Promise((resolve) => session.once("ready", resolve));
    session.start();
    await ready;
    const script = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DaisyTextProbe {
  public delegate bool Callback(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Callback cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, UIntPtr w, IntPtr l);
}
"@
$edit = [IntPtr]::Zero
$callback = [DaisyTextProbe+Callback]{ param($h, $l)
  $name = New-Object System.Text.StringBuilder 256
  $null = [DaisyTextProbe]::GetClassName($h, $name, 256)
  if ($name.ToString() -like '*EDIT*') { $script:edit = $h }
  return $true
}
$null = [DaisyTextProbe]::EnumChildWindows([IntPtr]::new(${session.targetHandle}), $callback, [IntPtr]::Zero)
if ($edit -eq [IntPtr]::Zero) { throw 'receiver edit control missing' }
foreach ($char in 'hello Daisy'.ToCharArray()) {
  if (-not [DaisyTextProbe]::PostMessage($edit, 0x102, [UIntPtr]::new([uint64][char]$char), [IntPtr]::Zero)) { throw 'character delivery failed' }
}
`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000 });
    await session.stop();
    assert.equal(await result, "hello Daisy");
  } finally {
    clearTimeout(timeout);
    session.cancel();
  }
});
