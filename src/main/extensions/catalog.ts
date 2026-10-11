import fs from "node:fs";
import path from "node:path";
import type { CatalogEntry, CatalogQuery, CatalogResult } from "../../shared/extensions";

const DAY = 24 * 60 * 60 * 1000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

// DSH Plugin Hub MIT catalog contract: s/o/n/vr/c/t/f/d/r/v/u/sg.
// Community verification is not a claim of compatibility with the Daisy host.
export function normalizeCatalog(raw: Record<string, unknown>): CatalogEntry {
  const short = typeof raw.s === "string";
  const source = short ? raw.r : raw.source;
  const repo = typeof source === "string" ? source : str((source as Record<string, unknown> | null)?.repo);
  const npmPackage = typeof source === "object" && source ? str((source as Record<string, unknown>).npmPackage) : "";
  const slug = str(short ? raw.s : raw.slug);
  const owner = str(short ? raw.o : raw.ownerSlug) || repo.split("/")[0];
  const compatibility = raw.compatibility as Record<string, unknown> | undefined;
  const stats = raw.stats as Record<string, unknown> | undefined;
  const install = raw.install as Record<string, unknown> | undefined;
  const dates = raw.dates as Record<string, unknown> | undefined;
  return {
    id: `${owner}/${slug}`, name: str(short ? raw.n : raw.displayName) || slug,
    description: str(short ? raw.d : raw.description), version: str(short ? raw.vr : raw.version),
    category: str(short ? raw.c : raw.category) || "other",
    tags: [...strings(short ? raw.t : raw.topics), ...strings(short ? raw.f : raw.features)],
    stars: Number(short ? raw.sg : stats?.stargazers_count) || 0,
    verified: (short ? raw.v : compatibility?.status) === "verified",
    repository: REPOSITORY.test(repo) ? repo : undefined,
    npmPackage: PACKAGE.test(npmPackage) ? npmPackage : undefined,
    updatedAt: str(short ? raw.u : dates?.repoUpdatedAt),
    webInstallable: (short ? raw.wi : install?.webInstallable) !== false,
  };
}

export function catalogInstallTarget(raw: Record<string, unknown>, entry: CatalogEntry): string {
  if (!entry.webInstallable) throw new Error("该插件需要专用 CLI 或宿主，不能在 Daisy 中安装。");
  if (entry.npmPackage) return entry.npmPackage;
  const command = str(raw.ic) || str((raw.install as Record<string, unknown> | undefined)?.command);
  const target = command.match(/^dsh plugin(?: --profile [A-Za-z0-9_-]+)? add ([^\s]+)$/)?.[1];
  if (target && PACKAGE.test(target)) return target;
  if (target && /^https:\/\/github\.com\//.test(target)) {
    const url = new URL(target);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts.slice(0, 2).join("/") === entry.repository
      && parts[2] === "releases" && parts[3] === "download" && parts.length === 6
      && /\.(?:tgz|tar\.gz)$/.test(parts[5]) && !url.search && !url.hash && !url.username) return url.href;
  }
  if (entry.repository) return `git+https://github.com/${entry.repository}.git`;
  throw new Error("目录未提供可验证的安装来源。");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`目录同步失败 (HTTP ${response.status})`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > 20 * 1024 * 1024) throw new Error("插件目录超过大小限制。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class PluginCatalog {
  private entries: CatalogEntry[] = [];
  private raw = new Map<string, Record<string, unknown>>();
  private syncedAt = 0;
  private total = 0;
  private verified = 0;
  private error?: string;
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private file: string;

  constructor(root: string) {
    this.file = path.join(root, "catalog.json");
    try {
      const cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.accept(cache.plugins, cache.stats, cache.syncedAt);
    } catch { /* No cache yet. */ }
    this.timer = setInterval(() => void this.sync(), DAY);
    this.timer.unref();
  }

  private accept(plugins: unknown, stats: unknown, at: unknown): void {
    if (!Array.isArray(plugins) || plugins.some(x => !x || typeof x !== "object")) throw new Error("插件目录格式无效。");
    const raw = plugins as Record<string, unknown>[];
    const entries = raw.map(normalizeCatalog);
    this.entries = entries;
    this.raw = new Map(raw.map((x, i) => [entries[i].id, x]));
    this.syncedAt = typeof at === "number" ? at : Date.now();
    this.total = Number((stats as Record<string, unknown> | null)?.total) || entries.length;
    this.verified = Number((stats as Record<string, unknown> | null)?.verified) || entries.filter(x => x.verified).length;
  }

  async sync(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.entries.length && Date.now() - this.syncedAt < DAY) return;
    this.pending = (async () => {
      try {
        const plugins = await fetchJson("https://api.dsh-plugin.org/plugins.zh.json");
        const stats = await fetchJson("https://api.dsh-plugin.org/stats.json").catch(() => null);
        this.accept(plugins, stats, Date.now());
        this.error = undefined;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ plugins, stats, syncedAt: this.syncedAt }));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (error) {
        this.error = error instanceof Error ? error.message : "插件目录同步失败。";
      }
    })().finally(() => { this.pending = undefined; });
    await this.pending;
  }

  async query(query: CatalogQuery = {}): Promise<CatalogResult> {
    await this.sync(query.refresh === true);
    const search = (query.search || "").slice(0, 200).toLocaleLowerCase();
    const entries = this.entries.filter(x => (!query.category || x.category === query.category)
      && (!search || `${x.name} ${x.description} ${x.tags.join(" ")}`.toLocaleLowerCase().includes(search)));
    entries.sort(query.sort === "updated"
      ? (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") : (a, b) => b.stars - a.stars);
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.max(1, Math.min(60, Number(query.limit) || 30));
    return { entries: entries.slice(offset, offset + limit), total: entries.length, catalogTotal: this.total,
      verified: this.verified, categories: [...new Set(this.entries.map(x => x.category))].sort(),
      syncedAt: this.syncedAt, stale: !!this.error || Date.now() - this.syncedAt >= DAY, error: this.error };
  }

  async target(id: string): Promise<{ entry: CatalogEntry; target: string }> {
    await this.sync();
    const entry = this.entries.find(x => x.id === id);
    const raw = this.raw.get(id);
    if (!entry || !raw) throw new Error("插件不在当前社区目录中，请先同步目录。");
    return { entry, target: catalogInstallTarget(raw, entry) };
  }

  close(): void { if (this.timer) clearInterval(this.timer); }
}
