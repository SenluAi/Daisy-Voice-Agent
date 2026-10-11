import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpEntry } from "../../shared/extensions";
import { backgroundPowerShellTools, callBackgroundPowerShell, isPowerShellMcp } from "./powerShellMcp";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: "stdio" | "http" | "streamable-http" | "sse";
  disabled?: boolean;
  serverName?: string;
  cwd?: string;
  toolCallTimeoutMs?: number;
  failOnStartupError?: boolean;
  reconnect?: { enabled: boolean };
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOOLS = 10_000;
const SERVER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const FIELDS = new Set(["command", "args", "env", "url", "headers", "transport", "disabled", "serverName", "cwd", "toolCallTimeoutMs", "failOnStartupError", "reconnect"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown, headers: boolean): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 256) throw new Error("Invalid MCP string map");
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const validKey = headers ? /^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/ : /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!validKey.test(key) || typeof item !== "string" || item.length > 65_536 ||
        item.includes("\0") || (headers && /[\r\n]/.test(item))) {
      throw new Error(headers ? "Invalid MCP headers" : "Invalid MCP environment");
    }
    result[key] = item;
  }
  return result;
}

/** Parse and validate without touching files, processes, or existing connections. */
export function validate(json: string): McpConfig {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("MCP configuration must be JSON smaller than 1 MiB");
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Invalid MCP JSON"); }
  if (!record(value) || Object.keys(value).some((key) => key !== "mcpServers") ||
      !record(value.mcpServers) || Object.keys(value.mcpServers).length > 100) {
    throw new Error("MCP configuration requires a mcpServers object (maximum 100 servers)");
  }
  const mcpServers: Record<string, McpServerConfig> = Object.create(null);
  for (const [id, item] of Object.entries(value.mcpServers)) {
    if (!SERVER_ID.test(id) || ["__proto__", "prototype", "constructor"].includes(id) ||
        !record(item) || Object.keys(item).some((key) => !FIELDS.has(key))) {
      throw new Error("Invalid MCP server definition");
    }
    const config: McpServerConfig = {};
    if (item.serverName !== undefined) {
      if (typeof item.serverName !== "string" || !SERVER_ID.test(item.serverName)) throw new Error("Invalid MCP server name");
      config.serverName = item.serverName;
    }
    if (item.toolCallTimeoutMs !== undefined) {
      if (!Number.isSafeInteger(item.toolCallTimeoutMs) || Number(item.toolCallTimeoutMs) < 1 || Number(item.toolCallTimeoutMs) > 240000) throw new Error("MCP timeout must be 1-240000ms");
      config.toolCallTimeoutMs = Number(item.toolCallTimeoutMs);
    }
    if (item.failOnStartupError !== undefined) {
      if (typeof item.failOnStartupError !== "boolean") throw new Error("Invalid MCP startup policy");
      config.failOnStartupError = item.failOnStartupError;
    }
    if (item.reconnect !== undefined) {
      if (!record(item.reconnect) || Object.keys(item.reconnect).some(x => x !== "enabled") || typeof item.reconnect.enabled !== "boolean" || item.reconnect.enabled) throw new Error("Automatic MCP reconnect is not supported; reconnect.enabled must be false");
      config.reconnect = { enabled: false };
    }
    if (item.disabled !== undefined) {
      if (typeof item.disabled !== "boolean") throw new Error("MCP disabled must be boolean");
      config.disabled = item.disabled;
    }
    if (item.transport !== undefined) {
      if (typeof item.transport !== "string" || !["stdio", "http", "streamable-http", "sse"].includes(item.transport)) {
        throw new Error("Unsupported MCP transport");
      }
      config.transport = item.transport as McpServerConfig["transport"];
    }
    const stdio = (config.transport ?? (item.url === undefined ? "stdio" : "http")) === "stdio";
    if (stdio) {
      if (typeof item.command !== "string" || !item.command.trim() || item.command.includes("\0") ||
          item.command.length > 4096 || item.url !== undefined || item.headers !== undefined) {
        throw new Error("MCP stdio requires command and does not accept url or headers");
      }
      config.command = item.command;
      if (item.args !== undefined) {
        if (!Array.isArray(item.args) || item.args.length > 256 ||
            item.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 65_536)) {
          throw new Error("MCP args must be a string array");
        }
        config.args = [...item.args] as string[];
      }
      if (item.env !== undefined) config.env = stringMap(item.env, false);
      if (item.cwd !== undefined) {
        if (typeof item.cwd !== "string" || !path.isAbsolute(item.cwd) || item.cwd.includes("\0")) throw new Error("MCP cwd must be an absolute path");
        config.cwd = item.cwd;
      }
    } else {
      if (typeof item.url !== "string" || item.url.length > 8192 ||
          item.command !== undefined || item.args !== undefined || item.env !== undefined || item.cwd !== undefined) {
        throw new Error("MCP HTTP/SSE requires url and does not accept command, args or env");
      }
      let url: URL;
      try { url = new URL(item.url); } catch { throw new Error("Invalid MCP URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error("MCP URL must use HTTP/S without credentials or fragments");
      }
      config.url = item.url;
      if (item.headers !== undefined) config.headers = stringMap(item.headers, true);
    }
    mcpServers[id] = config;
  }
  return { mcpServers };
}

function abortError(timeout = false): Error {
  const error = new Error(timeout ? "MCP operation timed out" : "MCP operation cancelled");
  error.name = timeout ? "TimeoutError" : "AbortError";
  return error;
}

async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(abortError());
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(abortError(true)), ms);
  let onAbort: (() => void) | undefined;
  try {
    if (controller.signal.aborted) throw abortError();
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

interface ManagedServer {
  config: McpServerConfig;
  entry: McpEntry;
  controller: AbortController;
  client?: Client;
  transport?: Transport;
  tools: McpTool[];
  closing?: Promise<void>;
  ready?: Promise<void>;
  disposed: boolean;
}

export class McpManager {
  private readonly root: string;
  private readonly file: string;
  private readonly servers = new Map<string, ManagedServer>();
  private readonly closing = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private configError = false;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, "mcp.json");
  }

  readConfig(): string {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
        throw new Error("Invalid MCP configuration file");
      }
      return fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return '{\n  "mcpServers": {}\n}\n';
      throw new Error("Unable to read MCP configuration");
    }
  }

  async saveConfig(json: string, expected?: string): Promise<void> {
    const config = validate(json);
    const generation = this.generation;
    return this.enqueue(async () => {
      if (expected !== undefined && this.readConfig() !== expected) throw new Error("MCP 配置已变化，请刷新后重试。");
      this.writeConfig(config);
      await this.applyConfig(config, generation, false);
    });
  }

  start(): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      let config: McpConfig;
      try { config = validate(this.readConfig()); } catch {
        this.configError = true;
        return;
      }
      await this.applyConfig(config, generation);
    });
  }

  configureTransient(json: string): Promise<void> {
    const config = validate(json);
    const generation = this.generation;
    return this.enqueue(() => this.applyConfig(config, generation));
  }

  snapshot(): McpEntry[] {
    const entries = [...this.servers.values()].map((server) => ({ ...server.entry }));
    if (this.configError) entries.push({ id: "configuration", enabled: false, status: "error", toolCount: 0, error: "Invalid MCP configuration" });
    return entries;
  }

  listTools(): McpTool[] {
    return structuredClone([...this.servers.values()].filter((server) => server.entry.status === "connected")
      .flatMap((server) => server.tools));
  }

  async callTool(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError();
    if (!record(args)) throw new Error("MCP tool arguments must be an object");
    const server = [...this.servers.values()].find((item) =>
      item.entry.status === "connected" && item.tools.some((tool) => tool.id === id));
    if (!server?.client) throw new Error("MCP tool unavailable");
    const tool = server.tools.find((item) => item.id === id)!;
    const parent = signal ? AbortSignal.any([signal, server.controller.signal]) : server.controller.signal;
    if (isPowerShellMcp(server.config)) return callBackgroundPowerShell(tool.name, args, server.config, parent);
    try {
      const result = await deadline((requestSignal) => server.client!.callTool(
        { name: tool.name, arguments: args }, undefined,
        { signal: requestSignal, timeout: server.config.toolCallTimeoutMs ?? CALL_TIMEOUT_MS, maxTotalTimeout: server.config.toolCallTimeoutMs ?? CALL_TIMEOUT_MS },
      ), server.config.toolCallTimeoutMs ?? CALL_TIMEOUT_MS, parent);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.flatMap((item) => {
        if (item.type === "text" && typeof item.text === "string") return [item.text];
        if (item.type === "resource" && record(item.resource) && typeof item.resource.text === "string") return [item.resource.text];
        return [];
      }).join("\n");
      const output = text || JSON.stringify(result.structuredContent ?? content);
      return result.isError ? `MCP tool error: ${output}` : output;
    } catch (error) {
      if (parent.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
      if ((error instanceof Error && error.name === "TimeoutError") || (record(error) && error.code === -32001)) throw abortError(true);
      throw new Error("MCP tool call failed");
    }
  }

  close(): Promise<void> {
    this.generation++;
    for (const server of this.servers.values()) server.controller.abort();
    return this.enqueue(async () => {
      const servers = [...this.servers.values()];
      this.servers.clear();
      this.configError = false;
      await Promise.all([...servers.map((server) => this.dispose(server)), ...this.closing]);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private writeConfig(config: McpConfig): void {
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error("Invalid MCP configuration directory");
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid MCP configuration file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to save MCP configuration");
    }
    const temporary = path.join(this.root, `.mcp-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch { throw new Error("Unable to save MCP configuration"); } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }

  private async applyConfig(config: McpConfig, generation: number, wait = true): Promise<void> {
    if (generation !== this.generation) return;
    this.configError = false;
    const removed: ManagedServer[] = [];
    for (const [id, server] of this.servers) {
      const next = config.mcpServers[id];
      if (!next || JSON.stringify(next) !== JSON.stringify(server.config) || server.entry.status === "error") {
        this.servers.delete(id);
        removed.push(server);
      }
    }
    for (const server of removed) void this.dispose(server);
    if (generation !== this.generation) return;
    for (const [id, settings] of Object.entries(config.mcpServers)) {
      if (this.servers.has(id)) continue;
      const server: ManagedServer = {
        config: settings, controller: new AbortController(), tools: [], disposed: false,
        entry: { id, enabled: !settings.disabled, status: settings.disabled ? "disabled" : "connecting", toolCount: 0 },
      };
      this.servers.set(id, server);
      if (!settings.disabled) server.ready = this.connect(server);
    }
    if (wait) await Promise.all([...this.servers.values()].map((server) => server.ready));
  }

  private async connect(server: ManagedServer): Promise<void> {
    const config = server.config;
    try {
      const client = new Client({ name: "Daisy", version: "1.0.0" }, { capabilities: {} });
      server.client = client;
      client.onerror = () => {
        if (server.disposed) return;
        server.entry.status = "error";
        server.entry.error = "MCP connection failed";
        server.entry.toolCount = 0;
        server.tools = [];
        void this.dispose(server);
      };
      client.onclose = () => {
        if (server.disposed) return;
        server.entry.status = "error";
        server.entry.error = "MCP connection closed";
        server.entry.toolCount = 0;
        server.tools = [];
        void this.dispose(server);
      };
      if (config.command) {
        server.transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: "ignore" });
      } else {
        const fetchWithTimeout: typeof fetch = async (input, init) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
          try {
            return await fetch(input, {
              ...init, signal: AbortSignal.any([server.controller.signal, controller.signal, ...(init?.signal ? [init.signal] : [])]),
            });
          } finally { clearTimeout(timer); }
        };
        const options = { requestInit: { headers: config.headers, redirect: "error" as const }, fetch: fetchWithTimeout };
        server.transport = config.transport === "sse"
          ? new SSEClientTransport(new URL(config.url!), {
            ...options, eventSourceInit: { fetch: (input, init) => {
              const headers = new Headers(config.headers);
              new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
              return fetchWithTimeout(input, { ...init, headers, redirect: "error" });
            } },
          })
          : new StreamableHTTPClientTransport(new URL(config.url!), {
            ...options, reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
          });
      }
      const tools = await deadline(async (signal) => {
        await client.connect(server.transport!, { signal, timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
        if (!client.getServerCapabilities()?.tools) return [];
        const found: McpTool[] = [];
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
          for (const tool of page.tools) {
            if (names.has(tool.name) || found.length >= MAX_TOOLS) throw new Error("Invalid MCP tool list");
            names.add(tool.name);
            found.push({ id: `mcp:${server.entry.id}:${tool.name}`, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema });
          }
          cursor = page.nextCursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid MCP pagination");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return found;
      }, CONNECT_TIMEOUT_MS, server.controller.signal);
      if (server.disposed || server.controller.signal.aborted) return;
      server.tools = isPowerShellMcp(config) ? backgroundPowerShellTools(tools) : tools;
      server.entry = { id: server.entry.id, enabled: true, status: "connected", toolCount: server.tools.length };
    } catch (error) {
      server.tools = [];
      server.entry.status = "error";
      server.entry.toolCount = 0;
      server.entry.error = error instanceof Error && error.name === "TimeoutError" ? "MCP connection timed out" : "MCP connection failed";
      await this.dispose(server);
    }
  }

  private dispose(server: ManagedServer): Promise<void> {
    if (server.closing) return server.closing;
    server.disposed = true;
    server.controller.abort();
    server.closing = (async () => {
      try { await deadline(async () => { await server.client?.close(); }, CLOSE_TIMEOUT_MS); } catch {
        try { await deadline(async () => { await server.transport?.close(); }, CLOSE_TIMEOUT_MS); } catch {}
      }
      server.tools = [];
    })();
    this.closing.add(server.closing);
    void server.closing.then(() => this.closing.delete(server.closing!));
    return server.closing;
  }
}
