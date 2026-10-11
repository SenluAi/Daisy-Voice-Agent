import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import Ajv from "ajv";
import { PluginLlmRegistry } from "./llmRegistry";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { PluginCredentialProvider } from "./credentialProvider";
import type { harnessMcpSnapshot } from "./harnessMcp";
import type { HostRequest, HostResponse, PluginLoadEntry, PluginLoadResult, PluginTool, WorkerMessage } from "./pluginHost";
import { HarnessServer, type HarnessRoute, type HostOperation, type PluginPanelEndpoint } from "./harnessServer";
import { resolveSpeechRequest, speechAbortError, type SpeechCatalog, type SpeechSpec } from "./speechContract";

// tsc emits CommonJS for this project; preserve native import() for ESM plugins.
const importModule = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>;
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Plugin worker must run in an Electron utility process");

type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) =>
  string | object | Promise<string | object>;
type ToolDefinition = Omit<PluginTool, "id">;
interface RegisteredTool { definition: PluginTool; handler: ToolHandler }
interface PackageMetadata {
  main?: string;
  exports?: unknown;
  dsh?: { client?: { inject?: unknown } };
}

const tools = new Map<string, RegisteredTool>();
const calls = new Map<number, AbortController>();
let context: Context | undefined;
let scope: Fiber | undefined;
let loaded = false;
let published = false;
let stopping = false;
let pluginId = "";
let server: HarnessServer | undefined;
let hostCallId = 0;
const hostCalls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; detach(): void }>();
const deferredFibers = new Set<number>();
let speech: SpeechCatalog;
const validator = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const CLIENT_PROVIDERS = new Set(["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-sessions", "@deepseek-ai/dsh-client-react",
  "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale"]);

function hostCall(operation: HostOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (stopping || hostCalls.size >= 16) return Promise.reject(new Error("Plugin host request unavailable"));
  if (signal?.aborted) return Promise.reject(speechAbortError());
  const callId = ++hostCallId;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const pending = hostCalls.get(callId);
      if (!pending) return;
      clearTimeout(pending.timer); pending.detach(); hostCalls.delete(callId);
      send({ type: "host-cancel", callId }); reject(speechAbortError());
    };
    const timer = setTimeout(() => {
      cancel();
    }, operation === "speech.transcribe" ? 240000 : 15000);
    hostCalls.set(callId, { resolve, reject, timer, detach: () => signal?.removeEventListener("abort", cancel) });
    signal?.addEventListener("abort", cancel, { once: true });
    send({ type: "host-call", callId, operation, payload });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(message: WorkerMessage): void { parentPort!.postMessage(message); }
function snapshot(): PluginTool[] { return Array.from(tools.values(), (tool) => tool.definition); }
function publishTools(): void { if (published && !stopping) send({ type: "tools", tools: snapshot() }); }

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const option of value) {
      const target = exportTarget(option);
      if (target !== undefined) return target;
    }
  } else if (value && typeof value === "object") {
    // Node conditional exports use declaration order, not a fixed default/import priority.
    for (const [condition, option] of Object.entries(value)) {
      if (["node", "node-addons", "import", "default"].includes(condition)) {
        const target = exportTarget(option);
        if (target !== undefined) return target;
      }
    }
  }
  return undefined;
}

function packageEntry(directory: string, meta: PackageMetadata): string {
  if (meta.exports !== undefined) {
    const value = meta.exports;
    const root = value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).some((key) => key.startsWith("."))
      ? (value as Record<string, unknown>)["."] : value;
    const target = exportTarget(root);
    if (!target || !target.startsWith("./")) throw new Error("Package exports has no supported Node import entry at '.'");
    const entry = path.resolve(directory, target);
    const relative = path.relative(directory, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Package export entry escapes its directory");
    return entry;
  }
  const requireFromPackage = createRequire(path.join(directory, "package.json"));
  return requireFromPackage.resolve(path.resolve(directory, meta.main || "index.js"));
}

function clientServices(meta: PackageMetadata): string[] {
  const inject = meta.dsh?.client?.inject;
  return Array.isArray(inject) ? inject.filter((name): name is string => typeof name === "string")
    : inject && typeof inject === "object" ? Object.keys(inject) : [];
}

function clientOnly(services: string[]): PluginLoadResult {
  return {
    status: "requires_host",
    error: `Unsupported DSH client requirements: ${services.join(", ") || "dsh.client"}. Daisy supports the standard sidebar/slot/session bridge, not every Harness UI provider.`,
  };
}

function allFibers(): Fiber[] {
  return context ? Array.from(context.registry.values()).flatMap((runtime) => Array.from(runtime.fibers)) : [];
}

async function settleFibers(): Promise<void> {
  for (;;) {
    const fibers = allFibers();
    await Promise.all(fibers.map((fiber) => fiber.await()));
    const current = allFibers();
    if (current.length === fibers.length && current.every((fiber) => fibers.includes(fiber) && !fiber.inertia)) return;
  }
}

function missingServices(): string[] {
  const missing = new Set<string>();
  for (const fiber of allFibers()) {
    if (fiber.uid === null || deferredFibers.has(fiber.uid)) continue;
    for (const name of Object.keys(fiber.inject)) {
      if (!fiber.ctx.reflect._getImpl(name, true)) missing.add(name);
    }
  }
  return Array.from(missing).sort();
}

async function load(entry: PluginLoadEntry, userData: string, catalog: SpeechCatalog): Promise<PluginLoadResult & { tools?: PluginTool[]; panel?: PluginPanelEndpoint }> {
  if (loaded || stopping) throw new Error("A plugin worker can load only one plugin");
  loaded = true;
  pluginId = entry.id;
  speech = catalog;
  const meta = JSON.parse(await fs.readFile(path.join(entry.directory, "package.json"), "utf8")) as PackageMetadata;
  const clients = clientServices(meta);
  const unsupportedClients = clients.filter(name => !CLIENT_PROVIDERS.has(name));
  if (unsupportedClients.length) return clientOnly(unsupportedClients);
  let client: string | undefined;
  if (meta.dsh?.client) {
    const value = meta.exports && typeof meta.exports === "object" ? (meta.exports as Record<string, unknown>)["./client"] : undefined;
    const target = typeof value === "string" ? value : exportTarget(value);
    if (target?.startsWith("./") && !path.relative(entry.directory, path.resolve(entry.directory, target)).startsWith("..")) client = target;
    if (!client) return clientOnly(["missing './client' export"]);
  }
  let entryPath: string | undefined;
  try { entryPath = packageEntry(entry.directory, meta); }
  catch (error) {
    if (!client) throw error;
  }
  if (client && entryPath === path.resolve(entry.directory, client)) entryPath = undefined;
  const cordis = await importModule(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href) as unknown as typeof import("@deepseek-ai/cordis");
  context = new cordis.Context();
  // ctx.inject is a deferred optional feature, unlike a plugin's mandatory inject.
  const originalInject = context.registry.inject;
  Object.defineProperty(context.registry, "inject", { configurable: true, value: function(this: Context["registry"], ...args: Parameters<Context["registry"]["inject"]>) {
    const fiber = originalInject.call(this, ...args);
    if (fiber.uid !== null) deferredFibers.add(fiber.uid);
    return fiber;
  } });
  context.baseUrl = pathToFileURL(`${entry.directory}${path.sep}`).href;
  await fs.mkdir(userData, { recursive: true });
  // DSH plugins may use their own home rather than ctx.daisy.userData.
  process.env.DSH_HOME = path.join(userData, "harness");
  await fs.mkdir(process.env.DSH_HOME, { recursive: true });
  const binaryDirectories = [entry.config?.ytDlpPath, entry.config?.ffmpegPath]
    .filter((value): value is string => typeof value === "string" && path.isAbsolute(value)).map(value => path.dirname(value));
  process.env.PATH = [...binaryDirectories, process.env.PATH || process.env.Path || ""].join(path.delimiter);
  server = new HarnessServer(entry.directory, path.resolve(__dirname, "../../renderer-plugin"), client, hostCall);
  const llm = new PluginLlmRegistry(context);
  new CommandRuntime(context);
  new PluginCredentialProvider(context, payload => hostCall("credentials", payload));
  const channels = new Map<string, (endpoint: string, payload: unknown) => unknown>();
  const patchFile = typeof entry.config?.patchFile === "string" ? entry.config.patchFile : path.join(userData, "mcp.patch.yml");
  let loaderSnapshot: ReturnType<typeof harnessMcpSnapshot> | undefined;
  let rpcQueue: Promise<unknown> = Promise.resolve();
  server.setRpc((channel, endpoint, payload) => {
    const request = rpcQueue.then(async () => {
      const handler = channels.get(channel);
      if (!handler || stopping) throw new Error("Unregistered plugin RPC channel");
      if (channel !== "/mcp-manager") return handler(endpoint, payload);
      loaderSnapshot = await hostCall("mcp.snapshot", {}) as ReturnType<typeof harnessMcpSnapshot>;
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, loaderSnapshot.patch);
      const result = await handler(endpoint, payload);
      const patch = await fs.readFile(patchFile, "utf8");
      if (patch !== loaderSnapshot.patch) await hostCall("mcp.apply", { patch, source: loaderSnapshot.source });
      return result;
    });
    rpcQueue = request.catch(() => {});
    return request;
  });
  const connection = {
    ctx: context,
    fetch: { ctx: context, register(this: { ctx: Context }, route: import("./harnessServer").HarnessFetchRoute) {
      return this.ctx.effect(() => server!.registerFetch(route), `connection.fetch.register(${route.path})`);
    } },
    admit: (req: Parameters<HarnessServer["requestRejection"]>[0]) => {
      const rejection = server!.requestRejection(req); return rejection === undefined ? undefined : { rejection };
    },
    rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown) => unknown, options?: { authority?: string }) {
      if (!/^\/[A-Za-z0-9._~-]+$/.test(channel) || channels.has(channel) || typeof handler !== "function"
        || (options?.authority && options.authority !== "loopback")) throw new Error("Invalid plugin RPC registration");
      channels.set(channel, handler);
      return () => { channels.delete(channel); };
    } },
  };
  const loader = { ctx: context, entries: () => (loaderSnapshot?.entries || []).map(row => ({ id: row.id,
    disabled: row.disabled, options: { id: row.id, name: row.name, config: row.config }, fiber: { state: row.state } })) };
  for (const [name, service] of [["connection", connection], ["loader", loader]] as const) {
    Object.defineProperty(service, cordis.symbols.tracker, { value: { property: "ctx" } });
    context.provide(name, service);
  }
  const bridge = {
    ctx: context,
    userData,
    registerTool(this: { ctx: Context }, definition: ToolDefinition, handler: ToolHandler): () => void {
      if (stopping) throw new Error("Plugin is unloading");
      if (!definition || typeof definition.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(definition.name)) {
        throw new Error("Tool name must match [A-Za-z0-9_-] and contain 1 to 64 characters");
      }
      if (typeof definition.description !== "string" || !definition.inputSchema
        || typeof definition.inputSchema !== "object" || Array.isArray(definition.inputSchema)
        || typeof handler !== "function") throw new Error("Invalid Daisy tool definition or handler");
      if (tools.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
      if (tools.size >= 64) throw new Error("A plugin may register at most 64 tools");
      const registered: RegisteredTool = {
        definition: JSON.parse(JSON.stringify({ ...definition, id: `plugin:${pluginId}:${definition.name}` })),
        handler,
      };
      // Cordis traceable service binding makes the calling fiber own each registration.
      return this.ctx.effect(() => {
        tools.set(definition.name, registered);
        publishTools();
        return () => {
          if (tools.get(definition.name) === registered) tools.delete(definition.name);
          publishTools();
        };
      }, `daisy.registerTool(${definition.name})`);
    },
  };
  Object.defineProperty(bridge, cordis.symbols.tracker, { value: { property: "ctx" } });
  context.provide("daisy", bridge);
  context.provide("speechToText", {
    snapshot: () => structuredClone({ providers: speech.providers, selection: speech.selection }),
    resolve: (request: unknown) => resolveSpeechRequest(request, speech),
    transcribe: (spec: SpeechSpec, signal?: AbortSignal) => hostCall("speech.transcribe", { spec }, signal),
  });
  context.provide("speechController", { catalog: () => structuredClone(speech) });
  const harnessTools = {
    ctx: context,
    schemas: () => [...snapshot().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })), ...(loaderSnapshot?.schemas || [])],
    register(this: { ctx: Context }, definition: {
      name: string; description: string; parameters: Record<string, unknown>;
      execute(args: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown;
      output?: { schema?: Record<string, unknown>; render?: (args: Record<string, unknown>, result: unknown) => unknown };
    }): () => void {
      if (!definition || typeof definition.execute !== "function" || !definition.parameters) throw new Error("Invalid DSH tool registration");
      if (JSON.stringify(definition.parameters).length > 64000 || JSON.stringify(definition.output?.schema || {}).length > 64000) throw new Error("DSH tool schema exceeds size limit");
      const input = validator.compile(definition.parameters);
      const output = definition.output?.schema ? validator.compile(definition.output.schema) : undefined;
      return bridge.registerTool.call(this, { name: definition.name, description: definition.description, inputSchema: definition.parameters }, async (args, signal) => {
        if (!input(args)) throw new Error(`Invalid tool arguments: ${validator.errorsText(input.errors)}`);
        const result = await definition.execute(args, { signal });
        if (output && !output(result)) throw new Error(`Invalid tool output: ${validator.errorsText(output.errors)}`);
        const rendered = definition.output?.render ? await definition.output.render(args, result) : undefined;
        if (Array.isArray(rendered)) {
          const text = rendered.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
          if (text) return text;
        }
        return typeof result === "string" ? result : JSON.stringify(result);
      });
    },
  };
  const webServer = {
    ctx: context,
    register(this: { ctx: Context }, route: HarnessRoute): () => void {
      return this.ctx.effect(() => server!.register(route), `webServer.register(${route.path})`);
    },
  };
  for (const [name, service] of [["tools", harnessTools], ["webServer", webServer]] as const) {
    Object.defineProperty(service, cordis.symbols.tracker, { value: { property: "ctx" } });
    context.provide(name, service);
  }
  if (entryPath) {
    const module = await importModule(pathToFileURL(entryPath).href);
    const plugin = (typeof module.apply === "function" ? module : module.default) as Plugin | undefined;
    if (!plugin || !context.registry.resolve(plugin)) throw new Error("Plugin entry must export apply(ctx, config) or a Cordis default plugin");
    // The parent declares daisy so compatibility plugins can read ctx.daisy without changing metadata.
    scope = context.inject(["daisy"], (ctx) => { ctx.plugin(plugin, entry.config ?? {}); });
  }
  await settleFibers();
  if (llm.listProviders().length) {
    bridge.registerTool({ name: "dsh_list_models", description: "列出此插件真实提供的模型；不会改变 Daisy 默认模型。",
      inputSchema: { type: "object", properties: { provider: { type: "string" } }, additionalProperties: false } },
    args => llm.listModels(typeof args.provider === "string" ? args.provider : undefined));
    bridge.registerTool({ name: "dsh_generate_text", description: "用户明确选择此插件模型后，调用指定 provider 和 model 处理给定文本。不要擅自发送现有会话。",
      inputSchema: { type: "object", properties: { provider: { type: "string" }, model: { type: "string" }, prompt: { type: "string" } }, required: ["provider", "model", "prompt"], additionalProperties: false } },
    (args, signal) => llm.generate(args, signal));
  }
  const missing = missingServices();
  if (missing.length) return { status: "requires_host", error: `Missing required Cordis services: ${missing.join(", ")}. Daisy provides daisy, tools, webServer and Cordis core services.` };
  const pending = allFibers().find((fiber) => fiber.state === cordis.FiberState.PENDING && fiber.uid !== null && !deferredFibers.has(fiber.uid));
  if (pending) return { status: "requires_host", error: `Required Cordis services are unavailable for ${pending.name}: ${Object.keys(pending.inject).join(", ")}` };
  const endpoint = await server.start();
  published = true;
  let checking = false;
  const checkRuntime = () => {
    if (stopping || checking) return;
    checking = true;
    setImmediate(() => {
      void settleFibers().then(() => {
        if (stopping) return;
        const missing = missingServices();
        if (missing.length) send({
          type: "failure", status: "requires_host",
          error: `Missing required Cordis services: ${missing.join(", ")}`,
        });
      }, (error) => {
        if (!stopping) send({ type: "failure", error: errorMessage(error) });
      }).finally(() => { checking = false; });
    });
  };
  context.on("internal/status", checkRuntime);
  context.on("internal/plugin", checkRuntime);
  return { status: "ready", tools: snapshot(), ...(client ? { panel: endpoint } : {}) };
}

async function unload(): Promise<void> {
  stopping = true;
  published = false;
  for (const controller of calls.values()) controller.abort();
  for (const [callId, pending] of hostCalls) {
    clearTimeout(pending.timer); pending.detach();
    send({ type: "host-cancel", callId }); pending.reject(new Error("Plugin is unloading"));
  }
  hostCalls.clear();
  if (scope) await scope.dispose();
  if (context) await context.fiber.dispose();
  server?.close();
  tools.clear();
}

async function dispatch(message: Exclude<HostRequest, { type: "cancel" }>): Promise<unknown> {
  if (message.type === "load") return load(message.entry, message.userData, message.speech);
  if (message.type === "unload") return unload();
  if (!published || stopping) throw new Error("Plugin tools are unavailable");
  const tool = tools.get(message.name);
  if (!tool) throw new Error(`Unknown plugin tool: ${message.name}`);
  const controller = new AbortController();
  calls.set(message.requestId, controller);
  try {
    // Unary handlers remain compatible; cooperative handlers may use the second argument.
    const result = await tool.handler(message.args, controller.signal);
    if (typeof result === "string") return result;
    if (result === null || typeof result !== "object") throw new Error("Plugin tool must return a string or object");
    return JSON.stringify(result);
  } finally { calls.delete(message.requestId); }
}

parentPort.on("message", ({ data }: { data: HostRequest | HostResponse }) => {
  if (data?.type === "speech-catalog") { speech = data.catalog; return; }
  if (data?.type === "host-result") {
    const call = hostCalls.get(data.callId);
    if (call) {
      clearTimeout(call.timer); call.detach(); hostCalls.delete(data.callId);
      if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
    }
    return;
  }
  if (!data || !Number.isSafeInteger(data.requestId)) return;
  if (data.type === "cancel") { calls.get(data.requestId)?.abort(); return; }
  if (!["load", "call", "unload"].includes(data.type)) return;
  void dispatch(data).then(
    (result) => send({ type: "response", requestId: data.requestId, ok: true, result }),
    (error) => send({ type: "response", requestId: data.requestId, ok: false, error: errorMessage(error) }),
  );
});
