import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle, BadgeCheck, BookOpen, Check, ChevronLeft, ChevronRight,
  Download, Eye, FileCode2, FolderInput, LoaderCircle, LockKeyhole,
  Pencil, Plus, Puzzle, RefreshCw, Save, Search, Server, ShieldAlert,
  SlidersHorizontal, Star, Trash2, X, type LucideIcon,
} from "lucide-react";
import type {
  CatalogEntry, CatalogQuery, CatalogResult, ExtensionAction, ExtensionRequestAPI,
  ExtensionRequests, ExtensionSnapshot, McpEntry, PluginEntry, SkillDraft, SkillEntry,
} from "../shared/extensions";
import "./ExtensionsPanel.css";

const PAGE_SIZE = 12;
const CATEGORY_LABELS: Record<string, string> = {
  ui: "界面体验", messages: "会话消息", memory: "记忆上下文", tools: "工具能力",
  skills: "技能智能体", workflows: "工作流", integrations: "集成连接", models: "模型推理",
  devops: "开发运维", data: "数据知识", entertainment: "娱乐", other: "其他",
};
const categoryLabel = (category: string) => CATEGORY_LABELS[category] || category;
const TOP_TABS = [
  { id: "plugins", label: "插件市场", Icon: Puzzle },
  { id: "skills", label: "技能 Skill", Icon: BookOpen },
] as const;
const PLUGIN_TABS = [
  { id: "market", label: "市场" },
  { id: "installed", label: "已安装" },
  { id: "mcp", label: "MCP" },
] as const;
const PLUGIN_STATUS: Record<PluginEntry["status"], string> = {
  ready: "就绪", disabled: "已停用", error: "异常", requires_host: "需要兼容宿主",
};
const MCP_STATUS: Record<McpEntry["status"], string> = {
  connected: "已连接", connecting: "连接中", disabled: "已停用", error: "异常",
};

type Notice = { kind: "error" | "success"; message: string };
type Confirmation =
  | { kind: "install"; entry: CatalogEntry }
  | { kind: "import" }
  | { kind: "deletePlugin"; entry: PluginEntry }
  | { kind: "deleteSkill"; entry: SkillEntry };
type SkillEditor = { draft: SkillDraft; readonly: boolean; loading: boolean };
type McpEditor = { json: string; loading: boolean };

async function request<K extends ExtensionAction>(
  action: K, input?: ExtensionRequests[K]["input"],
): Promise<ExtensionRequests[K]["output"]> {
  const extensionsRequest: ExtensionRequestAPI | undefined = window.diriAPI?.extensionsRequest;
  if (typeof extensionsRequest !== "function") throw new Error("扩展接口尚未就绪，请重新打开设置。");
  return extensionsRequest(action, input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "请求失败，请重试。";
}

function IconButton({ label, Icon, onClick, disabled = false, spinning = false, danger = false }: {
  label: string; Icon: LucideIcon; onClick: () => void; disabled?: boolean; spinning?: boolean; danger?: boolean;
}) {
  return (
    <span className="ext-tool" title={label}>
      <button type="button" className={`ext-icon-button${danger ? " ext-danger" : ""}`}
        aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon size={16} aria-hidden="true" className={spinning ? "ext-spin" : undefined} />
      </button>
    </span>
  );
}

function Toggle({ label, enabled, disabled, onChange }: {
  label: string; enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="ext-toggle" title={`${enabled ? "停用" : "启用"}${label}`}>
      <input type="checkbox" role="switch" aria-label={`启用${label}`} checked={enabled}
        disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="ext-toggle-track" aria-hidden="true" />
    </label>
  );
}

function Tabs<T extends string>({ id, items, value, onChange, secondary = false }: {
  id: string; items: readonly { id: T; label: string; Icon?: LucideIcon }[];
  value: T; onChange: (value: T) => void; secondary?: boolean;
}) {
  return (
    <div className={secondary ? "ext-subtabs" : "ext-tabs"} role="tablist" aria-label={secondary ? "插件视图" : "扩展类型"}>
      {items.map(({ id: key, label, Icon }) => (
        <button key={key} id={`${id}-tab-${key}`} type="button" role="tab"
          aria-selected={key === value} aria-controls={`${id}-panel-${key}`} tabIndex={key === value ? 0 : -1}
          onClick={() => onChange(key)} onKeyDown={(event) => {
            const index = items.findIndex((item) => item.id === key);
            let target: number;
            if (event.key === "ArrowRight") target = (index + 1) % items.length;
            else if (event.key === "ArrowLeft") target = (index + items.length - 1) % items.length;
            else if (event.key === "Home") target = 0;
            else if (event.key === "End") target = items.length - 1;
            else return;
            event.preventDefault();
            onChange(items[target].id);
            document.getElementById(`${id}-tab-${items[target].id}`)?.focus();
          }}>
          {Icon && <Icon size={16} aria-hidden="true" />}{label}
        </button>
      ))}
    </div>
  );
}

function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const Icon = notice.kind === "error" ? AlertCircle : Check;
  return (
    <div className={`ext-notice ext-notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" /><span>{notice.message}</span>
      <IconButton label="关闭提示" Icon={X} onClick={onClose} />
    </div>
  );
}

function StateMessage({ loading = false, error, empty, onRetry }: {
  loading?: boolean; error?: string | null; empty?: string; onRetry?: () => void;
}) {
  return (
    <div className="ext-state" role={error ? "alert" : "status"}>
      {loading ? <LoaderCircle size={21} className="ext-spin" aria-hidden="true" />
        : error ? <AlertCircle size={21} aria-hidden="true" /> : <Puzzle size={23} aria-hidden="true" />}
      <p>{loading ? "加载中…" : error || empty}</p>
      {error && onRetry && <button type="button" className="ext-button" onClick={onRetry}><RefreshCw size={14} />重试</button>}
    </div>
  );
}

function Modal({ title, busy, onClose, children, footer, error }: {
  title: string; busy: boolean; onClose: () => void; children: ReactNode; footer: ReactNode; error?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog ref={ref} className="ext-dialog" aria-labelledby={titleId} aria-busy={busy}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="ext-dialog-header"><h3 id={titleId}>{title}</h3>
        <IconButton label="关闭" Icon={X} disabled={busy} onClick={onClose} />
      </div>
      <div className="ext-dialog-body">{children}
        {error && <div className="ext-dialog-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><span>{error}</span></div>}
      </div>
      <div className="ext-dialog-footer">{footer}</div>
    </dialog>, document.body,
  );
}

export default function ExtensionsPanel() {
  const id = useId();
  const [tab, setTab] = useState<(typeof TOP_TABS)[number]["id"]>("plugins");
  const [pluginTab, setPluginTab] = useState<(typeof PLUGIN_TABS)[number]["id"]>("market");
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [query, setQuery] = useState<CatalogQuery>({ search: "", category: "", sort: "stars", offset: 0, limit: PAGE_SIZE });
  const [pluginSearch, setPluginSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [skillEditor, setSkillEditor] = useState<SkillEditor | null>(null);
  const [mcpEditor, setMcpEditor] = useState<McpEditor | null>(null);
  const [pluginEditor, setPluginEditor] = useState<{ entry: PluginEntry; json: string; loading: boolean } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const mounted = useRef(false);
  const operationBusy = useRef(false);
  const initialSnapshot = useRef<Promise<ExtensionSnapshot> | null>(null);
  const lastSyncQuery = useRef<CatalogQuery | null>(null);
  const locked = busy !== null || snapshotLoading;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    // Reuse the mount request during React StrictMode's effect replay.
    initialSnapshot.current ??= request("snapshot");
    void initialSnapshot.current.then((result) => {
      if (active) setSnapshot(result);
    }).catch((error: unknown) => {
      if (!active) return;
      const message = errorMessage(error);
      setSnapshotError(message);
      setNotice({ kind: "error", message });
    }).finally(() => { if (active) setSnapshotLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, []);

  useEffect(() => {
    if (tab !== "plugins" || pluginTab !== "market") return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalog(null);
    const timer = window.setTimeout(() => {
      const refresh = query.refresh === true && lastSyncQuery.current !== query;
      if (refresh) lastSyncQuery.current = query;
      void request("catalog", { ...query, refresh }).then((result) => {
        if (!active) return;
        if (!result.error && (query.offset ?? 0) > 0 && (query.offset ?? 0) >= result.total) {
          setQuery((current) => ({ ...current, offset: Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1) * PAGE_SIZE, refresh: false }));
          return;
        }
        setCatalog(result);
        setCategories(result.categories);
        if (result.error) {
          setCatalogError(result.error);
          setNotice({ kind: "error", message: result.error });
        }
      }).catch((error: unknown) => {
        if (!active) return;
        const message = errorMessage(error);
        setCatalogError(message);
        setNotice({ kind: "error", message });
      }).finally(() => { if (active) setCatalogLoading(false); });
    }, query.search ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, tab, pluginTab]);

  async function applySnapshot(key: string, operation: () => Promise<ExtensionSnapshot>, message?: string): Promise<boolean> {
    if (operationBusy.current) return false;
    operationBusy.current = true;
    setBusy(key);
    setNotice(null);
    setDialogError(null);
    try {
      const result = await operation();
      if (!mounted.current) return false;
      setSnapshot(result);
      setSnapshotError(null);
      if (message) setNotice({ kind: "success", message });
      return true;
    } catch (error: unknown) {
      if (mounted.current) {
        const message = errorMessage(error);
        setNotice({ kind: "error", message });
        setDialogError(message);
      }
      return false;
    } finally {
      operationBusy.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function refreshSnapshot() {
    if (operationBusy.current) return;
    setSnapshotLoading(true);
    const success = await applySnapshot("snapshot", () => request("snapshot"));
    if (mounted.current) {
      setSnapshotLoading(false);
      if (!success && !snapshot) setSnapshotError("扩展列表加载失败，请重试。");
    }
  }

  function openConfirmation(value: Confirmation) {
    setDialogError(null);
    setConfirmation(value);
  }

  async function confirm() {
    if (!confirmation) return;
    let success = false;
    switch (confirmation.kind) {
      case "install":
        success = await applySnapshot("installPlugin", () => request("installPlugin", { id: confirmation.entry.id }), "插件已安装");
        break;
      case "import":
        success = await applySnapshot("importPlugin", () => request("importPlugin"));
        break;
      case "deletePlugin":
        success = await applySnapshot("deletePlugin", () => request("deletePlugin", { id: confirmation.entry.id }), "插件已删除");
        break;
      case "deleteSkill":
        success = await applySnapshot("deleteSkill", () => request("deleteSkill", { id: confirmation.entry.id }), "Skill 已删除");
        break;
    }
    if (success && mounted.current) setConfirmation(null);
  }

  async function openSkill(entry: SkillEntry) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy("readSkill");
    setDialogError(null);
    const readonly = entry.readonly || entry.source === "plugin";
    setSkillEditor({ draft: { id: entry.id, name: entry.name, description: entry.description, content: "" }, readonly, loading: true });
    try {
      const draft = await request("readSkill", { id: entry.id });
      if (mounted.current) setSkillEditor({ draft: { ...draft, id: entry.id }, readonly, loading: false });
    } catch (error: unknown) {
      if (mounted.current) {
        setSkillEditor(null);
        setNotice({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      operationBusy.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function saveSkill(event: FormEvent) {
    event.preventDefault();
    if (!skillEditor || skillEditor.readonly || skillEditor.loading) return;
    const draft = skillEditor.draft;
    if (!draft.name.trim() || !draft.content.trim()) {
      setDialogError("名称和内容不能为空。");
      return;
    }
    const success = await applySnapshot("saveSkill", () => request("saveSkill", {
      ...draft, name: draft.name.trim(), description: draft.description.trim(),
    }), "Skill 已保存");
    if (success && mounted.current) setSkillEditor(null);
  }

  async function openMcpConfig() {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy("mcpConfig");
    setDialogError(null);
    setMcpEditor({ json: "", loading: true });
    try {
      const json = await request("mcpConfig");
      if (mounted.current) setMcpEditor({ json, loading: false });
    } catch (error: unknown) {
      if (mounted.current) {
        setMcpEditor(null);
        setNotice({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      operationBusy.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function openPluginConfig(entry: PluginEntry) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy("pluginConfig"); setDialogError(null);
    setPluginEditor({ entry, json: "", loading: true });
    try {
      const json = await request("pluginConfig", { id: entry.id });
      if (mounted.current) setPluginEditor({ entry, json, loading: false });
    } catch (error) {
      if (mounted.current) { setPluginEditor(null); setNotice({ kind: "error", message: errorMessage(error) }); }
    } finally { operationBusy.current = false; if (mounted.current) setBusy(null); }
  }

  async function savePluginConfig(event: FormEvent) {
    event.preventDefault();
    if (!pluginEditor || pluginEditor.loading) return;
    const success = await applySnapshot("savePluginConfig", () => request("savePluginConfig", { id: pluginEditor.entry.id, json: pluginEditor.json }), "插件配置已应用");
    if (success && mounted.current) setPluginEditor(null);
  }

  async function saveMcpConfig(event: FormEvent) {
    event.preventDefault();
    if (!mcpEditor || mcpEditor.loading) return;
    try {
      const parsed: unknown = JSON.parse(mcpEditor.json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP 配置必须是 JSON 对象。");
    } catch (error: unknown) {
      setDialogError(`JSON 无效：${errorMessage(error)}`);
      return;
    }
    const success = await applySnapshot("saveMcpConfig", () => request("saveMcpConfig", { json: mcpEditor.json }), "MCP 配置已保存");
    if (success && mounted.current) setMcpEditor(null);
  }

  function filterQuery(update: Partial<CatalogQuery>) {
    setQuery((current) => ({ ...current, ...update, offset: 0, refresh: false }));
  }

  const plugins = snapshot?.plugins.filter((entry) =>
    `${entry.name} ${entry.description} ${entry.source}`.toLocaleLowerCase().includes(pluginSearch.trim().toLocaleLowerCase()),
  ) ?? [];
  const skills = snapshot?.skills.filter((entry) =>
    `${entry.name} ${entry.description} ${entry.source === "plugin" ? "插件" : "个人"}`.toLocaleLowerCase().includes(skillSearch.trim().toLocaleLowerCase()),
  ) ?? [];
  const offset = query.offset ?? 0;
  const totalPages = Math.max(1, Math.ceil((catalog?.total ?? 0) / PAGE_SIZE));
  const retryCatalog = () => setQuery((current) => ({ ...current, offset: 0, refresh: true }));
  const snapshotState = snapshotLoading && !snapshot
    ? <StateMessage loading />
    : !snapshot ? <StateMessage error={snapshotError || "扩展列表不可用。"} onRetry={() => void refreshSnapshot()} /> : null;

  return (
    <section className="extensions-panel" aria-label="插件与技能">
      <Tabs id={id} items={TOP_TABS} value={tab} onChange={setTab} />
      {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
      {tab === "plugins" ? (
        <div role="tabpanel" id={`${id}-panel-plugins`} aria-labelledby={`${id}-tab-plugins`}>
          <div className="ext-heading"><h2>DSH Plugin Hub</h2>
            {pluginTab === "market" && catalog && <span className="ext-muted">{catalog.catalogTotal.toLocaleString()} 个插件 · {catalog.verified.toLocaleString()} 社区精选</span>}
          </div>
          <Tabs id={`${id}-plugins`} items={PLUGIN_TABS} value={pluginTab} onChange={setPluginTab} secondary />
          <div role="tabpanel" id={`${id}-plugins-panel-${pluginTab}`} aria-labelledby={`${id}-plugins-tab-${pluginTab}`}>
            {pluginTab === "market" && <>
              <div className="ext-toolbar ext-market-toolbar">
                <label className="ext-search"><Search size={15} aria-hidden="true" />
                  <input type="search" aria-label="搜索插件市场" placeholder="搜索插件" value={query.search ?? ""}
                    onChange={(event) => filterQuery({ search: event.target.value })} />
                </label>
                <select aria-label="插件分类" value={query.category ?? ""} onChange={(event) => filterQuery({ category: event.target.value })}>
                  <option value="">全部分类</option>{categories.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
                </select>
                <select aria-label="插件排序" value={query.sort ?? "stars"} onChange={(event) => filterQuery({ sort: event.target.value === "updated" ? "updated" : "stars" })}>
                  <option value="stars">最多收藏</option><option value="updated">最近更新</option>
                </select>
                <IconButton label="同步目录" Icon={RefreshCw} disabled={catalogLoading} spinning={catalogLoading} onClick={retryCatalog} />
              </div>
              {catalog && <div className="ext-list-meta"><span>{catalog.total.toLocaleString()} 个结果</span>
                <span>{catalog.stale ? "缓存目录 · " : ""}{catalog.syncedAt > 0 ? `同步于 ${new Date(catalog.syncedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "尚未同步"}</span>
              </div>}
              {catalogLoading ? <StateMessage loading /> : !catalog || (catalogError && catalog.entries.length === 0)
                ? <StateMessage error={catalogError || "目录加载失败。"} onRetry={retryCatalog} />
                : catalog.entries.length === 0 ? <StateMessage empty="没有匹配的插件" />
                : <ul className="ext-list" aria-label="市场插件">{catalog.entries.map((entry) => {
                  const installed = snapshot?.plugins.some((plugin) => plugin.id === entry.id
                    || !!entry.npmPackage && plugin.source === entry.npmPackage
                    || !!entry.repository && plugin.source === entry.repository);
                  const source = entry.npmPackage || entry.repository;
                  return <li key={entry.id} className="ext-row">
                    <div className="ext-entry-icon"><Puzzle size={18} aria-hidden="true" /></div>
                    <div className="ext-entry-content">
                      <div className="ext-entry-title"><h3>{entry.name}</h3>
                        {entry.verified && <span title="社区已验证，不代表 Daisy 宿主兼容"><BadgeCheck size={15} className="ext-verified" aria-label="社区已验证" role="img" /></span>}
                        {entry.version && <span className="ext-version">{entry.version}</span>}
                      </div>
                      {entry.description && <p className="ext-description" title={entry.description}>{entry.description}</p>}
                      <div className="ext-entry-meta"><span>{categoryLabel(entry.category)}</span><span><Star size={12} />{entry.stars.toLocaleString()}</span>
                        {!entry.webInstallable && <span className="ext-warning">需兼容宿主</span>}
                        {entry.tags.slice(0, 2).map((tag) => <span key={tag}>#{tag}</span>)}
                      </div>
                    </div>
                    <div className="ext-row-actions">{installed ? <span className="ext-installed"><Check size={13} />已安装</span>
                      : <IconButton label={source ? `安装 ${entry.name}` : "缺少安装来源"} Icon={Download}
                        disabled={locked || !snapshot || !source || !entry.webInstallable} onClick={() => openConfirmation({ kind: "install", entry })} />}
                    </div>
                  </li>;
                })}</ul>}
              {catalog && catalog.total > PAGE_SIZE && <div className="ext-pagination">
                <span>{Math.min(offset + 1, catalog.total)}–{Math.min(offset + catalog.entries.length, catalog.total)} / {catalog.total.toLocaleString()}</span>
                <div className="ext-row-actions"><IconButton label="上一页" Icon={ChevronLeft} disabled={catalogLoading || offset === 0}
                  onClick={() => setQuery((current) => ({ ...current, offset: Math.max(0, offset - PAGE_SIZE), refresh: false }))} />
                  <span className="ext-page-number">{Math.floor(offset / PAGE_SIZE) + 1} / {totalPages}</span>
                  <IconButton label="下一页" Icon={ChevronRight} disabled={catalogLoading || offset + PAGE_SIZE >= catalog.total}
                    onClick={() => setQuery((current) => ({ ...current, offset: offset + PAGE_SIZE, refresh: false }))} /></div>
              </div>}
              {snapshotError && !snapshot && <div className="ext-inline-retry"><span>已安装状态不可用</span>
                <IconButton label="重新加载扩展" Icon={RefreshCw} disabled={locked} onClick={() => void refreshSnapshot()} /></div>}
            </>}
            {pluginTab === "installed" && <>
              <div className="ext-toolbar"><label className="ext-search"><Search size={15} aria-hidden="true" />
                <input type="search" aria-label="搜索已安装插件" placeholder="搜索已安装插件" value={pluginSearch} onChange={(event) => setPluginSearch(event.target.value)} />
              </label><IconButton label="导入外部插件" Icon={FolderInput} disabled={locked || !snapshot} onClick={() => openConfirmation({ kind: "import" })} />
                <IconButton label="刷新已安装插件" Icon={RefreshCw} disabled={locked} spinning={busy === "snapshot"} onClick={() => void refreshSnapshot()} />
              </div>
              {snapshotState || (plugins.length === 0 ? <StateMessage empty={pluginSearch ? "没有匹配的已安装插件" : "尚未安装插件"} />
                : <ul className="ext-list" aria-label="已安装插件">{plugins.map((entry) => <li key={entry.id} className="ext-row">
                  <div className="ext-entry-icon"><Puzzle size={18} aria-hidden="true" /></div>
                  <div className="ext-entry-content"><div className="ext-entry-title"><h3>{entry.name}</h3><span className="ext-version">{entry.version}</span>
                    {entry.builtin && <span className="ext-muted">内置</span>}</div>
                    {entry.description && <p className="ext-description" title={entry.description}>{entry.description}</p>}
                    <div className="ext-entry-meta"><span className={`ext-status ext-status-${entry.status}`}>{PLUGIN_STATUS[entry.status]}</span>
                      <span className="ext-source" title={entry.source}>{entry.source}</span></div>
                    {entry.error && <p className="ext-entry-error">{entry.error}</p>}
                    {entry.dependencies && <div className="ext-entry-meta">{entry.dependencies.map(dependency => <span key={dependency.name}
                      className={`ext-status ${dependency.available ? "ext-status-ready" : "ext-status-requires_host"}`}>{dependency.name}：{dependency.available ? "可用" : dependency.required ? "缺失" : "未接入（可选）"}</span>)}</div>}
                  </div><div className="ext-row-actions"><Toggle label={entry.name} enabled={entry.enabled} disabled={locked || entry.builtin === true}
                    onChange={(enabled) => void applySnapshot("togglePlugin", () => request("togglePlugin", { id: entry.id, enabled }))} />
                    {!entry.builtin && <>
                      <IconButton label={`打开 ${entry.name} 面板`} Icon={Eye} disabled={locked || !entry.enabled || !entry.panelAvailable}
                        onClick={() => void applySnapshot("openPluginPanel", () => request("openPluginPanel", { id: entry.id }))} />
                      <IconButton label={`配置 ${entry.name}`} Icon={SlidersHorizontal} disabled={locked}
                        onClick={() => void openPluginConfig(entry)} />
                    </>}
                    <IconButton label={entry.builtin ? "内置插件不可删除" : `删除 ${entry.name}`} Icon={Trash2} danger disabled={locked || entry.builtin}
                      onClick={() => openConfirmation({ kind: "deletePlugin", entry })} /></div>
                </li>)}</ul>)}
            </>}
            {pluginTab === "mcp" && <>
              <div className="ext-toolbar"><h3 className="ext-toolbar-title">MCP 服务器{snapshot && <span>{snapshot.mcpServers.length}</span>}</h3>
                <IconButton label="编辑 MCP 配置 JSON" Icon={SlidersHorizontal} disabled={locked || !snapshot} onClick={() => void openMcpConfig()} />
                <IconButton label="刷新 MCP 运行状态" Icon={RefreshCw} disabled={locked} spinning={busy === "snapshot"} onClick={() => void refreshSnapshot()} />
              </div>
              {snapshotState || (snapshot?.mcpServers.length === 0 ? <StateMessage empty="尚未配置 MCP 服务器" />
                : <ul className="ext-list" aria-label="MCP 服务器">{snapshot?.mcpServers.map((entry) => <li key={entry.id} className="ext-row">
                  <div className="ext-entry-icon ext-mcp-icon"><Server size={18} aria-hidden="true" /></div>
                  <div className="ext-entry-content"><div className="ext-entry-title"><h3>{entry.id}</h3></div>
                    <div className="ext-entry-meta"><span className={`ext-status ext-status-${entry.status}`}>{MCP_STATUS[entry.status]}</span>
                      <span>{entry.toolCount} 个工具</span>{!entry.enabled && entry.status !== "disabled" && <span>已停用</span>}</div>
                    {entry.error && <p className="ext-entry-error">{entry.error}</p>}
                  </div>{entry.status === "connecting" && <LoaderCircle size={15} className="ext-spin" aria-label="连接中" />}
                </li>)}</ul>)}
            </>}
          </div>
        </div>
      ) : (
        <div role="tabpanel" id={`${id}-panel-skills`} aria-labelledby={`${id}-tab-skills`}>
          <div className="ext-heading"><h2>技能 Skill</h2>{snapshot && <span className="ext-muted">{snapshot.skills.length} 个技能</span>}</div>
          <div className="ext-toolbar"><label className="ext-search"><Search size={15} aria-hidden="true" />
            <input type="search" aria-label="搜索 Skill" placeholder="搜索技能" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} />
          </label><IconButton label="添加 Skill" Icon={Plus} disabled={locked || !snapshot} onClick={() => {
            setDialogError(null); setSkillEditor({ draft: { name: "", description: "", content: "" }, readonly: false, loading: false });
          }} /><IconButton label="导入 Skill" Icon={FolderInput} disabled={locked || !snapshot}
            onClick={() => void applySnapshot("importSkill", () => request("importSkill"))} />
            <IconButton label="刷新 Skill" Icon={RefreshCw} disabled={locked} spinning={busy === "snapshot"} onClick={() => void refreshSnapshot()} />
          </div>
          {snapshotState || (skills.length === 0 ? <StateMessage empty={skillSearch ? "没有匹配的技能" : "尚未添加技能"} />
            : <ul className="ext-list" aria-label="Skill 列表">{skills.map((entry) => {
              const readonly = entry.readonly || entry.source === "plugin";
              return <li key={entry.id} className="ext-row">
                <div className="ext-entry-icon ext-skill-icon"><FileCode2 size={18} aria-hidden="true" /></div>
                <div className="ext-entry-content"><div className="ext-entry-title"><h3>{entry.name}</h3>
                  {readonly && <LockKeyhole size={12} className="ext-muted" aria-label="只读" role="img" />}</div>
                  {entry.description && <p className="ext-description" title={entry.description}>{entry.description}</p>}
                  <div className="ext-entry-meta"><span>{entry.source === "plugin" ? "插件来源" : "个人技能"}</span>
                    <span className="ext-source" title={entry.path}>{entry.path}</span></div>
                </div><div className="ext-row-actions"><IconButton label={`${readonly ? "查看" : "编辑"} ${entry.name}`}
                  Icon={readonly ? Eye : Pencil} disabled={locked} onClick={() => void openSkill(entry)} />
                  <Toggle label={entry.name} enabled={entry.enabled} disabled={locked}
                    onChange={(enabled) => void applySnapshot("toggleSkill", () => request("toggleSkill", { id: entry.id, enabled }))} />
                  <IconButton label={readonly ? "只读技能不可删除" : `删除 ${entry.name}`} Icon={Trash2} danger disabled={locked || readonly}
                    onClick={() => openConfirmation({ kind: "deleteSkill", entry })} /></div>
              </li>;
            })}</ul>)}
        </div>
      )}
      {confirmation && <Modal title={confirmation.kind === "install" ? "确认安装插件" : confirmation.kind === "import" ? "确认导入外部插件" : "确认删除"}
        busy={busy !== null} error={dialogError} onClose={() => setConfirmation(null)} footer={<>
          <button type="button" className="ext-button" disabled={busy !== null} onClick={() => setConfirmation(null)}>取消</button>
          <button type="button" className={`ext-button ${confirmation.kind.startsWith("delete") ? "ext-button-danger" : "ext-button-primary"}`}
            disabled={busy !== null} onClick={() => void confirm()}>
            {busy ? <LoaderCircle size={15} className="ext-spin" /> : confirmation.kind.startsWith("delete") ? <Trash2 size={15} /> : <Download size={15} />}
            {confirmation.kind === "install" ? "信任来源并安装" : confirmation.kind === "import" ? "信任并选择插件" : "删除"}
          </button></>}>
        {confirmation.kind === "install" || confirmation.kind === "import" ? <>
          {confirmation.kind === "install" ? <div className="ext-confirm-details"><strong>{confirmation.entry.name}</strong>
            <dl><dt>目录</dt><dd>DSH Plugin Hub</dd>
              {confirmation.entry.npmPackage && <><dt>npm</dt><dd>{confirmation.entry.npmPackage}</dd></>}
              {confirmation.entry.repository && <><dt>仓库</dt><dd>{confirmation.entry.repository}</dd></>}
              {confirmation.entry.version && <><dt>版本</dt><dd>{confirmation.entry.version}</dd></>}
            </dl></div> : <p>来源：随后选择的本地外部插件。</p>}
          <p className="ext-trust-warning"><ShieldAlert size={19} aria-hidden="true" /><span>插件可能在本机执行代码，并访问文件、网络和系统资源。请确认来源可信后继续。</span></p>
          {confirmation.kind === "install" && !confirmation.entry.webInstallable && <p className="ext-muted">此插件可能需要兼容宿主。</p>}
        </> : <p>确定删除「{confirmation.entry.name}」？{confirmation.kind === "deleteSkill" ? "技能内容将被移除。" : "插件及其附带技能将被移除。"}</p>}
      </Modal>}
      {skillEditor && <Modal title={skillEditor.readonly ? "查看 Skill · 只读" : skillEditor.draft.id ? "编辑 Skill" : "添加 Skill"}
        busy={busy !== null} error={dialogError} onClose={() => setSkillEditor(null)} footer={<>
          <button type="button" className="ext-button" disabled={busy !== null} onClick={() => setSkillEditor(null)}>{skillEditor.readonly ? "关闭" : "取消"}</button>
          {!skillEditor.readonly && <button type="submit" form={`${id}-skill-form`} className="ext-button ext-button-primary" disabled={busy !== null || skillEditor.loading}>
            {busy === "saveSkill" ? <LoaderCircle size={15} className="ext-spin" /> : <Save size={15} />}保存
          </button>}</>}>
        {skillEditor.loading ? <StateMessage loading /> : <form id={`${id}-skill-form`} className="ext-editor-form" onSubmit={(event) => void saveSkill(event)}>
          <label>名称<input aria-label="名称" autoFocus required readOnly={skillEditor.readonly} disabled={busy !== null} value={skillEditor.draft.name}
            onChange={(event) => setSkillEditor({ ...skillEditor, draft: { ...skillEditor.draft, name: event.target.value } })} /></label>
          <label>描述<textarea aria-label="描述" rows={2} readOnly={skillEditor.readonly} disabled={busy !== null} value={skillEditor.draft.description}
            onChange={(event) => setSkillEditor({ ...skillEditor, draft: { ...skillEditor.draft, description: event.target.value } })} /></label>
          <label>内容<textarea aria-label="内容" className="ext-code-editor" rows={8} required spellCheck={false} readOnly={skillEditor.readonly} disabled={busy !== null} value={skillEditor.draft.content}
            onChange={(event) => setSkillEditor({ ...skillEditor, draft: { ...skillEditor.draft, content: event.target.value } })} /></label>
        </form>}
      </Modal>}
      {mcpEditor && <Modal title="MCP 配置 JSON" busy={busy !== null} error={dialogError} onClose={() => setMcpEditor(null)} footer={<>
        <button type="button" className="ext-button" disabled={busy !== null} onClick={() => setMcpEditor(null)}>取消</button>
        <button type="submit" form={`${id}-mcp-form`} className="ext-button ext-button-primary" disabled={busy !== null || mcpEditor.loading}>
          {busy === "saveMcpConfig" ? <LoaderCircle size={15} className="ext-spin" /> : <Save size={15} />}保存并应用
        </button></>}>
        {mcpEditor.loading ? <StateMessage loading /> : <form id={`${id}-mcp-form`} className="ext-editor-form" onSubmit={(event) => void saveMcpConfig(event)}>
          <label>配置<textarea aria-label="配置" className="ext-code-editor ext-mcp-editor" rows={12} required autoFocus spellCheck={false} disabled={busy !== null} value={mcpEditor.json}
            onChange={(event) => setMcpEditor({ ...mcpEditor, json: event.target.value })} /></label>
          <p className="ext-trust-warning"><ShieldAlert size={17} aria-hidden="true" /><span>应用配置可能启动本机 MCP 进程，请确认命令和来源可信。</span></p>
        </form>}
      </Modal>}
      {pluginEditor && <Modal title={`${pluginEditor.entry.name} · 插件配置`} busy={busy !== null} error={dialogError} onClose={() => setPluginEditor(null)} footer={<>
        <button type="button" className="ext-button" disabled={busy !== null} onClick={() => setPluginEditor(null)}>取消</button>
        <button type="submit" form={`${id}-plugin-form`} className="ext-button ext-button-primary" disabled={busy !== null || pluginEditor.loading}>
          {busy === "savePluginConfig" ? <LoaderCircle size={15} className="ext-spin" /> : <Save size={15} />}保存并应用
        </button></>}>
        {pluginEditor.loading ? <StateMessage loading /> : <form id={`${id}-plugin-form`} className="ext-editor-form" onSubmit={event => void savePluginConfig(event)}>
          <label>插件配置<textarea aria-label="插件配置" className="ext-code-editor ext-mcp-editor" rows={12} required autoFocus spellCheck={false}
            disabled={busy !== null} value={pluginEditor.json} onChange={event => setPluginEditor({ ...pluginEditor, json: event.target.value })} /></label>
          <p className="ext-trust-warning"><ShieldAlert size={17} /><span>配置可能涉及文件、网络或浏览器 Cookie 访问，请确认授权范围后保存。</span></p>
        </form>}
      </Modal>}
    </section>
  );
}
