import type { Context } from "@deepseek-ai/cordis";

type Dictionary = Record<string, string>;
export function localeService(ctx: Context) {
  const dictionaries = new Map<string, Map<string, Dictionary>>();
  const listeners = new Set<() => void>();
  const translators = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  let revision = 0;
  const changed = () => { revision++; for (const listener of listeners) listener(); };
  return {
    ctx, locale: "zh",
    getLocale: () => ({ active: "zh", revision, locales: [{ id: "zh", label: "中文" }, { id: "en", label: "English" }] }),
    getSnapshot: () => ({ active: "zh", revision }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register(this: { ctx: Context }, namespace: string, language: string | Record<string, Dictionary>, dictionary?: Dictionary) {
      const entries = typeof language === "string" ? [[language, dictionary]] : Object.entries(language);
      if (!namespace || entries.some(([id, dict]) => !id || !dict || Object.values(dict).some(x => typeof x !== "string"))) throw new Error("Invalid locale dictionary");
      const list = dictionaries.get(namespace) || new Map<string, Dictionary>();
      if (entries.some(([id]) => list.has(String(id)))) throw new Error("Duplicate locale dictionary");
      dictionaries.set(namespace, list);
      return this.ctx.effect(() => {
        for (const [id, dict] of entries) list.set(String(id), dict as Dictionary);
        changed();
        return () => { for (const [id] of entries) list.delete(String(id)); changed(); };
      });
    },
    bind(namespace: string) {
      let translate = translators.get(namespace);
      if (!translate) {
        translate = (key, values = {}) => {
          const list = dictionaries.get(namespace);
          const common = dictionaries.get("common");
          const text = list?.get("zh")?.[key] ?? list?.get("en")?.[key] ?? common?.get("zh")?.[key] ?? common?.get("en")?.[key] ?? key;
          return text.replace(/\{([^{}]+)\}/g, (match, id) => id in values ? String(values[id]) : match);
        };
        translators.set(namespace, translate);
      }
      return translate;
    },
  };
}
