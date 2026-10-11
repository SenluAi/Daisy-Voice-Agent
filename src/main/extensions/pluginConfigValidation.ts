export function validatePluginConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 256000) throw new Error("插件配置必须为大小合理的 JSON 对象。");
  const visit = (node: unknown, depth: number): void => {
    if (depth > 20) throw new Error("插件配置嵌套层级过深。");
    if (!node || typeof node !== "object") return;
    for (const [key, nested] of Object.entries(node)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("插件配置包含无效属性。");
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  return value as Record<string, unknown>;
}
