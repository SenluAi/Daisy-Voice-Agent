import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import type { CredentialRecord } from "@deepseek-ai/dsh-credentials";

interface Stored { revision: number; references: Record<string, string>; records: Record<string, CredentialRecord> }
const MAX_BYTES = 1024 * 1024;
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Secrets are owned by one plugin; Daisy's environment is never a source. */
export class PluginCredentialStore {
  private queues = new Map<string, Promise<unknown>>();

  request(directory: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const pending = (this.queues.get(directory) || Promise.resolve()).then(() => {
      if (signal?.aborted) throw new Error("Credential operation cancelled");
      return this.apply(directory, input);
    });
    const tail = pending.catch(() => {}).finally(() => { if (this.queues.get(directory) === tail) this.queues.delete(directory); });
    this.queues.set(directory, tail);
    return pending;
  }

  private writable(): boolean {
    return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  }

  private read(directory: string): Stored {
    const file = path.join(directory, "credentials.enc");
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error();
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * 2 || !this.writable()) throw new Error();
      const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.references || !data.records
        || typeof data.references !== "object" || Array.isArray(data.references) || typeof data.records !== "object" || Array.isArray(data.records)
        || Object.entries(data.references).some(([key, value]) => !REF.test(key) || typeof value !== "string" || !value.trim())
        || Object.entries(data.records).some(([key, value]) => !KEY.test(key) || !value || !["api-key", "grant"].includes(value.kind))) throw new Error();
      return { revision: data.revision, references: Object.assign(Object.create(null), data.references), records: Object.assign(Object.create(null), data.records) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, references: Object.create(null), records: Object.create(null) };
      throw new Error("无法读取此插件的加密凭据。");
    }
  }

  private write(directory: string, data: Stored): void {
    if (!this.writable()) throw new Error("系统安全凭据存储不可用；不会明文保存密钥。");
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("插件凭据超过大小限制。");
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("插件凭据目录不能是链接。");
    const temporary = path.join(directory, `.credentials-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, safeStorage.encryptString(text), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, path.join(directory, "credentials.enc"));
    } catch { throw new Error("无法保存此插件的加密凭据。"); }
    finally { fs.rmSync(temporary, { force: true }); }
  }

  private apply(directory: string, input: Record<string, unknown>): unknown {
    const action = input.action;
    const record = typeof action === "string" && action.startsWith("record.");
    const name = record ? input.key : input.ref;
    if (action !== "record.list" && (typeof name !== "string" || !(record ? KEY : REF).test(name))) throw new Error("Invalid credential reference");
    const id = String(name);
    const data = this.read(directory);
    const value = data.references[id];
    const stored = data.records[id];
    switch (action) {
      case "resolve": return value ? { value, source: "plugin-store" } : undefined;
      case "describe": return { configured: !!value, ...(value ? { source: "plugin-store" } : {}), writable: this.writable() };
      case "set":
        if (typeof input.value !== "string" || !input.value.trim() || Buffer.byteLength(input.value) > 65536) throw new Error("Invalid credential value; use unset to remove it");
        data.references[id] = input.value; break;
      case "unset": if (!value) return; delete data.references[id]; break;
      case "record.read": return { record: stored, revision: data.revision };
      case "record.describe": return { configured: !!stored, ...(stored ? { kind: stored.kind } : {}), writable: this.writable() };
      case "record.list": return Object.entries(data.records).map(([key, item]) => ({ key, kind: item.kind }));
      case "record.delete": if (!stored) return; delete data.records[id]; break;
      case "record.write": {
        if (input.revision !== data.revision) throw new Error("插件凭据已变化，请重试。");
        const next = input.record as CredentialRecord | undefined;
        if (!next || !["api-key", "grant"].includes(next.kind)) throw new Error("Invalid credential record");
        if (next.kind === "api-key" && ((next.key !== undefined && (typeof next.key !== "string" || !next.key.trim()))
          || (next.env !== undefined && (!next.env || typeof next.env !== "object" || Array.isArray(next.env)
            || Object.entries(next.env).some(([key, item]) => !REF.test(key) || typeof item !== "string"))))) throw new Error("Invalid credential record");
        data.records[id] = JSON.parse(JSON.stringify(next)); break;
      }
      default: throw new Error("Unsupported credential operation");
    }
    data.revision++;
    this.write(directory, data);
    return action === "record.write" ? data.records[id] : undefined;
  }
}
