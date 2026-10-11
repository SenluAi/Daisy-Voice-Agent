import path from "node:path";
import os from "node:os";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commandScript, findPowerShell, runBackgroundPowerShell } from "../control/backgroundPowerShell";
import type { McpServerConfig, McpTool } from "./mcp";

export function isPowerShellMcp(config: McpServerConfig): boolean {
  return process.platform === "win32" && !!config.command && path.win32.basename(config.command).toLowerCase() === "powershell.mcp.proxy.exe";
}

export function backgroundPowerShellTools(tools: McpTool[]): McpTool[] {
  return tools.filter(tool => ["execute_command", "get_current_location"].includes(tool.name)).map(tool => ({ ...tool,
    description: tool.name === "execute_command"
      ? "通过 Daisy 后台直接执行 PowerShell 脚本，不打开控制台。每次调用独立，无持久会话；将相关变量、目录切换放在同一脚本中。var1...var8 按原文注入。文本文件优先用 Daisy 文件工具，标准 PowerShell cmdlet 可用。"
      : "读取 Daisy 后台 PowerShell 的默认工作目录、运行环境和可用驱动器，不启动交互控制台。",
    inputSchema: tool.name === "execute_command" ? { type: "object", properties: {
      pipeline: { type: "string", description: "要后台执行的 PowerShell 脚本，支持多行。" },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 240, description: "等待执行完成的秒数；超时停止脚本，默认 30 秒。" },
      ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`var${index + 1}`, { type: ["string", "null"] }])),
    }, required: ["pipeline"], additionalProperties: false } : { type: "object", properties: {}, additionalProperties: false },
  }));
}

export async function callBackgroundPowerShell(name: string, args: Record<string, unknown>, config: McpServerConfig, signal: AbortSignal): Promise<string> {
  let script: string;
  if (name === "execute_command") {
    if (typeof args.pipeline !== "string" || !args.pipeline.trim() || args.pipeline.includes("\0")) throw new Error("PowerShell pipeline must be a non-empty script");
    const variables = Array.from({ length: 8 }, (_, index) => {
      const key = `var${index + 1}`, value = args[key];
      if (value !== undefined && value !== null && (typeof value !== "string" || value.includes("\0"))) throw new Error("PowerShell variables must be literal strings");
      return `$${key} = ${typeof value === "string" ? "'" + value.replace(/'/g, "''") + "'" : "$null"}`;
    }).join("\n");
    script = commandScript(variables + "\n" + args.pipeline);
  } else if (name === "get_current_location") {
    script = "@{ current_location = (Get-Location).Path; system = @{ os = [Environment]::OSVersion.ToString(); powershell_version = $PSVersionTable.PSVersion.ToString() }; available_drives = @(Get-PSDrive | Select-Object Name,Root,@{n='provider';e={$_.Provider.Name}}) } | ConvertTo-Json -Depth 5";
  } else throw new Error("Interactive PowerShell consoles are disabled; use run_shell_command");
  const seconds = args.timeout_seconds;
  if (seconds !== undefined && (!Number.isSafeInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 240)) throw new Error("PowerShell timeout must be 1-240 seconds");
  const environment = getDefaultEnvironment();
  // PowerShell needs PATHEXT to recognize native CLIs; keep credentials isolated.
  for (const key of ["PATHEXT", "COMSPEC"]) {
    if (process.env[key]) environment[key] = process.env[key]!;
  }
  const { stdout, stderr } = await runBackgroundPowerShell(script, {
    signal, timeout: Math.min(seconds === undefined ? 30_000 : Number(seconds) * 1000, config.toolCallTimeoutMs ?? 30_000),
    cwd: config.cwd || os.homedir(), env: { ...environment, ...config.env }, executable: findPowerShell(),
  });
  return (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim() || "命令执行完成（无输出）";
}
