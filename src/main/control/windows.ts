/**
 * Windows implementation of the Daisy control layer.
 *
 * Mirrors the public surface of ./macos.ts but uses Windows-native tooling:
 *   - PowerShell (via temp .ps1 files to avoid AV heuristics)
 *   - Start-Process / Stop-Process / taskkill
 *   - WScript.Shell SendKeys (keyboard synthesis)
 *   - Electron Notification (timers/alarms)
 *
 * Tools that have no clean Windows equivalent in v1 (Notes / Reminders /
 * Calendar / Mail / Maps-app / SwitchAudioSource / ffmpeg / LibreOffice /
 * Python-doc) return a clear "Windows 暂不支持" error so the LLM can fall
 * back to plain text answers.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrowserWindow, Notification } from "electron";
import { log, logError } from "../utils/logger";
import { getBundledBin, config } from "../config/env";
import { officeDocument } from "./officecli";
import { runFfmpeg, getFfmpegDirIfAvailable } from "./ffmpegManager";
import { describeExternalUrlForLog, openDefaultBrowser, openExternalUrl } from "./openExternal";
import { diagnoseWindowsApp, resolveAndLaunchWindowsApp, resolveWindowsApp, type AppLaunchTarget } from "./windowsAppResolver";
import { withFloatMousePassthrough } from "../windows/floatWindow";
import { commandScript, findPowerShell, runBackgroundPowerShell } from "./backgroundPowerShell";
import { requireLicenseAccess, licenseOperationSignal, isLicenseAccessAllowed } from "../license/access";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================================================
// Helpers
// ============================================================================

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Run a PowerShell script and return its trimmed stdout. The script is
 * written to a temporary .ps1 file and invoked via -File, which is
 * transparent to AV scanners (the script is readable on disk) and avoids
 * the -EncodedCommand base64 pattern that matches common malware heuristics.
 */
async function runPowerShell(script: string, options: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await runBackgroundPowerShell(script, { timeout: options.timeout ?? 15000, signal: licenseOperationSignal() });
  return stdout.trim();
}

/** True if a process exe name should never be killed by quit_all_applications. */
function isProtectedProcess(exeName: string): boolean {
  const lower = exeName.toLowerCase();
  return [
    "daisy.exe",
    "electron.exe",
    "explorer.exe",
    "conhost.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "smss.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "sihost.exe",
    "taskhostw.exe",
    "ctfmon.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "runtimebroker.exe",
    "applicationframehost.exe",
    "systemsettings.exe",
    "windowsinternalcomposableshell.exe",
  ].includes(lower);
}


// ============================================================================
// Default browser detection (reads Windows registry via PowerShell)
// ============================================================================

export async function getDefaultBrowserBundleId(): Promise<string> {
  try {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$p = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId
if (-not $p) { $p = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue).ProgId }
if ($p -match 'ChromeHTML') { 'chrome.exe' }
elseif ($p -match 'MSEdgeHTM') { 'msedge.exe' }
elseif ($p -match 'FirefoxURL') { 'firefox.exe' }
elseif ($p -match 'Brave') { 'brave.exe' }
elseif ($p -match 'Opera') { 'opera.exe' }
else { 'msedge.exe' }
`;
    const result = await runPowerShell(ps, { timeout: 5000 });
    return result || "msedge.exe";
  } catch {
    return "msedge.exe";
  }
}

// ============================================================================
// Tool implementations
// ============================================================================

export async function openApplication(name: string): Promise<string> {
  const lower = name.trim().toLowerCase();
  const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(lower);

  if (isBrowserKeyword) {
    try {
      const browserExe = await getDefaultBrowserBundleId();
      if (await activateProcessWindow(path.basename(browserExe, ".exe"))) {
        log(`local-open input=browser route=existing-window appMatch=${browserExe} handled=true`);
        return "已切换到当前打开的默认浏览器";
      }
      await openDefaultBrowser();
      log("local-open input=browser route=default-browser appMatch=none handled=true");
      return "已打开默认浏览器";
    } catch (error) {
      logError("[windows] openApplication: default browser failed", error);
      return "无法打开默认浏览器，请检查 Windows 默认浏览器设置。";
    }
  }

  const knownProcessNames: Record<string, string[]> = {
    qq: ["QQ"],
    微信: ["Weixin", "WeChat"],
    wechat: ["Weixin", "WeChat"],
    weixin: ["Weixin", "WeChat"],
    word: ["WINWORD"],
    excel: ["EXCEL"],
    powerpoint: ["POWERPNT"],
  };
  for (const processName of knownProcessNames[lower] || []) {
    if (await activateProcessWindow(processName)) {
      log(`local-open input=application route=existing-window appMatch=process target=${name} handled=true`);
      return `已切换到当前打开的 ${name}`;
    }
  }

  const resolved = await resolveWindowsApp(name);
  if (resolved.found && await activateExistingApplication(resolved.target)) {
    log(`local-open input=application route=existing-window appMatch=${resolved.match} target=${resolved.target.displayName} handled=true`);
    return `已切换到当前打开的 ${resolved.target.displayName}`;
  }

  const launch = await resolveAndLaunchWindowsApp(name);
  if (launch.launched && launch.target) {
    log(`local-open input=application route=application appMatch=${launch.match} target=${launch.target.displayName} handled=true`);
    return `已打开 ${launch.target.displayName}`;
  }
  if (launch.found) {
    log(`local-open input=application route=application appMatch=${launch.match} handled=true launch=false`);
    return `已找到 ${name}，但启动失败。请检查该应用是否仍可用。`;
  }
  log("local-open input=application route=application appMatch=none handled=false");
  return `未找到已安装的应用“${name}”，因此没有尝试启动猜测的 exe 文件。`;
}

async function processNameForActivation(target: AppLaunchTarget): Promise<string | null> {
  const direct = processNameForTarget(target);
  if (direct) return direct;
  if (target.kind !== "shortcut") return null;

  const encodedPath = Buffer.from(target.filePath, "utf16le").toString("base64");
  const result = await runPowerShell(`
$shortcutPath = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
if ($shortcut.TargetPath) { [System.IO.Path]::GetFileNameWithoutExtension($shortcut.TargetPath) }
`, { timeout: 5000 });
  return result.trim() || null;
}

async function activateExistingApplication(target: AppLaunchTarget): Promise<boolean> {
  const processName = await processNameForActivation(target);
  return processName ? activateProcessWindow(processName) : false;
}

async function activateProcessWindow(processName: string): Promise<boolean> {
  if (!processName.trim()) return false;
  const encodedName = Buffer.from(processName, "utf16le").toString("base64");
  try {
    const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedName}'))
$processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($processes.Count -eq 0) { 'NOT_FOUND'; exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyWindowActivation {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$process = $null
$largestArea = -1
foreach ($candidate in $processes) {
  $rect = New-Object DaisyWindowActivation+RECT
  $area = 0
  if ([DaisyWindowActivation]::GetWindowRect($candidate.MainWindowHandle, [ref]$rect)) {
    $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  }
  if ($area -gt $largestArea) { $largestArea = $area; $process = $candidate }
}
if (-not $process) { 'NOT_FOUND'; exit 0 }
[void][DaisyWindowActivation]::ShowWindowAsync($process.MainWindowHandle, 9)
$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate($process.Id)
if (-not $activated) { $activated = $shell.AppActivate($processName) }
Start-Sleep -Milliseconds 160
[void][DaisyWindowActivation]::SetForegroundWindow($process.MainWindowHandle)
Start-Sleep -Milliseconds 120
$foregroundPid = [uint32]0
[void][DaisyWindowActivation]::GetWindowThreadProcessId([DaisyWindowActivation]::GetForegroundWindow(), [ref]$foregroundPid)
$foregroundName = (Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue).ProcessName
if ($activated -or $foregroundName -ieq $processName) { "ACTIVATED:$foregroundPid" } else { "ACTIVATION_FAILED:$($process.Id):$foregroundPid" }
`, { timeout: 5000 });
    return result.startsWith("ACTIVATED:");
  } catch (error) {
    logError(`[windows] activate existing process failed: ${processName}`, error);
    return false;
  }
}

/** Read-only application diagnostics. Never launches, closes, or changes an app. */
export async function diagnoseApplication(name: string): Promise<string> {
  const diagnosis = await diagnoseWindowsApp(name);
  if (!diagnosis.found || !diagnosis.target) {
    return `未找到 ${name} 的已安装启动项；没有尝试启动它。请确认应用名称或是否已安装。`;
  }
  const appName = diagnosis.target.displayName;
  if (diagnosis.launchTargetExists === false) {
    return `已检查 ${appName}：系统记录的启动文件不存在或无法访问；没有尝试启动它。建议修复或重新安装。`;
  }
  if (diagnosis.running) {
    return `已检查 ${appName}：启动项正常，但进程仍在运行，可能是窗口未显示或程序卡住；没有尝试启动、结束或重启它。`;
  }
  if (diagnosis.recentFailures.length > 0) {
    return `已检查 ${appName}：启动项存在、当前未运行，Windows 最近 7 天记录到 ${diagnosis.recentFailures.length} 条相关崩溃或挂起事件；没有尝试启动它。`;
  }
  return `已检查 ${appName}：启动项存在、当前未运行，Windows 最近 7 天没有找到相关崩溃或挂起记录；没有尝试启动它。`;
}

function processNameForTarget(target: AppLaunchTarget): string | null {
  if (target.kind === "exe") return path.basename(target.filePath, ".exe");
  if (target.kind === "system") return path.basename(target.command, ".exe");
  return null;
}

export async function quitApplication(name: string): Promise<string> {
  try {
    const resolved = await resolveWindowsApp(name);
    if (!resolved.found) return `未找到已安装的应用“${name}”，因此没有结束任何进程。`;
    const processName = processNameForTarget(resolved.target);
    if (!processName) return `已找到 ${resolved.target.displayName}，但无法安全确定其进程名称。`;
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$proc = Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output 'NOT_RUNNING'; exit }
Stop-Process -Name '${processName.replace(/'/g, "''")}' -Force -ErrorAction Stop
Write-Output 'STOPPED'
`;
    const result = await runPowerShell(ps, { timeout: 8000 });
    if (result === "NOT_RUNNING") {
      return `${name} 当前未运行`;
    }
    log(`[windows] quitApplication: stopped ${resolved.target.displayName}`);
    return `已关闭 ${name}`;
  } catch (error) {
    return `关闭应用失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function quitAllApplications(excludeNames: string[] = []): Promise<string> {
  try {
    const excludes: string[] = [];
    for (const name of excludeNames) {
      const resolved = await resolveWindowsApp(name);
      if (!resolved.found) continue;
      const processName = processNameForTarget(resolved.target);
      if (processName) excludes.push(`${processName}.exe`.toLowerCase());
    }
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -ne 'Daisy' -and $_.ProcessName -ne 'electron' }
$killed = @()
foreach ($p in $procs) {
  $exe = $p.ProcessName + '.exe'
  if ($exe -ieq 'explorer.exe') { continue }
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.ProcessName } catch {}
}
$killed -join ', '
`;
    const result = await runPowerShell(ps, { timeout: 15000 });
    return result ? `已关闭以下应用：${result}` : "没有需要关闭的桌面应用";
  } catch (error) {
    return `关闭所有应用失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function typeText(text: string): Promise<string> {
  try {
    const encodedText = Buffer.from(text, "utf16le").toString("base64");
    const ps = `
$ErrorActionPreference = 'Stop'
$text = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedText}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyUnicodeInput {
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort virtualKey; public ushort scanCode; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }
  [DllImport("user32.dll", SetLastError=true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static bool SendChar(char value, bool keyUp) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.data.keyboard.scanCode = value;
    input.data.keyboard.flags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0);
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool Type(string text) {
    foreach (char value in text) {
      if (!SendChar(value, false) || !SendChar(value, true)) return false;
    }
    return true;
  }
}
"@
if (-not [DaisyUnicodeInput]::Type($text)) { throw 'SendInput failed' }
`;
    await runPowerShell(ps, { timeout: 5000 });
    return "已输入文字";
  } catch (error) {
    return `输入文字失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function pressKeys(keys: string): Promise<string> {
  try {
    const normalized = keys.toLowerCase().replace(/\s+/g, "");
    const parts = normalized.split("+");
    const mainKey = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    const virtualKeys: Record<string, number> = {
      backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b,
      space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
      left: 0x25, up: 0x26, right: 0x27, down: 0x28, delete: 0x2e,
      f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
      f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
    };
    const modifierKeys: Record<string, number> = {
      ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12,
      shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b,
    };
    const modifierVks = modifiers.map((modifier) => modifierKeys[modifier]).filter(Boolean);
    const mainVk = virtualKeys[mainKey]
      ?? (mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0);
    if (!mainVk) return `发送快捷键失败: 不支持按键 ${mainKey}`;
    const modifierList = modifierVks.join(",");

    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyShortcutInput {
  [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  const uint KEYEVENTF_KEYUP = 0x0002;
  public static void Send(byte[] modifiers, byte key) {
    foreach (byte modifier in modifiers) keybd_event(modifier, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    for (int i = modifiers.Length - 1; i >= 0; i--) keybd_event(modifiers[i], 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@
$modifiers = [byte[]]@(${modifierList})
[DaisyShortcutInput]::Send($modifiers, [byte]${mainVk})
`;
    await runPowerShell(ps, { timeout: 5000 });
    return `已发送快捷键 ${keys}`;
  } catch (error) {
    return `发送快捷键失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Focus the visible search box of a communication app without opening a second window. */
export async function focusApplicationSearch(name: string): Promise<string> {
  const lower = name.trim().toLowerCase();
  const processName = lower === "qq"
    ? "QQ"
    : ["微信", "wechat", "weixin"].includes(lower) ? "Weixin" : "";
  if (!processName) {
    await pressKeys("ctrl+f");
    return `已在 ${name} 中调用查找`;
  }
  if (!await activateProcessWindow(processName)) return `聚焦搜索框失败: 未找到 ${name} 主窗口`;

  const encodedName = Buffer.from(processName, "utf16le").toString("base64");
  try {
    const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedName}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisySearchFocus {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
}
"@
$windows = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
$target = $null
$targetRect = New-Object DaisySearchFocus+RECT
$largestArea = -1
foreach ($candidate in $windows) {
  $rect = New-Object DaisySearchFocus+RECT
  if (-not [DaisySearchFocus]::GetWindowRect($candidate.MainWindowHandle, [ref]$rect)) { continue }
  $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($area -gt $largestArea) { $largestArea = $area; $target = $candidate; $targetRect = $rect }
}
if (-not $target) { throw 'main window not found' }
$width = $targetRect.Right - $targetRect.Left
$height = $targetRect.Bottom - $targetRect.Top
$x = $targetRect.Left + [int]($width * 0.125)
$y = $targetRect.Top + [int]($height * 0.085)
[void][DaisySearchFocus]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 60
[DaisySearchFocus]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[DaisySearchFocus]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
"FOCUSED:$x,$y"
`, { timeout: 5000 });
    return result.startsWith("FOCUSED:") ? `已聚焦 ${name} 搜索框` : `聚焦搜索框失败: ${result}`;
  } catch (error) {
    return `聚焦搜索框失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Select the first exact contact result after focusApplicationSearch + typeText. */
export async function selectApplicationSearchResult(name: string): Promise<string> {
  const lower = name.trim().toLowerCase();
  const processName = lower === "qq"
    ? "QQ"
    : ["微信", "wechat", "weixin"].includes(lower) ? "Weixin" : "";
  if (!processName) return `选择搜索结果失败: ${name} 没有桌面搜索适配`;
  if (!await activateProcessWindow(processName)) return `选择搜索结果失败: 未找到 ${name} 主窗口`;

  const encodedName = Buffer.from(processName, "utf16le").toString("base64");
  try {
    const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedName}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisySearchResult {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
}
"@
$windows = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
$target = $null
$targetRect = New-Object DaisySearchResult+RECT
$largestArea = -1
foreach ($candidate in $windows) {
  $rect = New-Object DaisySearchResult+RECT
  if (-not [DaisySearchResult]::GetWindowRect($candidate.MainWindowHandle, [ref]$rect)) { continue }
  $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($area -gt $largestArea) { $largestArea = $area; $target = $candidate; $targetRect = $rect }
}
if (-not $target) { throw 'main window not found' }
$width = $targetRect.Right - $targetRect.Left
$height = $targetRect.Bottom - $targetRect.Top
$x = $targetRect.Left + [int]($width * 0.13)
$yRatio = if ($processName -ieq 'QQ') { 0.205 } else { 0.17 }
$y = $targetRect.Top + [int]($height * $yRatio)
[void][DaisySearchResult]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 60
[DaisySearchResult]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[DaisySearchResult]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
"SELECTED:$x,$y"
`, { timeout: 5000 });
    return result.startsWith("SELECTED:") ? `已选择 ${name} 的首个联系人搜索结果` : `选择搜索结果失败: ${result}`;
  } catch (error) {
    return `选择搜索结果失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function communicationProcessName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "qq") return "QQ";
  if (["微信", "wechat", "weixin"].includes(lower)) return "Weixin";
  return "";
}

async function runCommunicationHelper(command: string, encodedArgs: string[]): Promise<string | null> {
  const helperPath = getBundledBin("daisy-automation-helper");
  if (!fs.existsSync(helperPath)) return null;
  try {
    const { stdout } = await execFileAsync(helperPath, [command, ...encodedArgs], {
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      signal: licenseOperationSignal(),
    });
    return stdout.trim();
  } catch (error) {
    logError(`[windows] automation helper ${command} failed; using PowerShell fallback`, error);
    return null;
  }
}

/** Open an existing communication app and enter one contact chat in one deterministic action. */
export async function openContactChat(name: string, contact: string): Promise<string> {
  const processName = communicationProcessName(name);
  const contactName = contact.trim();
  if (!processName) return `进入联系人会话失败: ${name} 没有桌面搜索适配`;
  if (!contactName) return "进入联系人会话失败: 联系人名称为空";
  const encodedProcess = Buffer.from(processName, "utf16le").toString("base64");
  const encodedContact = Buffer.from(contactName, "utf16le").toString("base64");

  let helperResult = await runCommunicationHelper("open-contact", [encodedProcess, encodedContact]);
  if (helperResult === "NOT_FOUND") {
    const opened = await openApplication(name);
    if (/无法|失败|未找到/.test(opened)) return `进入联系人会话失败: ${opened}`;
    return `已打开 ${name}；请根据自动验证截图确认是主界面还是登录页。若是已保存账号的一键登录页，先点击可见的登录按钮并验证，再调用 open_contact_chat 搜索“${contactName}”。`;
  }
  if (helperResult === "CONTACT_RESULTS_READY") {
    return `已尝试在 ${name} 中搜索“${contactName}”；只有验证截图显示联系人结果时才点击名称完全匹配的联系人。若显示已保存账号的一键登录页，先点击登录并验证，再重新搜索。`;
  }

  const runMacro = () => runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedProcess}'))
$contact = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedContact}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyContactMacro {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(2, 0, 0, 0, IntPtr.Zero); mouse_event(4, 0, 0, 0, IntPtr.Zero); }
  public static void SelectAll() { keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x41,0,0,UIntPtr.Zero); keybd_event(0x41,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero); }
  public static bool TypeText(string text) {
    foreach (char value in text) {
      INPUT down = new INPUT(); down.type = 1; down.data.keyboard.scanCode = value; down.data.keyboard.flags = 4;
      INPUT up = down; up.data.keyboard.flags = 6;
      if (SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) return false;
    }
    return true;
  }
}
"@
$windows = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($windows.Count -eq 0) { 'NOT_FOUND'; exit 0 }
$target = $null
$targetRect = New-Object DaisyContactMacro+RECT
$largestArea = -1
foreach ($candidate in $windows) {
  $rect = New-Object DaisyContactMacro+RECT
  if (-not [DaisyContactMacro]::GetWindowRect($candidate.MainWindowHandle, [ref]$rect)) { continue }
  $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($area -gt $largestArea) { $largestArea = $area; $target = $candidate; $targetRect = $rect }
}
if (-not $target) { throw 'main window not found' }
[void][DaisyContactMacro]::ShowWindow($target.MainWindowHandle, 9)
[void][DaisyContactMacro]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 100
$width = $targetRect.Right - $targetRect.Left
$height = $targetRect.Bottom - $targetRect.Top
[DaisyContactMacro]::Click($targetRect.Left + [int]($width * 0.125), $targetRect.Top + [int]($height * 0.085))
Start-Sleep -Milliseconds 80
[DaisyContactMacro]::SelectAll()
if (-not [DaisyContactMacro]::TypeText($contact)) { throw 'SendInput failed' }
Start-Sleep -Milliseconds 250
'CONTACT_RESULTS_READY'
`, { timeout: 6000 });

  try {
    let result = await runMacro();
    if (result === "NOT_FOUND") {
      const opened = await openApplication(name);
      if (/无法|失败|未找到/.test(opened)) return `进入联系人会话失败: ${opened}`;
      return `已打开 ${name}；请根据自动验证截图确认是主界面还是登录页。若是已保存账号的一键登录页，先点击可见的登录按钮并验证，再调用 open_contact_chat 搜索“${contactName}”。`;
    }
    return result === "CONTACT_RESULTS_READY"
      ? `已尝试在 ${name} 中搜索“${contactName}”；只有验证截图显示联系人结果时才点击名称完全匹配的联系人。若显示已保存账号的一键登录页，先点击登录并验证，再重新搜索。`
      : `进入联系人会话失败: ${result}`;
  } catch (error) {
    return `进入联系人会话失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Copy and paste a file into an already verified communication chat. */
export async function stageFileAttachment(name: string, filePath: string): Promise<string> {
  const processName = communicationProcessName(name);
  if (!processName) return `暂存附件失败: ${name} 没有桌面发送适配`;
  const resolved = path.resolve(expandPath(filePath));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return `暂存附件失败: 文件不存在：${resolved}`;
  const encodedProcess = Buffer.from(processName, "utf16le").toString("base64");
  const encodedPath = Buffer.from(resolved, "utf16le").toString("base64");
  const helperResult = await runCommunicationHelper("stage-file", [encodedProcess, encodedPath]);
  if (helperResult === "STAGED") {
    return `已把文件附件粘贴到 ${name} 当前会话；请根据自动验证截图核对文件名和发送预览。`;
  }
  try {
    const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedProcess}'))
$filePath = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$target = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object @{ Expression = { $_.MainWindowHandle }; Descending = $true }) | Select-Object -First 1
if (-not $target) { throw 'main window not found' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyAttachmentStage {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  public static void Paste() { keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x56,0,0,UIntPtr.Zero); keybd_event(0x56,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero); }
}
"@
$file = Get-Item -LiteralPath $filePath
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($file.FullName)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
[void][DaisyAttachmentStage]::ShowWindow($target.MainWindowHandle, 9)
[void][DaisyAttachmentStage]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 100
[DaisyAttachmentStage]::Paste()
'STAGED'
`, { timeout: 6000 });
    return result === "STAGED"
      ? `已把文件附件粘贴到 ${name} 当前会话；请根据自动验证截图核对文件名和发送预览。`
      : `暂存附件失败: ${result}`;
  } catch (error) {
    return `暂存附件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Confirm the visible file-send preview after the agent has visually verified it. */
export async function confirmStagedAttachment(name: string): Promise<string> {
  const lower = name.trim().toLowerCase();
  const processName = lower === "qq"
    ? "QQ"
    : ["微信", "wechat", "weixin"].includes(lower) ? "Weixin" : "";
  if (!processName) return `确认附件发送失败: ${name} 没有桌面发送适配`;

  const encodedName = Buffer.from(processName, "utf16le").toString("base64");
  const helperResult = await runCommunicationHelper("confirm-attachment", [encodedName]);
  if (helperResult === "CONFIRMED") return `已确认 ${name} 的附件发送`;
  try {
    const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$processName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedName}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyAttachmentConfirm {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
}
"@
$windows = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
$target = $null
$targetRect = New-Object DaisyAttachmentConfirm+RECT
$largestArea = -1
foreach ($candidate in $windows) {
  $rect = New-Object DaisyAttachmentConfirm+RECT
  if (-not [DaisyAttachmentConfirm]::GetWindowRect($candidate.MainWindowHandle, [ref]$rect)) { continue }
  $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($area -gt $largestArea) { $largestArea = $area; $target = $candidate; $targetRect = $rect }
}
if (-not $target) { throw 'main window not found' }
[void][DaisyAttachmentConfirm]::ShowWindow($target.MainWindowHandle, 9)
[void][DaisyAttachmentConfirm]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 80
$width = $targetRect.Right - $targetRect.Left
$height = $targetRect.Bottom - $targetRect.Top
$x = $targetRect.Left + [int]($width * 0.50)
$yRatio = if ($processName -ieq 'QQ') { 0.695 } else { 0.70 }
$y = $targetRect.Top + [int]($height * $yRatio)
[void][DaisyAttachmentConfirm]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 60
[DaisyAttachmentConfirm]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[DaisyAttachmentConfirm]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
"CONFIRMED:$x,$y"
`, { timeout: 5000 });
    return result.startsWith("CONFIRMED:") ? `已确认 ${name} 的附件发送` : `确认附件发送失败: ${result}`;
  } catch (error) {
    return `确认附件发送失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getFrontmostApplication(): Promise<string> {
  try {
    // GetForegroundWindow + GetWindowText + GetWindowThreadProcessId via P/Invoke.
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(1024)
[void][Win32]::GetWindowText($hwnd, $sb, 1024)
$title = $sb.ToString()
$procId = 0
[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
"$($proc.ProcessName).exe|$title"
`;
    const result = await runPowerShell(ps, { timeout: 5000 });
    if (!result) return "无法获取当前前台应用";
    const [exe, title] = result.split("|");
    return `当前最前面的应用是：${exe}${title ? `（标题：${title}）` : ""}`;
  } catch (error) {
    return `获取当前应用失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readSelectedText(): Promise<string> {
  try {
    const { clipboard } = await import("electron");
    const original = clipboard.readText();

    // Simulate Ctrl+C
    const ps = `
$ErrorActionPreference = 'Stop'
$wsh = New-Object -ComObject WScript.Shell
Start-Sleep -Milliseconds 30
$wsh.SendKeys('^c')
`;
    await runPowerShell(ps, { timeout: 4000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const selected = clipboard.readText();
    if (original) {
      try { clipboard.writeText(original); } catch { /* ignore */ }
    }
    if (!selected || selected === original) {
      return "没有读取到选中的文字，请确认当前有选中的内容";
    }
    return `选中的文字是：${selected}`;
  } catch (error) {
    return `读取选中文本失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getClipboardText(): Promise<string> {
  try {
    const { clipboard } = await import("electron");
    const text = clipboard.readText();
    return text.trim() || "剪贴板为空，或不包含文本内容。";
  } catch (error) {
    return `获取剪贴板失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function writeClipboardText(text: string): Promise<string> {
  try {
    const { clipboard } = await import("electron");
    clipboard.writeText(text);
    return `已成功复制到剪贴板。`;
  } catch (error) {
    return `写入剪贴板失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function desktopClick(
  x: number,
  y: number,
  screenshotWidth: number,
  screenshotHeight: number,
): Promise<string> {
  if (![x, y, screenshotWidth, screenshotHeight].every(Number.isFinite) || screenshotWidth <= 0 || screenshotHeight <= 0
    || x < 0 || y < 0 || x >= screenshotWidth || y >= screenshotHeight) {
    return "桌面点击失败: 截图坐标或尺寸无效";
  }
  try {
    const { screen } = await import("electron");
    const bounds = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
    const targetX = Math.round(bounds.x + (x / screenshotWidth) * bounds.width);
    const targetY = Math.round(bounds.y + (y / screenshotHeight) * bounds.height);
    return await withFloatMousePassthrough(async () => {
    if (await runNativeMouseAction("click", targetX, targetY)) {
      return "已点击桌面坐标 (" + targetX + ", " + targetY + ")";
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class DaisyWindowClick {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);",
      "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }",
      "  [DllImport(\"user32.dll\")] public static extern bool GetPhysicalCursorPos(out POINT point);",
      "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
      "  [DllImport(\"user32.dll\")] public static extern bool mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extraInfo);",
      "}",
      "\"@",
      "if ([DaisyWindowClick]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw 'DPI awareness failed' }",
      "if (-not [DaisyWindowClick]::SetCursorPos(" + targetX + ", " + targetY + ")) { throw 'SetCursorPos failed' }",
      "$point = New-Object DaisyWindowClick+POINT",
      "if (-not [DaisyWindowClick]::GetPhysicalCursorPos([ref]$point) -or $point.X -ne " + targetX + " -or $point.Y -ne " + targetY + ") { throw 'cursor position mismatch' }",
      "[void][DaisyWindowClick]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)",
      "[void][DaisyWindowClick]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)",
    ].join("\n");
    await runPowerShell(script, { timeout: 5000 });
    return "已点击桌面坐标 (" + targetX + ", " + targetY + ")";
    });
  } catch (error) {
    return "桌面点击失败: " + (error instanceof Error ? error.message : String(error));
  }
}

async function runNativeMouseAction(
  action: string, x: number, y: number,
  endX = x, endY = y, direction = "down",
): Promise<boolean> {
  const helperPath = getBundledBin("daisy-automation-helper");
  if (!fs.existsSync(helperPath)) return false;
  const startedAt = Date.now();
  // Only absence permits fallback. An error may occur after input; never replay it.
  const { stdout } = await execFileAsync(helperPath, ["mouse-action", action, String(x), String(y), String(endX), String(endY), direction], {
    timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024, signal: licenseOperationSignal(),
  });
  if (stdout.trim() !== "MOUSE_EXECUTED") throw new Error("原生鼠标结果不确定，未重复执行，请截图检查");
  log(`[task-perf] native-mouse action=${action} elapsedMs=${Date.now() - startedAt}`);
  return true;
}

async function desktopMouseAction(
  action: "double" | "right" | "scroll" | "drag",
  x: number,
  y: number,
  screenshotWidth: number,
  screenshotHeight: number,
  options: { endX?: number; endY?: number; direction?: string } = {},
): Promise<string> {
  const coordinates = [x, y, options.endX ?? x, options.endY ?? y];
  if (![...coordinates, screenshotWidth, screenshotHeight].every(Number.isFinite) || screenshotWidth <= 0 || screenshotHeight <= 0
    || coordinates.some((value, index) => value < 0 || value >= (index % 2 === 0 ? screenshotWidth : screenshotHeight))) {
    return "桌面鼠标操作失败: 截图坐标或尺寸无效";
  }
  try {
    const { screen } = await import("electron");
    const bounds = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
    const mapX = (value: number) => Math.round(bounds.x + (value / screenshotWidth) * bounds.width);
    const mapY = (value: number) => Math.round(bounds.y + (value / screenshotHeight) * bounds.height);
    const targetX = mapX(x);
    const targetY = mapY(y);
    const endX = mapX(options.endX ?? x);
    const endY = mapY(options.endY ?? y);
    const direction = String(options.direction || "down").toLowerCase();
    if (action === "scroll" && !["up", "down", "left", "right"].includes(direction)) return "桌面鼠标操作失败: 滚动方向无效";
    return await withFloatMousePassthrough(async () => {
    if (await runNativeMouseAction(action, targetX, targetY, endX, endY, direction)) {
      return `已执行桌面${action === "double" ? "双击" : action === "right" ? "右键" : action === "scroll" ? "滚动" : "拖动"}`;
    }
    const wheelDelta = direction === "up" || direction === "right" ? 720 : -720;
    const wheelFlag = direction === "left" || direction === "right" ? 0x01000 : 0x00800;
    const actionScript = action === "double"
      ? "[DaisyAgentMouse]::Click(1); Start-Sleep -Milliseconds 90; [DaisyAgentMouse]::Click(1)"
      : action === "right"
        ? "[DaisyAgentMouse]::Click(2)"
        : action === "scroll"
          ? `[DaisyAgentMouse]::Wheel(${wheelFlag}, ${wheelDelta})`
          : `[DaisyAgentMouse]::Drag(${targetX}, ${targetY}, ${endX}, ${endY})`;
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DaisyAgentMouse {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] private static extern bool GetPhysicalCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public static void Move(int x, int y) {
    POINT point;
    if (!SetCursorPos(x, y) || !GetPhysicalCursorPos(out point) || point.X != x || point.Y != y)
      throw new InvalidOperationException("cursor position mismatch");
  }
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
  public static void Click(int button) {
    uint down = button == 2 ? 8u : 2u;
    uint up = button == 2 ? 16u : 4u;
    mouse_event(down, 0, 0, 0, IntPtr.Zero); mouse_event(up, 0, 0, 0, IntPtr.Zero);
  }
  public static void Wheel(uint flag, int amount) { mouse_event(flag, 0, 0, amount, IntPtr.Zero); }
  public static void Drag(int sx, int sy, int ex, int ey) {
    Move(sx, sy); mouse_event(2, 0, 0, 0, IntPtr.Zero);
    try {
    for (int i = 1; i <= 12; i++) {
      Move(sx + (ex - sx) * i / 12, sy + (ey - sy) * i / 12);
      System.Threading.Thread.Sleep(18);
    }
    } finally { mouse_event(4, 0, 0, 0, IntPtr.Zero); }
  }
}
"@
if ([DaisyAgentMouse]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw 'DPI awareness failed' }
[DaisyAgentMouse]::Move(${targetX}, ${targetY})
${actionScript}
`;
    await runPowerShell(script, { timeout: 5000 });
    return `已执行桌面${action === "double" ? "双击" : action === "right" ? "右键" : action === "scroll" ? "滚动" : "拖动"}`;
    });
  } catch (error) {
    return `桌面鼠标操作失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function desktopDoubleClick(x: number, y: number, width: number, height: number): Promise<string> {
  return desktopMouseAction("double", x, y, width, height);
}

export async function desktopRightClick(x: number, y: number, width: number, height: number): Promise<string> {
  return desktopMouseAction("right", x, y, width, height);
}

export async function desktopScroll(x: number, y: number, width: number, height: number, direction: string): Promise<string> {
  return desktopMouseAction("scroll", x, y, width, height, { direction });
}

export async function desktopDrag(
  x: number,
  y: number,
  endX: number,
  endY: number,
  width: number,
  height: number,
): Promise<string> {
  return desktopMouseAction("drag", x, y, width, height, { endX, endY });
}

export async function copyFileToClipboard(filePath: string): Promise<string> {
  const resolved = path.resolve(expandPath(filePath));
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return `复制文件失败: 路径不是文件：${resolved}`;

    const encodedPath = Buffer.from(resolved, "utf16le").toString("base64");
    await runPowerShell(`
$ErrorActionPreference = 'Stop'
$filePath = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$file = Get-Item -LiteralPath $filePath
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($file.FullName)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
$copied = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($copied.Count -ne 1 -or $copied[0] -ne $file.FullName) {
  throw 'Windows file clipboard verification failed'
}
`, { timeout: 5000 });
    return `已将文件附件复制到剪贴板：${resolved}`;
  } catch (error) {
    return `复制文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getCurrentTime(): Promise<string> {
  const now = new Date();
  const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const dayOfWeek = days[now.getDay()];
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `当前时间是 ${year}年${month}月${date}日 ${dayOfWeek} ${hours}:${minutes}`;
}

export async function readFile(filePath: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    // No textutil on Windows: read as text only (.docx binary parsing skipped in v1).
    const content = fs.readFileSync(resolved, "utf-8");
    const truncated = content.length > 100000 ? content.slice(0, 100000) + "\n...(内容过长，已截断)" : content;
    return `文件 ${filePath} 的内容：\n${truncated}`;
  } catch (error) {
    return `读取文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function writeFile(filePath: string, content: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return `已写入文件 ${filePath}（${content.length} 字符）`;
  } catch (error) {
    return `写入文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function createFile(filePath: string, content: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    if (fs.existsSync(resolved)) {
      return `文件 ${filePath} 已存在，未做修改。如需覆盖请明确说明。`;
    }
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return `已创建文件 ${filePath}`;
  } catch (error) {
    return `创建文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function deleteFile(filePath: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    if (!fs.existsSync(resolved)) return `文件 ${filePath} 不存在`;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmdirSync(resolved);
    } else {
      fs.unlinkSync(resolved);
    }
    return `已删除 ${filePath}`;
  } catch (error) {
    return `删除文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function downloadMedia(url: string, type: string = "video", destination?: string): Promise<string> {
  try {
    const defaultDir = path.join(os.homedir(), "Downloads");
    const saveDir = destination ? expandPath(destination) : defaultDir;
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    log(`[windows] downloadMedia: ${url} (type ${type}) -> ${saveDir}`);
    const ytdlpPath = getBundledBin("yt-dlp");

    // yt-dlp's "bv*+ba/b" downloads best video + best audio as separate
    // streams, then merges with ffmpeg. Without --ffmpeg-location, yt-dlp
    // can't find the auto-downloaded ffmpeg (it's in userData/tools/ffmpeg/,
    // not on PATH or next to yt-dlp.exe), so it leaves them as two files.
    // Pass --ffmpeg-location so the merge succeeds. If ffmpeg is not yet
    // installed, fall back to "best" (single-stream, no merge needed).
    const ffmpegDir = getFfmpegDirIfAvailable();
    const args = type === "audio"
      ? `-x --audio-format mp3 --audio-quality 0 -o "%(title)s.%(ext)s"`
      : ffmpegDir
        ? `-f "bv*+ba/b" --merge-output-format mp4 --ffmpeg-location "${ffmpegDir}" -o "%(title)s.%(ext)s"`
        : `-f "best" -o "%(title)s.%(ext)s"`;

    const cmd = `"${ytdlpPath}" ${args} -P "${saveDir}" "${url}"`;
    log(`[windows] downloadMedia: running ${cmd}`);
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 16, timeout: 600000, windowsHide: true, signal: licenseOperationSignal() });

    const destMatch = stdout.match(/Destination:\s*(.+)/i) || stdout.match(/Merging formats into\s*"(.*?)"/i);
    const filename = destMatch?.[1] ? path.basename(destMatch[1].replace(/"/g, "").trim()) : "";
    const savedName = filename ? `「${filename}」` : "媒体文件";
    const destName = saveDir.toLowerCase().includes("desktop") ? "桌面" : "下载（Downloads）文件夹";
    return `已成功下载${type === "audio" ? "音频" : "视频"}${savedName}并保存至${destName}。`;
  } catch (error) {
    logError("[windows] downloadMedia failed", error);
    return `下载失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function listDirectory(dirPath: string): Promise<string> {
  const resolved = expandPath(dirPath || "~/Desktop");
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
    if (items.length === 0) return `目录 ${dirPath} 为空`;
    return `目录 ${dirPath} 的内容：\n${items.join("\n")}`;
  } catch (error) {
    return `列出目录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function runShellCommand(command: string, shell: "cmd" | "powershell" = "cmd"): Promise<string> {
  try {
    const { stdout, stderr } = shell === "powershell"
      ? await runBackgroundPowerShell(commandScript(command), { cwd: os.homedir(), executable: findPowerShell(), signal: licenseOperationSignal() })
      : await execAsync(command, {
      maxBuffer: 1024 * 1024 * 5,
      timeout: 30000,
      cwd: os.homedir(),
      windowsHide: true,
      signal: licenseOperationSignal(),
    });
    const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
    const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n...(输出过长，已截断)" : output;
    return truncated || "命令执行完成（无输出）";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `命令执行失败: ${message}`;
  }
}

export async function setTimer(seconds: number): Promise<string> {
  try {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const desc = mins > 0 ? `${mins}分${secs > 0 ? secs + "秒" : ""}` : `${secs}秒`;
    setTimeout(() => {
      if (!isLicenseAccessAllowed()) return;
      try {
        new Notification({ title: "Daisy 计时器", body: `计时器完成：${desc}`, silent: false }).show();
      } catch (err) {
        logError("[windows] setTimer notification failed", err);
      }
    }, seconds * 1000);
    return `已设置计时器：${desc}，时间到了会弹出通知`;
  } catch (error) {
    return `设置计时器失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function setAlarm(time: string, label?: string): Promise<string> {
  try {
    const parts = time.trim().split(/[\s/]/);
    const datePart = parts[0].split("-");
    const timePart = parts[1] ? parts[1].split(":") : ["7", "0"];
    const y = parseInt(datePart[0]);
    const m = parseInt(datePart[1]);
    const d = parseInt(datePart[2]);
    const h = parseInt(timePart[0]);
    const min = parseInt(timePart[1] || "0");

    const now = new Date();
    const alarmDate = new Date(y, m - 1, d, h, min, 0);
    const diffMs = alarmDate.getTime() - now.getTime();
    if (diffMs <= 0) return `闹钟时间 ${time} 已过期，请指定一个未来的时间`;

    const diffSec = Math.round(diffMs / 1000);
    const diffMins = Math.round(diffSec / 60);
    const timeDesc = diffMins < 60 ? `${diffMins}分钟后`
      : diffMins < 1440 ? `${Math.round((diffMins / 60) * 10) / 10}小时后`
      : `${Math.round((diffMins / 1440) * 10) / 10}天后`;

    const alarmTimeStr = `${m}月${d}日 ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    setTimeout(() => {
      // Repeat the notification 5 times to mimic an alarm.
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          if (!isLicenseAccessAllowed()) return;
          try {
            new Notification({ title: "Daisy 闹钟", body: `${label || "闹钟"}：${alarmTimeStr}`, silent: false }).show();
          } catch (err) {
            logError("[windows] setAlarm notification failed", err);
          }
        }, i * 1000);
      }
    }, diffSec * 1000);

    return `已设置闹钟「${label || "闹钟"}」，时间：${alarmTimeStr}（${timeDesc}响起）`;
  } catch (error) {
    return `设置闹钟失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function searchMaps(query: string): Promise<string> {
  try {
    // Open Bing Maps in the default browser (no native Maps app on Windows).
    const url = `https://www.bing.com/maps?q=${encodeURIComponent(query)}`;
    await openExternalUrl(url);
    log(`local-open input=map route=url appMatch=none url=${describeExternalUrlForLog(url)} handled=true`);
    return `已在浏览器中打开地图搜索「${query}」`;
  } catch (error) {
    return `地图搜索失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function openUrl(url: string): Promise<string> {
  try {
    const finalUrl = await openExternalUrl(url);
    log(`local-open input=url route=url appMatch=none url=${describeExternalUrlForLog(finalUrl)} handled=true`);
    return `已用默认浏览器打开 ${finalUrl}`;
  } catch (error) {
    return `打开网址失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================================
// Audio / video tools (ffmpeg; auto-downloaded on first use via ffmpegManager)
// ============================================================================

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a", ".wma", ".opus"]);

function toSeconds(time: string): number {
  const parts = String(time || "")
    .split(":")
    .map((p) => Number(p) || 0);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export async function trimVideo(source: string, start: string, end: string, output?: string): Promise<string> {
  try {
    const src = expandPath(source);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const dur = toSeconds(end) - toSeconds(start);
    if (dur <= 0) return `截取时间范围无效：${start} 到 ${end}`;

    const isAudio = AUDIO_EXTENSIONS.has(path.extname(src).toLowerCase());
    const outName = output || (isAudio
      ? `clip_${start.replace(/:/g, "m")}s-${end.replace(/:/g, "m")}s.mp3`
      : `clip_${start.replace(/:/g, "m")}s-${end.replace(/:/g, "m")}s.mp4`);
    const outPath = path.join(path.dirname(src), outName);

    const encodeArgs = isAudio
      ? ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
      : ["-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-movflags", "+faststart"];

    log(`[windows] trimVideo: ${path.basename(src)} ${start}->${end} (${dur}s) -> ${outName}`);
    await runFfmpeg(
      ["-y", "-ss", start, "-i", src, "-t", String(dur), ...encodeArgs, outPath],
      120_000,
    );
    return `已截取${isAudio ? "音频" : "视频"}片段，保存至「${outName}」（${dur} 秒）`;
  } catch (error) {
    return `视频截取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function convertVideo(source: string, format: string, output?: string): Promise<string> {
  try {
    const src = expandPath(source);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const baseName = path.basename(src, path.extname(src));
    const outName = output || `${baseName}.${format}`;
    const outPath = path.join(path.dirname(src), outName);

    const fmt = format.toLowerCase();
    // Audio-only targets: drop the video stream.
    const encodeArgs = AUDIO_EXTENSIONS.has(`.${fmt}`)
      ? ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
      : ["-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-movflags", "+faststart"];

    log(`[windows] convertVideo: ${path.basename(src)} -> ${outName}`);
    await runFfmpeg(["-y", "-i", src, ...encodeArgs, outPath], 300_000);
    return `已转换格式，保存至「${outName}」`;
  } catch (error) {
    return `视频格式转换失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================================
// Document conversion (txt/md/html -> PDF via Electron printToPDF; no external deps)
// ============================================================================

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal Markdown -> HTML (headings, bold/italic/code, code blocks, lists, links, paragraphs). */
function markdownToHtml(md: string): string {
  let h = escapeHtml(md);
  h = h.replace(/```([\s\S]*?)```/g, (_m, c) => `<pre><code>${c}</code></pre>`);
  h = h.replace(/^###### (.*)$/gm, "<h6>$1</h6>");
  h = h.replace(/^##### (.*)$/gm, "<h5>$1</h5>");
  h = h.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
  h = h.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  h = h.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
  h = h.replace(/`(.+?)`/g, "<code>$1</code>");
  h = h.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  // list items
  h = h.replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>");
  h = h.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => `<ul>${m}</ul>`);
  // paragraphs
  h = h
    .split(/\n\n+/)
    .map((p) => {
      const t = p.trim();
      if (!t || /^<(h[1-6]|ul|pre)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return h;
}

function buildHtmlDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;font-size:14px;line-height:1.7;padding:48px;max-width:780px;margin:0 auto;color:#222}
h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.25em}
pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word}
code{background:#f5f5f5;padding:2px 4px;border-radius:3px;font-family:Consolas,monospace}
a{color:#0366d6}
</style></head><body>${bodyHtml}</body></html>`;
}

/** Render a .txt/.md/.html source into a temp HTML file for printToPDF. */
function prepareHtmlForConversion(src: string): { htmlPath: string; cleanup: boolean } | null {
  const ext = path.extname(src).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return { htmlPath: src, cleanup: false };
  }
  const content = fs.readFileSync(src, "utf-8");
  const body = ext === ".md" ? markdownToHtml(content) : `<pre style="white-space:pre-wrap;word-wrap:break-word">${escapeHtml(content)}</pre>`;
  const html = buildHtmlDocument(body);
  const htmlPath = path.join(os.tmpdir(), `daisy-conv-${Date.now()}.html`);
  fs.writeFileSync(htmlPath, html, "utf-8");
  return { htmlPath, cleanup: true };
}

/** Convert an HTML file to PDF using Electron's built-in printToPDF (no external deps). */
async function htmlToPdfViaElectron(htmlPath: string, pdfPath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  });
  try {
    await win.loadURL(`file:///${htmlPath.replace(/\\/g, "/")}`);
    await new Promise((r) => setTimeout(r, 500));
    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0.59, bottom: 0.59, left: 0.47, right: 0.47 },
    });
    await fs.promises.writeFile(pdfPath, pdfData);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function convertDocument(source: string, target: string): Promise<string> {
  try {
    const src = expandPath(source);
    const dst = expandPath(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;
    const srcExt = path.extname(src).toLowerCase();
    const dstExt = path.extname(dst).toLowerCase();

    if (dstExt === ".pdf") {
      if ([".docx", ".xlsx", ".pptx"].includes(srcExt)) {
        return `Office 文档转 PDF 请使用 office_document 的 convert 操作（source + target + operation=convert），它通过 OfficeCLI 后台完成。`;
      }
      const prepared = prepareHtmlForConversion(src);
      if (!prepared) return `Windows 暂不支持「${srcExt}」转 PDF。支持 .txt / .md / .html。`;
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      try {
        await htmlToPdfViaElectron(prepared.htmlPath, dst);
      } finally {
        if (prepared.cleanup) fs.promises.unlink(prepared.htmlPath).catch(() => {});
      }
      return `已转换为 PDF，保存至「${path.basename(dst)}」`;
    }

    // Non-PDF targets (e.g., .txt -> .html, .md -> .html): simple text/HTML passthrough.
    if ((srcExt === ".txt" || srcExt === ".md") && (dstExt === ".html" || dstExt === ".htm")) {
      const content = fs.readFileSync(src, "utf-8");
      const body = srcExt === ".md" ? markdownToHtml(content) : `<pre>${escapeHtml(content)}</pre>`;
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buildHtmlDocument(body), "utf-8");
      return `已转换格式，保存至「${path.basename(dst)}」`;
    }

    return `Windows 暂不支持「${srcExt}」转「${dstExt}」。支持 .txt/.md/.html -> PDF 及 .txt/.md -> HTML。`;
  } catch (error) {
    return `文档转换失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================================
// Tool dispatcher (mirrors macos.ts:executeTool)
// ============================================================================

export async function executeTool(name: string, argsJson: string): Promise<string> {
  requireLicenseAccess();
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    log(`[windows] executeTool: ${name} with args ${argsJson}`);

    switch (name) {
      case "screen_snapshot": {
        const { savePrimaryScreenSnapshot } = await import("../vision/screenCapture");
        const { getFloatWindow } = await import("../windows/floatWindow");
        const { getPanelWindow } = await import("../windows/panelWindow");
        const snapshot = await savePrimaryScreenSnapshot([getFloatWindow(), getPanelWindow()], "observe");
        const frontmost = await getFrontmostApplication();
        return `已读取当前屏幕。\n前台应用：${frontmost}\n截图：${snapshot.path}\n尺寸：${snapshot.width}x${snapshot.height}`;
      }
      case "web_search": {
        const { webSearch } = await import("./search");
        return await webSearch(String(args.query));
      }
      case "scrape_url": {
        const { scrapeUrl } = await import("./search");
        return await scrapeUrl(String(args.url));
      }
      case "search_wallpapers": {
        const { searchWallpapers } = await import("./search");
        return await searchWallpapers(String(args.query));
      }
      case "diagnose_application":
        return await diagnoseApplication(String(args.name));
      case "open_application":
        return await openApplication(String(args.name));
      case "quit_application":
        return await quitApplication(String(args.name));
      case "quit_all_applications": {
        const excludes = args.exclude_names
          ? (Array.isArray(args.exclude_names) ? args.exclude_names.map(String) : [String(args.exclude_names)])
          : [];
        return await quitAllApplications(excludes);
      }
      case "type_text":
        return await typeText(String(args.text));
      case "press_keys":
        return await pressKeys(String(args.keys));
      case "focus_application_search":
        return await focusApplicationSearch(String(args.name));
      case "select_application_search_result":
        return await selectApplicationSearchResult(String(args.name));
      case "open_contact_chat":
        return await openContactChat(String(args.name), String(args.contact));
      case "stage_file_attachment":
        return await stageFileAttachment(String(args.name), String(args.path));
      case "confirm_staged_attachment":
        return await confirmStagedAttachment(String(args.name));
      case "desktop_click":
        return await desktopClick(
          Number(args.x),
          Number(args.y),
          Number(args.screenshot_width),
          Number(args.screenshot_height),
        );
      case "desktop_double_click":
        return await desktopDoubleClick(Number(args.x), Number(args.y), Number(args.screenshot_width), Number(args.screenshot_height));
      case "desktop_right_click":
        return await desktopRightClick(Number(args.x), Number(args.y), Number(args.screenshot_width), Number(args.screenshot_height));
      case "desktop_scroll":
        return await desktopScroll(Number(args.x), Number(args.y), Number(args.screenshot_width), Number(args.screenshot_height), String(args.direction));
      case "desktop_drag":
        return await desktopDrag(
          Number(args.x), Number(args.y), Number(args.end_x), Number(args.end_y),
          Number(args.screenshot_width), Number(args.screenshot_height),
        );
      case "get_frontmost_application":
        return await getFrontmostApplication();
      case "read_selected_text":
        return await readSelectedText();
      case "get_clipboard_text":
        return await getClipboardText();
      case "write_clipboard_text":
        return await writeClipboardText(String(args.text));
      case "copy_file_to_clipboard":
        return await copyFileToClipboard(String(args.path));
      case "get_current_time":
        return await getCurrentTime();
      case "weather_forecast": {
        const { weatherForecast } = await import("./weather");
        const days = parseInt(String(args.days ?? "1"), 10);
        return await weatherForecast(String(args.city), isNaN(days) ? 1 : Math.min(Math.max(days, 1), 10));
      }
      case "read_file":
        return await readFile(String(args.path));
      case "write_file":
        return await writeFile(String(args.path), String(args.content ?? ""));
      case "create_file":
        return await createFile(String(args.path), String(args.content ?? ""));
      case "delete_file":
        return await deleteFile(String(args.path));
      case "download_media":
        return await downloadMedia(
          String(args.url),
          args.type ? String(args.type) : "video",
          args.destination ? String(args.destination) : undefined,
        );
      case "list_directory":
        return await listDirectory(String(args.path ?? "~/Desktop"));
      case "run_shell_command":
        return await runShellCommand(String(args.command), args.shell === "powershell" ? "powershell" : "cmd");
      case "set_timer": {
        const s = parseInt(String(args.seconds), 10);
        return await setTimer(isNaN(s) ? 300 : s);
      }
      case "set_alarm":
        return await setAlarm(String(args.time), args.label ? String(args.label) : undefined);
      case "search_maps":
        return await searchMaps(String(args.query));
      case "sports_schedule": {
        const { sportsSchedule } = await import("./sports");
        return await sportsSchedule(String(args.league));
      }
      case "open_url":
        return await openUrl(String(args.url));
      case "trim_video":
        return await trimVideo(
          String(args.source),
          String(args.start),
          String(args.end),
          args.output ? String(args.output) : undefined,
        );
      case "convert_video":
        return await convertVideo(
          String(args.source),
          String(args.format),
          args.output ? String(args.output) : undefined,
        );
      case "office_document":
        return await officeDocument(
          args.source ? String(args.source) : undefined,
          String(args.operation ?? "inspect") as "create" | "inspect" | "query" | "edit" | "validate" | "convert",
          {
            target: args.target ? String(args.target) : undefined,
            query: args.query ? String(args.query) : undefined,
            commands: args.commands ? String(args.commands) : undefined,
          },
        );
      case "convert_document":
        return await convertDocument(String(args.source), String(args.target));

      // ---- Tools not yet supported on Windows (return explicit error) ----
      case "create_note":
      case "search_notes":
      case "create_reminder":
      case "create_calendar_event":
      case "get_calendar_events":
      case "send_email":
      case "read_unread_emails":
      case "get_recent_emails":
      case "search_emails":
      case "switch_audio_output":
      case "edit_document":
      case "edit_pdf":
        return `Windows 版 Daisy 暂不支持工具「${name}」。请用其它方式完成该任务，或告知用户该功能在 Windows 上尚未实现。`;

      default:
        return `未知工具: ${name}`;
    }
  } catch (error) {
    return `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
