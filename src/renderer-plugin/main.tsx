import React, { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import * as Cordis from "@deepseek-ai/cordis";
import * as JSXRuntime from "react/jsx-runtime";
import { localeService } from "./locale";
import { Puzzle, RotateCw } from "lucide-react";
import "./styles.css";

type Renderer = (props: Record<string, unknown>) => ReactNode;
interface Tab { id: string; kind: string; title?: string | (() => ReactNode) }
const context = new Cordis.Context();
const tabs = new Map<string, Tab>();
const slots = new Map<string, Map<string, Renderer>>();
const modules = new Map<string, Record<string, unknown>>();
const onboardingDone = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
let selected = "";
let error = "";
let notice = "";
let loading = true;
const notify = () => { revision++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

async function post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function provider(name: string, service: { ctx: Cordis.Context; [key: string]: unknown }): void {
  Object.defineProperty(service, Cordis.symbols.tracker, { value: { property: "ctx" } });
  context.provide(name, service);
}

provider("slots", {
  ctx: context,
  inject(this: { ctx: Cordis.Context }, name: string, callback: () => void | (() => void)) {
    if (!["sidebar.right.pane.tab", "sidebar.right.pane.tab.title", "settings.section", "settings.onboarding"].includes(name)) throw new Error(`不支持的插件界面插槽：${name}`);
    return this.ctx.effect(() => callback() || (() => {}), `slots.inject(${name})`);
  },
  register(this: { ctx: Cordis.Context }, definition: { name: string; key?: string; id?: string; label?: () => ReactNode; locale?: string; inject?: () => Record<string, unknown> }, render: Renderer) {
    const key = definition?.key || definition?.id;
    if (typeof render !== "function" || !key) throw new Error("插件插槽定义无效");
    const list = slots.get(definition.name) || new Map<string, Renderer>();
    slots.set(definition.name, list);
    if (list.has(key)) throw new Error("插件插槽重复注册");
    return this.ctx.effect(() => {
      list.set(key, props => React.createElement(render, { ...props,
        ...(definition.locale ? { t: this.ctx.get("locale").bind(definition.locale) } : {}), ...definition.inject?.() }));
      const tabId = `settings:${key}`;
      if (definition.name === "settings.section") {
        tabs.set(tabId, { id: tabId, kind: key, title: definition.label });
        if (!selected) selected = tabId;
      }
      notify();
      return () => {
        list.delete(key);
        if (definition.name === "settings.section") { tabs.delete(tabId); if (selected === tabId) selected = tabs.keys().next().value || ""; }
        notify();
      };
    });
  },
});
provider("locale", localeService(context));
provider("connection", {
  ctx: context,
  rpc: { call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => post("/_daisy/rpc", { channel, endpoint, payload }, signal) },
});
provider("sidebarRightTabs", {
  ctx: context,
  register(this: { ctx: Cordis.Context }, tab: Tab) {
    if (!tab?.id || !tab.kind || tabs.has(tab.id)) throw new Error("插件侧栏定义无效或重复");
    return this.ctx.effect(() => {
      tabs.set(tab.id, tab); if (!selected) selected = tab.id; notify();
      return () => { tabs.delete(tab.id); if (selected === tab.id) selected = tabs.keys().next().value || ""; notify(); };
    });
  },
});
provider("sidebarRight", {
  ctx: context,
  async openTab(kind: string, options: { params?: { url?: string } } = {}) {
    if (kind === "browser") return post("/_daisy/open-external", { url: options.params?.url });
    const tab = [...tabs.values()].find(x => x.kind === kind);
    if (!tab) throw new Error(`未注册的插件侧栏：${kind}`);
    selected = tab.id; notify();
    return { id: tab.id };
  },
});
provider("sessions", {
  ctx: context,
  retain(id: string) {
    if (id !== "daisy") throw new Error("无效的 Daisy 会话");
    let released = false;
    return { ready: Promise.resolve(), release() { released = true; }, binding: { session: {
      async prompt(content: unknown, mode: string) {
        if (released) throw new Error("会话引用已释放");
        const result = await post("/_daisy/prompt", { sessionId: id, content, mode });
        notice = "已加入 Daisy 对话队列"; notify();
        return result;
      },
    } } };
  },
});

const externals: Record<string, unknown> = { react: React, "react-dom": ReactDOM, "react-dom/client": { createRoot }, "react/jsx-runtime": JSXRuntime, "@deepseek-ai/cordis": Cordis };
(window as any).__ModuleLoader__ = {
  load(module: { id: string; factory(require: (id: string) => unknown): Record<string, unknown> }) {
    if (!module?.id || typeof module.factory !== "function" || modules.has(module.id)) throw new Error("客户端模块定义无效或重复");
    const exports = module.factory(id => {
      if (id in externals) return externals[id];
      if (modules.has(id)) return modules.get(id);
      throw new Error(`未提供的客户端模块：${id}`);
    });
    if (!exports || typeof exports.apply !== "function") throw new Error("客户端必须导出 Cordis apply()");
    const plugin = exports as unknown as Cordis.Plugin;
    if (!context.registry.resolve(plugin)) throw new Error("客户端 Cordis 模块无效");
    modules.set(module.id, exports);
    context.plugin(plugin);
  },
};

class PanelBoundary extends React.Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(cause: Error) { return { error: cause.message }; }
  render() { return this.state.error ? <p role="alert" className="panel-error">{this.state.error}</p> : this.props.children; }
}

function Panel() {
  useSyncExternalStore(subscribe, () => revision);
  const tab = tabs.get(selected);
  const render = tab ? selected.startsWith("settings:") ? slots.get("settings.section")?.get(selected.slice(9)) : slots.get("sidebar.right.pane.tab")?.get(tab.id) : undefined;
  if (tab) localStorage.setItem("dsh.sidebar-right.v1.daisy", JSON.stringify({ tabs: [{ id: tab.id, kind: tab.kind }] }));
  return <main className="daisy-plugin-shell">
    <header><Puzzle size={19} /><strong>Daisy 插件</strong><span className="panel-notice" role="status">{notice}</span>
      <button title="重新加载面板" aria-label="重新加载面板" onClick={() => location.reload()}><RotateCw size={17} /></button></header>
    <nav role="tablist" aria-label="插件面板">{[...tabs.values()].map(item => <button key={item.id} role="tab" aria-selected={selected === item.id}
      onClick={() => { selected = item.id; notify(); }}>{typeof item.title === "function" ? item.title() : item.title || item.kind}</button>)}</nav>
    <section className="panel-content"><PanelBoundary>
      {!error && !loading && [...(slots.get("settings.onboarding") || [])].filter(([id]) => !onboardingDone.has(id)).map(([id, component]) => React.createElement(component, { key: id,
        complete: () => { onboardingDone.add(id); notify(); }, openSection: (section: string) => { if (tabs.has(`settings:${section}`)) { selected = `settings:${section}`; notify(); } }, explicit: false }))}
      {error ? <p role="alert" className="panel-error">{error}</p> : loading ? <p className="panel-empty">正在加载插件</p>
        : render ? React.createElement(render as React.ComponentType<any>, { sessionId: "daisy", useTabInfo: () => ({ sessionId: "daisy", id: tab!.id, kind: tab!.kind }) })
          : <p className="panel-empty">没有可显示的插件面板</p>}
    </PanelBoundary></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Panel />);
window.addEventListener("error", event => { error = event.message; notify(); });
window.addEventListener("unhandledrejection", event => { error = String(event.reason?.message || event.reason); notify(); });
window.addEventListener("beforeunload", () => { void context.fiber.dispose(); });

void (async () => {
  try {
    const manifest = await fetch("/_daisy/manifest").then(response => response.json());
    if (!manifest.client) throw new Error("插件没有客户端入口");
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script"); script.src = "/_daisy/client.js";
      script.onload = () => resolve(); script.onerror = () => reject(new Error("客户端模块加载失败")); document.head.append(script);
    });
    for (let attempt = 0; attempt < 16; attempt++) {
      const fibers = Array.from(context.registry.values()).flatMap(runtime => Array.from(runtime.fibers));
      await Promise.all(fibers.map(fiber => fiber.await()));
      if (fibers.every(fiber => !fiber.inertia)) {
        const missing = fibers.flatMap(fiber => Object.keys(fiber.inject).filter(name => !fiber.ctx.reflect._getImpl(name, true)));
        if (missing.length) throw new Error(`客户端缺少服务：${[...new Set(missing)].join("、")}`);
        break;
      }
    }
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  finally { loading = false; notify(); }
})();
