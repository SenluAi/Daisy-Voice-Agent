import { app, utilityProcess, type UtilityProcess } from "electron";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { HostOperation, PluginPanelEndpoint } from "./harnessServer";
import { DaisySpeechService, speechCatalog } from "./speechService";
import type { SpeechCatalog } from "./speechContract";
import { PluginCredentialStore } from "./credentialStore";

export interface PluginLoadEntry {
  id: string;
  directory: string;
  config?: Record<string, unknown>;
}

export interface PluginLoadResult {
  status: "ready" | "requires_host" | "error";
  error?: string;
  panelAvailable?: boolean;
}

export interface PluginTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type HostRequest =
  | { type: "load"; requestId: number; entry: PluginLoadEntry; userData: string; speech: SpeechCatalog }
  | { type: "call"; requestId: number; name: string; args: Record<string, unknown> }
  | { type: "unload"; requestId: number }
  | { type: "cancel"; requestId: number };

export type HostResponse = { type: "host-result"; callId: number; result?: unknown; error?: string }
  | { type: "speech-catalog"; catalog: SpeechCatalog };

export type WorkerMessage =
  | { type: "response"; requestId: number; ok: true; result: unknown }
  | { type: "response"; requestId: number; ok: false; error: string }
  | { type: "tools"; tools: PluginTool[] }
  | { type: "host-call"; callId: number; operation: HostOperation; payload: Record<string, unknown> }
  | { type: "host-cancel"; callId: number }
  | { type: "failure"; error: string; status?: "requires_host" | "error" };

const MAX_TOOLS = 64;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const LOAD_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const UNLOAD_TIMEOUT_MS = 2_000;
const CANCEL_GRACE_MS = 1_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  detach?: () => void;
}

interface PluginProcess {
  id: string;
  userData: string;
  child?: UtilityProcess;
  ready: boolean;
  ended: boolean;
  unloading: boolean;
  tools: PluginTool[];
  pending: Map<number, PendingRequest>;
  cancellations: Map<number, NodeJS.Timeout>;
  hostCalls: Map<number, AbortController>;
  failure?: Error;
  panel?: PluginPanelEndpoint;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(): Error {
  const error = new Error("Plugin tool call was cancelled");
  error.name = "AbortError";
  return error;
}

// A utility process isolates failures, but is not a security sandbox.
function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path", "systemroot", "windir", "systemdrive", "comspec", "pathext",
    "temp", "tmp", "tmpdir", "userprofile", "home", "homedrive", "homepath",
    "appdata", "localappdata", "programdata", "programfiles", "programfiles(x86)",
    "commonprogramfiles", "commonprogramfiles(x86)", "lang", "lc_all", "lc_ctype",
    "xdg_runtime_dir", "xdg_config_home", "xdg_data_home", "xdg_cache_home",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  return env;
}

export class PluginHost {
  private credentials = new PluginCredentialStore();
  private readonly plugins = new Map<string, PluginProcess>();
  private readonly outcomes = new Map<string, PluginLoadResult>();
  private requestId = 0;
  private closed = false;
  private speech = new DaisySpeechService();
  private speechCatalogKey = "";
  private hostHandler?: (pluginId: string, operation: HostOperation, payload: Record<string, unknown>) => Promise<unknown>;

  setHostHandler(handler: NonNullable<PluginHost["hostHandler"]>): void { this.hostHandler = handler; }

  refreshSpeechCatalog(): void {
    const catalog = speechCatalog();
    const key = JSON.stringify(catalog);
    if (key === this.speechCatalogKey || this.closed) return;
    this.speechCatalogKey = key;
    for (const plugin of this.plugins.values()) {
      if (plugin.ready) {
        try { plugin.child?.postMessage({ type: "speech-catalog", catalog } satisfies HostResponse); }
        catch (error) { this.end(plugin, errorFrom(error)); }
      }
    }
  }

  panel(id: string): PluginPanelEndpoint | undefined {
    const plugin = this.plugins.get(id);
    return plugin?.ready && plugin.panel ? { ...plugin.panel } : undefined;
  }

  async load(entry: PluginLoadEntry): Promise<PluginLoadResult> {
    if (this.closed) return { status: "error", error: "Plugin host is closed" };
    if (!entry || typeof entry.id !== "string" || !entry.id || /[:\x00-\x1f]/.test(entry.id)) {
      return { status: "error", error: "Plugin id must be nonempty and contain no colon or control characters" };
    }
    if (typeof entry.directory !== "string" || !path.isAbsolute(entry.directory)) {
      return { status: "error", error: "Plugin directory must be an absolute manager-validated path" };
    }
    if (this.plugins.has(entry.id)) {
      return { status: "error", error: `Plugin ${entry.id} is already loaded or loading; unload it first` };
    }
    const plugin: PluginProcess = {
      id: entry.id, userData: path.join(app.getPath("userData"), "extensions", "plugin-data", createHash("sha256").update(entry.id).digest("hex")),
      ready: false, ended: false, unloading: false, tools: [],
      pending: new Map(), cancellations: new Map(), hostCalls: new Map(),
    };
    this.outcomes.delete(entry.id);
    this.plugins.set(entry.id, plugin);
    try {
      await app.whenReady();
      if (plugin.ended || this.closed) throw plugin.failure ?? new Error("Plugin load was cancelled");
      const child = utilityProcess.fork(path.join(__dirname, "pluginWorker.js"), [], {
        cwd: entry.directory,
        env: workerEnvironment(),
        execArgv: [],
        stdio: "ignore",
        serviceName: `Daisy plugin: ${entry.id}`,
      });
      plugin.child = child;
      child.once("spawn", () => { if (plugin.ended) child.kill(); });
      child.on("message", (message: WorkerMessage) => this.onMessage(plugin, message));
      child.on("exit", (code) => this.end(plugin, new Error(`Plugin ${entry.id} process exited (code ${code})`)));
      child.on("error", (type, location) => this.end(plugin, new Error(`Plugin ${entry.id} ${type}: ${location}`)));
      // Hashing keeps scoped package ids and user-chosen ids out of directory paths.
      const userData = plugin.userData;
      const reply = await this.request(plugin, {
        type: "load", requestId: ++this.requestId, entry, userData, speech: speechCatalog(),
      }, LOAD_TIMEOUT_MS) as PluginLoadResult & { tools?: PluginTool[]; panel?: PluginPanelEndpoint };
      if (!reply || !["ready", "requires_host", "error"].includes(reply.status)) {
        throw new Error("Invalid plugin load response");
      }
      if (reply.status !== "ready") {
        this.end(plugin, new Error(reply.error ?? `Plugin ${entry.id} ${reply.status}`));
        this.outcomes.set(entry.id, { status: reply.status, error: reply.error });
        return { status: reply.status, error: reply.error };
      }
      if (plugin.ended) throw plugin.failure ?? new Error("Plugin process ended during load");
      this.updateTools(plugin, reply.tools);
      if (reply.panel) {
        const url = new URL(reply.panel.origin);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
          || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(reply.panel.token)) throw new Error("Invalid plugin panel endpoint");
        plugin.panel = reply.panel;
      }
      plugin.ready = true;
      return { status: "ready", ...(plugin.panel ? { panelAvailable: true } : {}) };
    } catch (error) {
      const failure = errorFrom(error);
      this.end(plugin, failure);
      return { status: "error", error: failure.message };
    }
  }

  async unload(id: string): Promise<void> {
    this.outcomes.delete(id);
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.unloading = true;
    plugin.ready = false;
    plugin.tools = [];
    this.rejectPending(plugin, new Error(`Plugin ${id} was unloaded`));
    try {
      if (plugin.child && !plugin.ended) {
        await this.request(plugin, { type: "unload", requestId: ++this.requestId }, UNLOAD_TIMEOUT_MS);
      }
    } catch {
      // A stuck disposer is bounded by the unload timeout and process termination.
    } finally {
      this.end(plugin, new Error(`Plugin ${id} was unloaded`));
    }
  }

  listTools(): PluginTool[] {
    return Array.from(this.plugins.values()).flatMap((plugin) =>
      plugin.ready ? structuredClone(plugin.tools) : []);
  }

  status(id: string): PluginLoadResult | undefined {
    const plugin = this.plugins.get(id);
    if (plugin?.ready && !plugin.ended) return { status: "ready", ...(plugin.panel ? { panelAvailable: true } : {}) };
    const outcome = this.outcomes.get(id);
    return outcome ? { ...outcome } : undefined;
  }

  async callTool(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError();
    for (const plugin of this.plugins.values()) {
      if (!plugin.ready) continue;
      const tool = plugin.tools.find((candidate) => candidate.id === id);
      if (!tool) continue;
      const result = await this.request(plugin, {
        type: "call", requestId: ++this.requestId, name: tool.name, args,
      }, CALL_TIMEOUT_MS, signal);
      if (typeof result !== "string") throw new Error("Invalid plugin tool response: expected string");
      return result;
    }
    throw new Error(`Unknown or unavailable plugin tool: ${id}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.outcomes.clear();
    for (const plugin of this.plugins.values()) this.end(plugin, new Error("Plugin host is closed"));
    this.speech.close();
  }

  private request(plugin: PluginProcess, message: Exclude<HostRequest, { type: "cancel" }>,
    timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (plugin.ended || !plugin.child) {
        reject(plugin.failure ?? new Error(`Plugin ${plugin.id} is not running`));
        return;
      }
      if (signal?.aborted) { reject(abortError()); return; }
      const timer = setTimeout(() => {
        const error = new Error(`Plugin ${plugin.id} ${message.type} request timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        this.end(plugin, error);
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      plugin.pending.set(message.requestId, pending);
      if (signal) {
        const cancel = () => {
          this.finishRequest(plugin, message.requestId, abortError());
          // Wait for the handler to settle; kill only this plugin if cancellation is ignored.
          plugin.cancellations.set(message.requestId, setTimeout(() => {
            this.end(plugin, new Error(`Plugin ${plugin.id} did not finish a cancelled tool call`));
          }, CANCEL_GRACE_MS));
          try {
            plugin.child?.postMessage({ type: "cancel", requestId: message.requestId } satisfies HostRequest);
          } catch (error) { this.end(plugin, errorFrom(error)); }
        };
        signal.addEventListener("abort", cancel, { once: true });
        pending.detach = () => signal.removeEventListener("abort", cancel);
      }
      try { plugin.child.postMessage(message); }
      catch (error) { this.finishRequest(plugin, message.requestId, errorFrom(error)); }
    });
  }

  private onMessage(plugin: PluginProcess, message: WorkerMessage): void {
    if (plugin.ended || !message || typeof message !== "object") return;
    if (message.type === "host-call") {
      if ((!plugin.ready && message.operation !== "credentials") || plugin.unloading || plugin.hostCalls.size >= 16 || !Number.isSafeInteger(message.callId)
        || plugin.hostCalls.has(message.callId) || (!this.hostHandler && !["speech.transcribe", "credentials"].includes(message.operation))
        || !["session.prompt", "open.external", "speech.transcribe", "mcp.snapshot", "mcp.apply", "credentials"].includes(message.operation)) {
        plugin.child?.postMessage({ type: "host-result", callId: message.callId, error: "Host operation unavailable" } satisfies HostResponse);
        return;
      }
      const controller = new AbortController();
      plugin.hostCalls.set(message.callId, controller);
      void Promise.resolve().then(() => message.operation === "speech.transcribe"
        ? this.speech.transcribe(message.payload.spec, controller.signal)
        : message.operation === "credentials" ? this.credentials.request(plugin.userData, message.payload, controller.signal)
        : this.hostHandler!(plugin.id, message.operation, message.payload)).then(result => {
        if (!plugin.ended) plugin.child?.postMessage({ type: "host-result", callId: message.callId, result } satisfies HostResponse);
      }, error => {
        if (!plugin.ended) plugin.child?.postMessage({ type: "host-result", callId: message.callId, error: errorFrom(error).message } satisfies HostResponse);
      }).finally(() => plugin.hostCalls.delete(message.callId)).catch(error => this.end(plugin, errorFrom(error)));
    } else if (message.type === "host-cancel") {
      plugin.hostCalls.get(message.callId)?.abort();
    } else if (message.type === "response") {
      const cancellation = plugin.cancellations.get(message.requestId);
      if (cancellation) {
        clearTimeout(cancellation);
        plugin.cancellations.delete(message.requestId);
      }
      this.finishRequest(plugin, message.requestId,
        message.ok ? undefined : new Error(String(message.error)), message.ok ? message.result : undefined);
    } else if (message.type === "tools" && plugin.ready) {
      try { this.updateTools(plugin, message.tools); }
      catch (error) { this.end(plugin, errorFrom(error)); }
    } else if (message.type === "failure") {
      this.end(plugin, new Error(String(message.error)));
      if (message.status === "requires_host" && !plugin.unloading && !this.closed) {
        this.outcomes.set(plugin.id, { status: "requires_host", error: String(message.error) });
      }
    }
  }

  private updateTools(plugin: PluginProcess, tools: unknown): void {
    if (!Array.isArray(tools)) throw new Error("Invalid plugin tool list");
    const ids = new Set<string>();
    for (const tool of tools as PluginTool[]) {
      if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)
        || tool.id !== `plugin:${plugin.id}:${tool.name}` || ids.has(tool.id)
        || typeof tool.description !== "string" || !tool.inputSchema
        || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
        throw new Error(`Invalid or duplicate tool definition from plugin ${plugin.id}`);
      }
      ids.add(tool.id);
    }
    const others = Array.from(this.plugins.values()).reduce((total, other) =>
      total + (other !== plugin ? other.tools.length : 0), 0);
    if (tools.length + others > MAX_TOOLS) throw new Error(`Plugin host supports at most ${MAX_TOOLS} tools in total`);
    plugin.tools = structuredClone(tools);
  }

  private finishRequest(plugin: PluginProcess, id: number, error?: Error, result?: unknown): void {
    const pending = plugin.pending.get(id);
    if (!pending) return;
    plugin.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach?.();
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private rejectPending(plugin: PluginProcess, error: Error): void {
    for (const id of plugin.pending.keys()) this.finishRequest(plugin, id, error);
    for (const timer of plugin.cancellations.values()) clearTimeout(timer);
    plugin.cancellations.clear();
  }

  private end(plugin: PluginProcess, error: Error): void {
    if (plugin.ended) return;
    plugin.ended = true;
    plugin.ready = false;
    plugin.tools = [];
    plugin.failure = error;
    if (!plugin.unloading && !this.closed) this.outcomes.set(plugin.id, { status: "error", error: error.message });
    this.rejectPending(plugin, error);
    for (const controller of plugin.hostCalls.values()) controller.abort();
    plugin.hostCalls.clear();
    if (this.plugins.get(plugin.id) === plugin) this.plugins.delete(plugin.id);
    // Killing a Windows process tree also terminates yt-dlp/ffmpeg children after crashes.
    const child = plugin.child;
    if (child?.pid && process.platform === "win32") {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => child.kill());
    } else child?.kill();
  }
}
