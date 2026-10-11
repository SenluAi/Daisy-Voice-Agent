import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config, getBundledBin } from "../config/env";
import { log } from "../utils/logger";
import { SpeechActivityDetector } from "./voiceFilter";

const execFileAsync = promisify(execFile);
const ENDPOINT_SILENCE_MS = 2000;
const RESULT_WAIT_MS = 5000;
const FINAL_TEXT_STABLE_MS = 1200;
const MIN_POST_SUBMIT_WAIT_MS = 800;
let wechatDefaultInputMethodReady = false;
let wechatDefaultInputMethodTask: Promise<void> | null = null;

function powershellExecutable(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function wechatInstallRoots(): string[] {
  return [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Tencent", "WeType"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"]!, "Tencent", "WeType"),
  ].filter((value): value is string => Boolean(value));
}

export function isWechatInputMethodInstalled(): boolean {
  return process.platform === "win32" && wechatInstallRoots().some((root) => fs.existsSync(root));
}

export async function setWechatInputMethodAsDefault(force = false): Promise<void> {
  if (process.platform !== "win32") return;
  if (wechatDefaultInputMethodTask) return wechatDefaultInputMethodTask;
  if (!force && wechatDefaultInputMethodReady) return;

  const task = (async () => {
  const script = String.raw`$root = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\CTF\TIP'
$inputTip = $null
foreach ($tip in Get-ChildItem -LiteralPath $root -ErrorAction Stop) {
  $languagePath = Join-Path $tip.PSPath 'LanguageProfile\0x00000804'
  if (-not (Test-Path -LiteralPath $languagePath)) { continue }
  foreach ($profile in Get-ChildItem -LiteralPath $languagePath -ErrorAction SilentlyContinue) {
    $properties = Get-ItemProperty -LiteralPath $profile.PSPath -ErrorAction SilentlyContinue
    if ($properties.Description -match 'WeType|微信输入法') {
      $inputTip = '0804:' + $tip.PSChildName + $profile.PSChildName
      break
    }
  }
  if ($inputTip) { break }
}
if (-not $inputTip) { throw '未找到微信输入法的 Windows 文本服务配置' }
Set-WinDefaultInputMethodOverride -InputTip $inputTip
[Console]::Out.Write($inputTip)`;

  const { stdout } = await execFileAsync(
    powershellExecutable(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5000, windowsHide: true },
  );
  const inputTip = stdout.trim();
  if (!/^0804:\{[0-9a-f-]+\}\{[0-9a-f-]+\}$/i.test(inputTip)) {
    throw new Error(`设置微信输入法为默认输入法失败（${inputTip || "未返回输入法标识"}）`);
  }
  wechatDefaultInputMethodReady = true;
  log(`Wechat input method set as Windows default: ${inputTip}`);
  })();
  wechatDefaultInputMethodTask = task;
  try {
    await task;
  } finally {
    if (wechatDefaultInputMethodTask === task) wechatDefaultInputMethodTask = null;
  }
}

export type WechatInputMode = "hold" | "toggle";

export class WechatInputAsrSession extends EventEmitter {
  private captureProcess: ReturnType<typeof spawn> | null = null;
  private targetHandle = "0";
  private pendingText = "";
  private lastText = "";
  private lastTextChangedAt = 0;
  private active = false;
  private stopping = false;
  private recognitionReady = false;
  private shortcutActive = false;
  private shortcutStarting = false;
  private pendingHostCommand: {
    response: "STARTED" | "STOPPED";
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private endpointEmitted = false;
  private lastSpeechAt = 0;
  private speechConfirmed = false;
  private readonly speechActivity = new SpeechActivityDetector();

  constructor(private readonly mode: WechatInputMode = "toggle") {
    super();
  }

  getLastText(): string {
    return this.lastText;
  }

  hasSpeechActivity(): boolean {
    return this.speechConfirmed;
  }

  isHoldMode(): boolean {
    return this.mode === "hold";
  }

  isRecognitionReady(): boolean {
    return this.recognitionReady;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    this.recognitionReady = false;
    this.shortcutActive = false;
    this.shortcutStarting = false;
    this.lastText = "";
    this.pendingText = "";
    this.lastTextChangedAt = 0;
    this.endpointEmitted = false;
    this.lastSpeechAt = 0;
    this.speechConfirmed = false;
    this.speechActivity.reset();
    void this.launch().catch((error) => {
      if (!this.active) {
        this.cleanupCaptureHost();
        return;
      }
      this.fail(`微信输入法启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async launch(): Promise<void> {
    if (process.platform !== "win32" || !isWechatInputMethodInstalled()) {
      this.fail("未检测到微信输入法");
      return;
    }
    await setWechatInputMethodAsDefault();
    if (!this.active) return;
    this.targetHandle = await this.launchCaptureHost();
    if (!this.active) return;

    this.shortcutStarting = true;
    try {
      await this.sendHostCommand(this.mode === "hold" ? "START_HOLD" : "START_TOGGLE");
    } finally {
      this.shortcutStarting = false;
    }
    this.shortcutActive = true;
    if (!this.active) {
      try { await this.sendHostCommand(this.mode === "hold" ? "STOP_HOLD" : "STOP_TOGGLE"); }
      catch { /* Host cleanup releases the hotkey. */ }
      this.shortcutActive = false;
      this.cleanupCaptureHost();
      return;
    }
    this.recognitionReady = true;
    log(`WechatInputAsrSession: Daisy listening active, WeChat ${this.mode} started`);
    this.emit("ready");
  }

  private sendHostCommand(command: "START_HOLD" | "STOP_HOLD" | "START_TOGGLE" | "STOP_TOGGLE"): Promise<void> {
    const child = this.captureProcess;
    if (!child || child.exitCode !== null || !child.stdin || this.pendingHostCommand) {
      return Promise.reject(new Error("微信输入法文字接收窗口不可用"));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        response: command.startsWith("START_") ? "STARTED" as const : "STOPPED" as const,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingHostCommand !== pending) return;
          this.pendingHostCommand = null;
          reject(new Error(`微信输入法${command.startsWith("START_") ? "启动" : "结束"}超时`));
        }, 4000),
      };
      this.pendingHostCommand = pending;
      child.stdin!.write(`${command}\n`, (error) => {
        if (!error || this.pendingHostCommand !== pending) return;
        clearTimeout(pending.timer);
        this.pendingHostCommand = null;
        reject(error);
      });
    });
  }

  private acceptHostCommandResult(line: string): void {
    const pending = this.pendingHostCommand;
    if (!pending || !line.startsWith(`${pending.response}:`)) return;
    this.pendingHostCommand = null;
    clearTimeout(pending.timer);
    if (/^(STARTED|STOPPED):true:0$/i.test(line)) pending.resolve();
    else pending.reject(new Error(`微信输入法快捷键发送失败（${line}）`));
  }

  private launchCaptureHost(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        getBundledBin("daisy-wechat-input-host"),
        [],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      this.captureProcess = child;
      child.stdin?.on("error", () => { /* A canceled host may close stdin before EXIT is written. */ });
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let ready = false;
      const timeout = setTimeout(() => {
        if (ready) return;
        this.captureProcess = null;
        child.kill();
        reject(new Error(`原生文字接收窗口启动超时${stderrBuffer ? `：${stderrBuffer.trim()}` : ""}`));
      }, 5000);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("READY:")) {
            const handle = line.slice(6).trim();
            if (!ready && /^\d+$/.test(handle) && handle !== "0") {
              ready = true;
              clearTimeout(timeout);
              resolve(handle);
            }
            continue;
          }
          if (line.startsWith("TEXT:")) {
            try {
              this.acceptCaptureText(Buffer.from(line.slice(5), "base64").toString("utf8"));
            } catch { /* Ignore malformed receiver output. */ }
          }
          if (line.startsWith("STARTED:") || line.startsWith("STOPPED:")) {
            this.acceptHostCommandResult(line);
          }
          if (line.startsWith("DIAG:HOLD_KEYS:") || line.startsWith("DIAG:WECHAT_PROFILE:")) {
            log(`WechatInputAsrSession: ${line}`);
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderrBuffer += chunk; });
      child.once("error", (error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        else if (this.active && !this.stopping && this.captureProcess === child) this.fail(`微信输入法文字接收进程异常：${error.message}`);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`原生文字接收窗口启动失败（退出码 ${code ?? "未知"}）${stderrBuffer ? `：${stderrBuffer.trim()}` : ""}`));
        else if (this.active && !this.stopping && this.captureProcess === child) this.fail("微信输入法文字接收窗口意外退出");
      });
    });
  }

  private acceptCaptureText(value: string): void {
    const text = value.trim();
    this.pendingText = text;
    if (!text || (this.mode !== "hold" && !this.speechConfirmed) || text === this.lastText) return;
    this.lastText = text;
    this.lastTextChangedAt = Date.now();
    this.emit("partial", text);
  }

  feedPcm(buffer: Buffer): void {
    if (!this.active || !this.recognitionReady || this.stopping || this.endpointEmitted || buffer.length < 2) return;
    const analysis = this.speechActivity.feed(
      buffer,
      config.asr.wechatSpeechRmsThreshold,
      config.asr.microphoneSensitivity,
    );
    if (analysis.speechLike) {
      this.lastSpeechAt = Date.now();
      if (analysis.confirmed && !this.speechConfirmed) {
        this.speechConfirmed = true;
        this.acceptCaptureText(this.pendingText);
      }
      return;
    }
    if (!this.speechConfirmed) {
      this.lastSpeechAt = 0;
      return;
    }
    if (this.lastSpeechAt > 0 && Date.now() - this.lastSpeechAt >= ENDPOINT_SILENCE_MS) {
      this.endpointEmitted = true;
      log("WechatInputAsrSession: detected 2s speech silence, submitting immediately");
      this.emit("endpoint");
    }
  }

  async stop(): Promise<void> {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    try {
      for (let attempt = 0; this.active && !this.shortcutActive && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      if (!this.active) return;
      if (!this.shortcutActive) {
        this.fail("微信输入法未能随 Daisy 启动");
        return;
      }
      if (!this.captureProcess || this.captureProcess.exitCode !== null || this.targetHandle === "0") {
        this.fail("微信输入法文字接收窗口不可用");
        return;
      }
      await this.sendHostCommand(this.mode === "hold" ? "STOP_HOLD" : "STOP_TOGGLE");
      this.shortcutActive = false;
      if (!this.active) {
        this.cleanupCaptureHost();
        return;
      }
      log(`WechatInputAsrSession: Daisy listening ended, WeChat ${this.mode} submitted`);

      const submittedAt = Date.now();
      const deadline = submittedAt + RESULT_WAIT_MS;
      while (this.active && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = Date.now();
        const stableSince = Math.max(this.lastTextChangedAt, submittedAt);
        if (
          this.lastText &&
          now - submittedAt >= MIN_POST_SUBMIT_WAIT_MS &&
          now - stableSince >= FINAL_TEXT_STABLE_MS
        ) {
          this.finish();
          return;
        }
      }
      if (this.active) this.fail("微信输入法未返回识别文字");
    } catch (error) {
      if (!this.active) this.cleanupCaptureHost();
      else this.fail(`无法结束微信输入法语音识别：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.recognitionReady = false;
    if (this.shortcutStarting || this.pendingHostCommand?.response === "STOPPED") return;
    if (this.shortcutActive && this.captureProcess?.exitCode === null && this.targetHandle !== "0") {
      void this.sendHostCommand(this.mode === "hold" ? "STOP_HOLD" : "STOP_TOGGLE")
        .catch(() => {})
        .finally(() => this.cleanupCaptureHost());
      this.shortcutActive = false;
      return;
    }
    this.shortcutActive = false;
    this.cleanupCaptureHost();
  }

  reset(): void {
    this.cancel();
    this.lastText = "";
  }

  private finish(): void {
    if (!this.active) return;
    this.active = false;
    this.recognitionReady = false;
    this.cleanupCaptureHost();
    log(`WechatInputAsrSession: final="${this.lastText}"`);
    this.emit("final", this.lastText);
  }

  private fail(message: string): void {
    if (!this.active) return;
    this.active = false;
    this.recognitionReady = false;
    this.shortcutActive = false;
    this.cleanupCaptureHost();
    log(`WechatInputAsrSession: ${message}`);
    this.emit("error", message);
  }


  private cleanupCaptureHost(): void {
    const child = this.captureProcess;
    this.captureProcess = null;
    this.targetHandle = "0";
    this.pendingText = "";
    const pending = this.pendingHostCommand;
    this.pendingHostCommand = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("微信输入法接收进程已关闭"));
    }
    if (child && child.exitCode === null) {
      try { child.stdin?.end("EXIT\n"); } catch { /* Process may already be gone. */ }
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 500);
      child.once("exit", () => clearTimeout(killTimer));
    }
  }
}
