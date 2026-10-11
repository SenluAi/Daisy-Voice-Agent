import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { validatePluginConfig } from "./pluginConfigValidation";

export interface BundleEntry { id?: string; name: string; config?: Record<string, unknown>; disabled?: boolean }
interface Expression { __jsExpr: string }
// Preserve expressions as data. Never evaluate JavaScript supplied by a bundle.
const expression = yaml.defineScalarTag("tag:yaml.org,2002:js", {
  resolve: (value: string): Expression => ({ __jsExpr: value }), identify: () => false,
});
export const bundleSchema = yaml.JSON_SCHEMA.withTags(expression);

export function readBundle(directory: string): BundleEntry[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch !== "string") return [];
  const file = fs.realpathSync(path.resolve(directory, patch));
  const relative = path.relative(fs.realpathSync(directory), file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || fs.statSync(file).size > 256000) throw new Error("插件默认配置路径无效。");
  const document = yaml.load(fs.readFileSync(file, "utf8"), { schema: bundleSchema });
  if (!Array.isArray(document)) return [];
  return document.flatMap(operation => Array.isArray(operation?.insert) ? operation.insert : [])
    .filter((entry): entry is BundleEntry => !!entry && typeof entry.name === "string");
}

export function resolveBundleConfig(value: unknown, directory: string): Record<string, unknown> {
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!node || typeof node !== "object") return node;
    if ("__jsExpr" in node) {
      const source = (node as Expression).__jsExpr;
      if (typeof source !== "string") throw new Error("无效的插件配置表达式。");
      const home = /^dshHomePath\(['"]profiles\/web\/node_modules\/([^'"]+)['"]\)$/.exec(source);
      if (home) {
        const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
        const prefix = `${pkg.name}/`;
        if (!home[1].startsWith(prefix)) throw new Error("插件配置不能引用其他包的执行文件。");
        const file = path.resolve(directory, home[1].slice(prefix.length));
        const relative = path.relative(directory, file);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("插件执行文件路径无效。");
        return file;
      }
      const env = /^process\.env\.(MANAGED_AGENTS_URL|MANAGED_AGENTS_API_KEY)\s*\?\?\s*['"]([^'"\r\n]*)['"]$/.exec(source);
      if (env) return process.env[env[1]] ?? env[2];
      throw new Error("插件配置使用了不支持的 JavaScript 表达式；请改为明确的 JSON 配置。");
    }
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, resolve(item)]));
  };
  return validatePluginConfig(resolve(value));
}
