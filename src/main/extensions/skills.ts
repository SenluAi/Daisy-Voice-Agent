import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillDraft, SkillEntry } from "../../shared/extensions";

// A local structural type supports js-yaml 4/5 without changing shared declarations.
const yaml = require("js-yaml") as {
  JSON_SCHEMA: unknown;
  load(source: string, options: { schema: unknown }): unknown;
  dump(value: unknown, options: { schema: unknown; noRefs: boolean; lineWidth: number }): string;
};

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 1000;
const MAX_DEPTH = 16;
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function segment(value: string): boolean {
  return SEGMENT.test(value) && !value.endsWith(".") && !RESERVED.test(value);
}

function pluginId(value: string): boolean {
  return /^[a-zA-Z0-9@][a-zA-Z0-9@._/-]{0,199}$/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function pluginToken(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return pluginId(decoded) && encodeURIComponent(decoded) === value;
  } catch { return false; }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function protectCodex(target: string): void {
  const roots = [path.join(os.homedir(), ".codex", "skills")];
  if (process.env.CODEX_HOME) roots.push(path.join(process.env.CODEX_HOME, "skills"));
  if (roots.some((root) => within(path.resolve(root), path.resolve(target)))) {
    throw new Error("Daisy skills must be stored outside Codex skills");
  }
}

function checkedPath(target: string, allowMissing = false): string {
  const absolute = path.resolve(target);
  const anchor = path.parse(absolute).root;
  let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
      throw new Error("Skill path is unavailable");
    }
    if (stat.isSymbolicLink()) throw new Error("Skill symbolic links are not allowed");
  }
  if (!within(absolute, fs.realpathSync(absolute))) throw new Error("Skill path escaped its root");
  return absolute;
}

function readText(file: string, limit = MAX_SKILL_BYTES): string {
  checkedPath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > limit) throw new Error("Invalid or oversized skill file");
  return fs.readFileSync(file, "utf8");
}

function parseSkill(text: string): SkillDraft {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  if (!match || Buffer.byteLength(match[1], "utf8") > MAX_FRONTMATTER_BYTES) throw new Error("Skill requires YAML frontmatter");
  let metadata: unknown;
  try { metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }); } catch { throw new Error("Invalid skill YAML"); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid skill metadata");
  const fields = metadata as Record<string, unknown>;
  const draft = { name: fields.name, description: fields.description ?? fields.desc ?? "", content: text.slice(match[0].length) };
  validateDraft(draft);
  return draft as SkillDraft;
}

function validateDraft(draft: { name?: unknown; description?: unknown; content?: unknown }): void {
  if (typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 200 || /[\u0000-\u001f]/.test(draft.name) ||
      typeof draft.description !== "string" || draft.description.length > 4000 || draft.description.includes("\0") ||
      typeof draft.content !== "string" || draft.content.includes("\0") || Buffer.byteLength(draft.content, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("Invalid skill name, description or Markdown content");
  }
}

function atomicWrite(file: string, text: string): void {
  checkedPath(file, true);
  protectCodex(file);
  const temporary = path.join(path.dirname(file), `.write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    checkedPath(file, true);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

interface PluginRoot { id: string; root: string }
interface Resource { relative: string; directory: boolean }
interface Budget { bytes: number; entries: number }

function copyResource(source: string, destination: string, budget: Budget): void {
  checkedPath(source);
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_RESOURCE_BYTES) throw new Error("Skill resource changed during import");
    output = fs.openSync(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const bytes = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!bytes) break;
      total += bytes;
      budget.bytes += bytes;
      if (total > MAX_RESOURCE_BYTES || budget.bytes > MAX_IMPORT_BYTES) throw new Error("Skill resources grew beyond the import limit");
      let written = 0;
      while (written < bytes) written += fs.writeSync(output, buffer, written, bytes - written);
    }
    fs.fchmodSync(output, stat.mode & 0o777);
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

function inspectTree(root: string, budget: Budget, current = root, depth = 0, bounded = true): Resource[] {
  checkedPath(current);
  if (!within(root, fs.realpathSync(current)) || !fs.lstatSync(current).isDirectory() || (bounded && depth > MAX_DEPTH)) {
    throw new Error("Invalid skill resource directory");
  }
  const result: Resource[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (++budget.entries > MAX_IMPORT_ENTRIES && bounded) throw new Error("Too many skill resources");
    const file = path.join(current, entry.name);
    checkedPath(file);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      result.push({ relative: path.relative(root, file), directory: true });
      result.push(...inspectTree(root, budget, file, depth + 1, bounded));
    } else {
      if (!stat.isFile() || stat.nlink > 1 || (bounded && stat.size > MAX_RESOURCE_BYTES)) throw new Error("Invalid skill resource file");
      budget.bytes += stat.size;
      if (bounded && budget.bytes > MAX_IMPORT_BYTES) throw new Error("Skill resources exceed 32 MiB");
      result.push({ relative: path.relative(root, file), directory: false });
    }
  }
  return result;
}

export class SkillStore {
  private readonly root: string;
  private readonly personal: string;
  private readonly disabledFile: string;
  private pluginRoots: PluginRoot[] = [];

  constructor(root: string) {
    this.root = path.resolve(root);
    this.personal = path.join(this.root, "skills");
    this.disabledFile = path.join(this.personal, "disabled.json");
    protectCodex(this.root);
    protectCodex(this.personal);
    checkedPath(this.personal, true);
    fs.mkdirSync(this.personal, { recursive: true });
    checkedPath(this.personal);
  }

  setPluginRoots(roots: Array<{ id: string; root: string }>): void {
    const ids = new Set<string>();
    const next = roots.map((item) => {
      if (typeof item.id !== "string" || !pluginId(item.id) || ids.has(item.id)) throw new Error("Invalid or duplicate skill plugin ID");
      ids.add(item.id);
      const root = checkedPath(item.root, true);
      if (within(this.personal, root) || within(root, this.personal)) throw new Error("Plugin skills overlap personal skills");
      if (fs.existsSync(root) && !fs.lstatSync(root).isDirectory()) throw new Error("Invalid plugin skill directory");
      return { id: item.id, root };
    });
    this.pluginRoots = next;
  }

  list(): SkillEntry[] {
    const disabled = this.disabled();
    const entries: SkillEntry[] = [];
    this.scan(this.personal, "personal", undefined, disabled, entries);
    for (const plugin of this.pluginRoots) {
      this.scan(plugin.root, "plugin", plugin.id, disabled, entries);
      this.scan(path.join(plugin.root, "skills"), "plugin", plugin.id, disabled, entries);
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  read(id: string): SkillDraft {
    const entry = this.resolve(id);
    return { ...parseSkill(readText(entry.path)), id };
  }

  save(draft: SkillDraft): SkillEntry {
    validateDraft(draft);
    const existing = draft.id ? this.resolve(draft.id) : undefined;
    if (existing?.readonly) throw new Error("Plugin skills are read-only");
    checkedPath(this.personal);
    const slug = existing ? draft.id!.slice("personal:".length) : this.availableSlug(draft.name);
    const directory = path.join(this.personal, slug);
    const file = path.join(directory, "SKILL.md");
    const text = "---\n" + yaml.dump({ name: draft.name, description: draft.description },
      { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1 }) + "---\n" + draft.content;
    if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill exceeds 1 MiB");
    this.disabled();
    if (!existing) fs.mkdirSync(directory);
    try { atomicWrite(file, text); } catch (error) {
      if (!existing) fs.rmdirSync(directory);
      throw error;
    }
    return this.resolve(`personal:${slug}`);
  }

  importDirectory(directory: string): void {
    const source = checkedPath(directory);
    if (!fs.lstatSync(source).isDirectory() || within(this.personal, source) || within(source, this.personal)) {
      throw new Error("Invalid skill import directory");
    }
    const roots = fs.existsSync(path.join(source, "SKILL.md")) ? [source] : fs.readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(source, entry.name));
    if (roots.length > MAX_IMPORT_ENTRIES) throw new Error("Too many skill directories");
    const budget: Budget = { bytes: 0, entries: 0 };
    const planned = roots.flatMap((root) => {
      checkedPath(root);
      if (!fs.existsSync(path.join(root, "SKILL.md"))) return [];
      const draft = parseSkill(readText(path.join(root, "SKILL.md")));
      return [{ root, draft, resources: inspectTree(root, budget) }];
    });
    if (!planned.length) throw new Error("No SKILL.md found in the selected directory");
    this.disabled();
    checkedPath(this.personal);
    const staging = path.join(this.personal, `.import-${randomUUID()}`);
    fs.mkdirSync(staging);
    const committed: string[] = [];
    const copiedBudget: Budget = { bytes: 0, entries: 0 };
    const writtenBudget: Budget = { bytes: 0, entries: 0 };
    try {
      for (const [index, skill] of planned.entries()) {
        const staged = path.join(staging, String(index));
        fs.mkdirSync(staged);
        for (const resource of skill.resources) {
          const original = checkedPath(path.join(skill.root, resource.relative));
          const destination = path.join(staged, resource.relative);
          if (resource.directory) {
            if (!fs.lstatSync(original).isDirectory()) throw new Error("Skill resource changed during import");
            fs.mkdirSync(destination);
          } else {
            copyResource(original, destination, writtenBudget);
          }
        }
        inspectTree(staged, copiedBudget);
        parseSkill(readText(path.join(staged, "SKILL.md")));
      }
      for (const [index, skill] of planned.entries()) {
        const basename = path.basename(skill.root);
        const slug = this.availableSlug(segment(basename) ? basename : skill.draft.name);
        const destination = path.join(this.personal, slug);
        checkedPath(destination, true);
        fs.renameSync(path.join(staging, String(index)), destination);
        committed.push(destination);
      }
    } catch (error) {
      for (const destination of committed) this.removeManagedDirectory(destination);
      throw error;
    } finally { this.removeManagedDirectory(staging); }
  }

  toggle(id: string, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Skill enabled must be boolean");
    this.resolve(id);
    const disabled = this.disabled();
    if (enabled) disabled.delete(id); else disabled.add(id);
    this.writeDisabled(disabled);
  }

  delete(id: string): void {
    const entry = this.resolve(id);
    if (entry.readonly || entry.source !== "personal") throw new Error("Only personal Daisy skills can be deleted");
    const disabled = this.disabled();
    this.removeManagedDirectory(path.dirname(entry.path));
    disabled.delete(id);
    this.writeDisabled(disabled);
  }

  prompt(): string {
    let prompt = "";
    for (const entry of this.list().filter((skill) => skill.enabled).slice(0, 30)) {
      const line = JSON.stringify({ id: entry.id, name: entry.name, description: entry.description.slice(0, 240) }) + "\n";
      if (prompt.length + line.length > 8000) break;
      prompt += line;
    }
    return prompt;
  }

  load(id: string): string {
    const entry = this.resolve(id);
    if (!entry.enabled) throw new Error("Skill is disabled");
    return readText(entry.path);
  }

  private disabled(): Set<string> {
    checkedPath(this.personal);
    try {
      const value: unknown = JSON.parse(readText(this.disabledFile, 128 * 1024));
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !this.validId(id))) {
        throw new Error("Invalid disabled skill state");
      }
      return new Set(value);
    } catch (error) {
      if (!fs.existsSync(this.disabledFile)) {
        checkedPath(this.disabledFile, true);
        return new Set();
      }
      throw new Error("Unable to read disabled skill state");
    }
  }

  private writeDisabled(disabled: Set<string>): void {
    checkedPath(this.personal);
    atomicWrite(this.disabledFile, JSON.stringify([...disabled].sort(), null, 2) + "\n");
  }

  private validId(id: string): boolean {
    const parts = id.split(":");
    return (parts.length === 2 && parts[0] === "personal" && segment(parts[1])) ||
      (parts.length === 3 && parts[0] === "plugin" && pluginToken(parts[1]) && segment(parts[2]));
  }

  private resolve(id: string): SkillEntry {
    if (typeof id !== "string" || !this.validId(id)) throw new Error("Invalid skill ID");
    const parts = id.split(":");
    const personal = parts[0] === "personal";
    const plugin = personal ? undefined : this.pluginRoots.find((item) => encodeURIComponent(item.id) === parts[1]);
    if (!personal && !plugin) throw new Error("Skill plugin not found");
    const name = parts[parts.length - 1];
    const root = personal ? this.personal : plugin!.root;
    const candidates = personal ? [path.join(root, name, "SKILL.md")] : [
      ...(name === path.basename(root) ? [path.join(root, "SKILL.md")] : []),
      path.join(root, name, "SKILL.md"),
      ...(name === "skills" ? [path.join(root, "skills", "SKILL.md")] : []),
      path.join(root, "skills", name, "SKILL.md"),
    ];
    const disabled = this.disabled();
    for (const file of candidates) {
      try {
        checkedPath(file);
        if (!within(root, fs.realpathSync(file))) continue;
        const draft = parseSkill(readText(file));
        return { id, name: draft.name, description: draft.description, path: file, enabled: !disabled.has(id),
          source: personal ? "personal" : "plugin", readonly: !personal };
      } catch {}
    }
    throw new Error("Skill not found or unsafe");
  }

  private scan(root: string, source: SkillEntry["source"], plugin: string | undefined, disabled: Set<string>, output: SkillEntry[]): void {
    try {
      checkedPath(root);
      const single = source === "plugin" && fs.existsSync(path.join(root, "SKILL.md"));
      const directories = single ? [path.basename(root)] : fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
      for (const name of directories) {
        if (!segment(name)) continue;
        const directory = single ? root : path.join(root, name);
        const file = path.join(directory, "SKILL.md");
        try {
          checkedPath(directory);
          if (!within(root, fs.realpathSync(directory))) continue;
          const draft = parseSkill(readText(file));
          const id = source === "personal" ? `personal:${name}` : `plugin:${encodeURIComponent(plugin!)}:${name}`;
          if (output.some((entry) => entry.id === id)) continue;
          output.push({ id, name: draft.name, description: draft.description, path: file,
            enabled: !disabled.has(id), source, readonly: source === "plugin" });
        } catch {}
      }
    } catch {}
  }

  private availableSlug(name: string): string {
    const candidate = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[.-]+$/g, "").slice(0, 60);
    const base = segment(candidate) ? candidate : "skill";
    let slug = base;
    while (fs.existsSync(path.join(this.personal, slug))) slug = `${base}-${randomUUID().slice(0, 8)}`;
    checkedPath(path.join(this.personal, slug), true);
    return slug;
  }

  private removeManagedDirectory(directory: string): void {
    checkedPath(this.personal);
    const target = checkedPath(directory);
    if (!within(this.personal, target) || target === this.personal) throw new Error("Cannot delete outside personal skill storage");
    protectCodex(target);
    inspectTree(target, { bytes: 0, entries: 0 }, target, 0, false);
    fs.rmSync(target, { recursive: true, force: false });
  }
}
