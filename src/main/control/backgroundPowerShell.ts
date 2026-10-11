import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface PowerShellOptions {
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
}

export function findPowerShell(): string {
  const candidates = [path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    ...(process.env.PATH || "").split(path.delimiter).map(directory => path.join(directory, "pwsh.exe"))];
  return candidates.find(file => fs.existsSync(file)) || "powershell.exe";
}

/** A file-backed, non-interactive runner: no shared console or parser interpolation. */
export async function runBackgroundPowerShell(script: string, options: PowerShellOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw options.signal.reason || new DOMException("Command cancelled", "AbortError");
  const temporary = path.join(os.tmpdir(), `daisy-ps-${randomUUID()}.ps1`);
  // Windows PowerShell 5.1 needs a BOM to decode Chinese scripts correctly.
  fs.writeFileSync(temporary, "\ufeff[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + script, { flag: "wx", mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => {
      let stopped: Error | undefined;
      const child = execFile(options.executable || "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", temporary],
        { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          if (stopped || error) reject(stopped || error);
          else resolve({ stdout, stderr });
        });
      const stop = (error: Error) => {
        if (stopped) return;
        stopped = error;
        // Kill the script's children too; killing only PowerShell can leave a CLI running.
        if (child.pid && process.platform === "win32") {
          execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => child.kill());
        } else child.kill();
      };
      const cancel = () => stop(new DOMException("Command cancelled", "AbortError"));
      const timer = setTimeout(() => stop(new DOMException("Command timed out", "TimeoutError")), options.timeout ?? 30_000);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already removed */ }
  }
}

export function commandScript(script: string): string {
  return "$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n" + script + "\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n";
}
