import { CredentialProvider, type CredentialKey, type CredentialRecord, type CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";

type Call = (payload: Record<string, unknown>) => Promise<any>;
export class PluginCredentialProvider extends CredentialProvider {
  private queue = Promise.resolve();
  constructor(ctx: Context, private call: Call) { super(ctx); }
  resolve(ref: CredentialRef) { return this.call({ action: "resolve", ref }); }
  describe(ref: CredentialRef) { return this.call({ action: "describe", ref }); }
  async set(ref: CredentialRef, value: string): Promise<void> { await this.call({ action: "set", ref, value }); this.notifyUpdated(ref); }
  async unset(ref: CredentialRef): Promise<void> { await this.call({ action: "unset", ref }); this.notifyUpdated(ref); }
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return (await this.call({ action: "record.read", key })).record; }
  describeRecord(key: CredentialKey) { return this.call({ action: "record.describe", key }); }
  listRecords() { return this.call({ action: "record.list" }); }
  async deleteRecord(key: CredentialKey): Promise<void> { await this.call({ action: "record.delete", key }); this.notifyRecordUpdated(key); }
  modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    const result = this.queue.then(async () => {
      const { record: current, revision } = await this.call({ action: "record.read", key });
      const next = await mutate(current);
      if (next === undefined) return current;
      const saved = await this.call({ action: "record.write", key, record: next, revision });
      this.notifyRecordUpdated(key);
      return saved;
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}
