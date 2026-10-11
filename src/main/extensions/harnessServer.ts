import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface HarnessRoute {
  kind: "exact" | "prefix";
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): unknown;
}
export interface PluginPanelEndpoint { origin: string; token: string }
export interface HarnessFetchRoute {
  path: string;
  methods: string[];
  requestBody: "buffered";
  fetch(request: Request): Response | Promise<Response>;
}
export type HostOperation = "session.prompt" | "open.external" | "speech.transcribe" | "mcp.snapshot" | "mcp.apply" | "credentials";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".ico": "image/x-icon",
};
const BODY_LIMIT = 1024 * 1024;

export class HarnessServer {
  private routes = new Map<string, HarnessRoute>();
  private fetchRoutes = new Map<string, HarnessFetchRoute>();
  private server?: http.Server;
  private starting?: Promise<PluginPanelEndpoint>;
  private origin = "";
  private token = crypto.randomBytes(32).toString("hex");
  private cookie = `daisy_plugin_${crypto.randomBytes(12).toString("hex")}`;
  private closed = false;
  private rpc?: (channel: string, endpoint: string, payload: unknown) => Promise<unknown>;

  constructor(private directory: string, private renderer: string, private client: string | undefined,
    private hostCall: (operation: HostOperation, payload: Record<string, unknown>) => Promise<unknown>) {}

  setRpc(handler: NonNullable<HarnessServer["rpc"]>): void { this.rpc = handler; }

  requestRejection(req: IncomingMessage): number | undefined {
    if (req.headers.host !== new URL(this.origin).host || (req.headers.origin && req.headers.origin !== this.origin)) return 403;
    return req.headers.authorization === `Bearer ${this.token}` || String(req.headers.cookie || "").split(/;\s*/).includes(`${this.cookie}=${this.token}`) ? undefined : 401;
  }

  register(route: HarnessRoute): () => void {
    if (this.closed || !route || !["exact", "prefix"].includes(route.kind)
      || typeof route.path !== "string" || !route.path.startsWith("/") || route.path === "/" || route.path.startsWith("/_daisy")
      || /[?#\\\x00-\x1f]/.test(route.path) || new URL(route.path, "http://localhost").pathname !== route.path
      || typeof route.handler !== "function") throw new Error("Invalid or reserved DSH HTTP route");
    const key = `${route.kind}:${route.path}`;
    if (this.routes.has(key)) throw new Error(`Duplicate DSH HTTP route: ${route.path}`);
    if (this.routes.size >= 64) throw new Error("A plugin may register at most 64 HTTP routes");
    this.routes.set(key, route);
    return () => { if (this.routes.get(key) === route) this.routes.delete(key); };
  }

  registerFetch(route: HarnessFetchRoute): () => void {
    if (!Array.isArray(route?.methods) || !route.methods.length
      || route.methods.some(method => !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      || route.requestBody !== "buffered" || typeof route.fetch !== "function") throw new Error("Unsupported DSH fetch route");
    const remove = this.register({ kind: "exact", path: route.path, handler: async (req, res) => {
      if (!route.methods.includes(req.method || "")) return this.json(res, 405, { error: "Method not allowed" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) return this.json(res, 413, { error: "Request body too large" });
        chunks.push(chunk);
      }
      const response = await this.invokeFetch(route, req, res, Buffer.concat(chunks));
      if (res.destroyed || res.writableEnded) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > BODY_LIMIT) throw new Error("Plugin fetch response too large");
      res.statusCode = response.status;
      for (const name of ["content-type", "cache-control", "location"]) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.end(bytes);
    } });
    this.fetchRoutes.set(route.path, route);
    return () => { remove(); if (this.fetchRoutes.get(route.path) === route) this.fetchRoutes.delete(route.path); };
  }

  private async invokeFetch(route: HarnessFetchRoute, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    const timer = setTimeout(abort, 30000);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    headers.delete("content-length");
    const method = req.method || "GET";
    try {
      return await route.fetch(new Request(new URL(route.path, this.origin), { method, headers, signal: controller.signal,
        ...(!["GET", "HEAD"].includes(method) ? { body: new Uint8Array(body) } : {}) }));
    } finally { clearTimeout(timer); res.removeListener("close", abort); }
  }

  start(): Promise<PluginPanelEndpoint> {
    if (this.closed) return Promise.reject(new Error("Plugin HTTP server is closed"));
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => this.json(res, 500, { error: "Plugin HTTP request failed" })); });
      this.server.requestTimeout = 30000;
      this.server.headersTimeout = 10000;
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (!address || typeof address === "string") return reject(new Error("Invalid plugin server address"));
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve({ origin: this.origin, token: this.token });
      });
    });
    return this.starting;
  }

  close(): void {
    this.closed = true;
    this.routes.clear();
    this.fetchRoutes.clear();
    this.server?.closeAllConnections();
    this.server?.close();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async serve(root: string, relative: string, res: ServerResponse): Promise<void> {
    const file = path.resolve(root, relative);
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(file).catch(() => "");
    const inside = path.relative(realRoot, realFile);
    const mime = MIME[path.extname(realFile)];
    if (!realFile || !inside || inside.startsWith("..") || path.isAbsolute(inside) || !mime
      || /(?:^|[/\\])\./.test(inside)) return this.json(res, 404, { error: "Asset not found" });
    const stat = await fs.stat(realFile);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return this.json(res, 413, { error: "Asset exceeds size limit" });
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    res.end(await fs.readFile(realFile));
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error("Request body too large");
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
    return value;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    const url = new URL(req.url || "/", this.origin);
    const origin = req.headers.origin;
    if (this.closed || req.headers.host !== new URL(this.origin).host
      || (origin && origin !== this.origin) || ["cross-site", "same-site"].includes(String(req.headers["sec-fetch-site"]))) {
      return this.json(res, 403, { error: "Invalid plugin request origin" });
    }
    if (url.pathname === "/_daisy/login" && req.method === "GET" && url.searchParams.get("token") === this.token) {
      res.writeHead(302, { location: "/", "set-cookie": `${this.cookie}=${this.token}; HttpOnly; SameSite=Strict; Path=/` });
      res.end(); return;
    }
    const authenticated = req.headers.authorization === `Bearer ${this.token}`
      || String(req.headers.cookie || "").split(/;\s*/).includes(`${this.cookie}=${this.token}`);
    if (!authenticated) return this.json(res, 401, { error: "Plugin authentication required" });
    if (!["GET", "HEAD"].includes(req.method || "") && !req.headers.authorization && origin !== this.origin) {
      return this.json(res, 403, { error: "Same-origin POST required" });
    }
    if (Number(req.headers["content-length"] || 0) > BODY_LIMIT) return this.json(res, 413, { error: "Request body too large" });
    if (url.pathname === "/_daisy/" && req.method === "GET") { res.writeHead(302, { location: "/" }); res.end(); return; }
    if (url.pathname === "/" && req.method === "GET") return this.serve(this.renderer, "panel.html", res);
    if (url.pathname.startsWith("/_daisy/assets/") && req.method === "GET") return this.serve(this.renderer, `assets/${decodeURIComponent(url.pathname.slice("/_daisy/assets/".length))}`, res);
    if (url.pathname === "/_daisy/client.js" && req.method === "GET" && this.client) return this.serve(this.directory, this.client, res);
    if (url.pathname === "/_daisy/manifest" && req.method === "GET") return this.json(res, 200, { client: !!this.client, sessionId: "daisy", services: ["tools", "webServer", "slots", "sidebarRightTabs", "sessions"] });
    if (url.pathname === "/_daisy/prompt" && req.method === "POST") {
      const body = await this.readJson(req);
      return this.json(res, 200, await this.hostCall("session.prompt", body));
    }
    if (url.pathname === "/_daisy/open-external" && req.method === "POST") {
      return this.json(res, 200, await this.hostCall("open.external", await this.readJson(req)));
    }
    if (url.pathname === "/_daisy/rpc" && req.method === "POST" && this.rpc) {
      const body = await this.readJson(req);
      if (typeof body.channel !== "string" || !/^\/[A-Za-z0-9._~-]+$/.test(body.channel)
        || typeof body.endpoint !== "string" || !/^[A-Za-z0-9_$.-]+$/.test(body.endpoint)) throw new Error("Invalid RPC request");
      const route = this.fetchRoutes.get(`${body.channel}/${body.endpoint}`);
      if (route) {
        if (!route.methods.includes("POST")) return this.json(res, 405, { error: "Method not allowed" });
        const rpcId = crypto.randomUUID();
        const response = await this.invokeFetch(route, req, res, Buffer.from(JSON.stringify({ type: "client-request", rpcId,
          method: body.endpoint, payload: body.payload })));
        if (!response.ok) throw new Error(`Plugin RPC transport failed: HTTP ${response.status}`);
        const envelope = await response.json() as { type?: string; rpcId?: string; result?: unknown };
        if (envelope.type !== "server-response" || envelope.rpcId !== rpcId || !envelope.result || typeof envelope.result !== "object") throw new Error("Invalid plugin RPC envelope");
        return this.json(res, 200, envelope.result);
      }
      return this.json(res, 200, await this.rpc(body.channel, body.endpoint, body.payload));
    }
    if (url.pathname.startsWith("/_daisy")) return this.json(res, 404, { error: "Unknown host endpoint" });
    const route = this.routes.get(`exact:${url.pathname}`) || [...this.routes.values()]
      .filter(x => x.kind === "prefix" && url.pathname.startsWith(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!route) return this.json(res, 404, { error: "Unknown plugin endpoint" });
    let received = 0;
    req.on("data", chunk => {
      received += chunk.length;
      if (received > BODY_LIMIT) { this.json(res, 413, { error: "Request body too large" }); req.destroy(); }
    });
    const streaming = () => res.headersSent && /^text\/event-stream(?:;|$)/i.test(String(res.getHeader("content-type") || ""));
    const timer = setTimeout(() => {
      // SSE belongs to the plugin until disconnect, not the unary request deadline.
      if (streaming()) return;
      this.json(res, 504, { error: "Plugin request timed out" }); req.destroy();
    }, 30000);
    res.once("close", () => clearTimeout(timer));
    await route.handler(req, res);
    if (streaming()) clearTimeout(timer);
  }
}
