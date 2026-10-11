import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LICENSE_REFRESH_MS, type AccessClaims, type LicenseAccessStatus } from "../../shared/license";

interface Options {
  filePath: string;
  endpoint: string;
  deviceCode: string;
  activation: () => { code: string; licenseId: string } | null;
  verify: (token: string, deviceCode: string, nonce?: string) => AccessClaims;
  encrypt: (text: string) => Buffer;
  decrypt: (data: Buffer) => string;
  onChange: (status: LicenseAccessStatus) => void;
  fetch?: typeof fetch;
  now?: () => number;
  monotonic?: () => number;
}
interface Cache { token: string; trustedSeenAt: number; wallSeenAt: number }

export class LicenseLease {
  private token = "";
  private claims?: AccessClaims;
  private trustedAt = 0;
  private monotonicAt = 0;
  private denial = "";
  private expired = false;
  private pending?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private closed = false;
  private checking = true;
  private revision = 0;
  private pendingRevision = 0;
  private readonly now: () => number;
  private readonly monotonic: () => number;

  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.restore();
  }

  private restore(): void {
    try {
      const cache: Cache = JSON.parse(this.options.decrypt(fs.readFileSync(this.options.filePath)));
      const claims = this.options.verify(cache.token, this.options.deviceCode);
      if (!Number.isSafeInteger(cache.trustedSeenAt) || !Number.isSafeInteger(cache.wallSeenAt) ||
          cache.trustedSeenAt < claims.iat * 1000 || cache.trustedSeenAt > claims.exp * 1000 ||
          this.now() < cache.wallSeenAt - 120000) throw new Error("Clock rollback");
      this.token = cache.token;
      this.claims = claims;
      this.trustedAt = cache.trustedSeenAt + Math.max(0, this.now() - cache.wallSeenAt);
      this.monotonicAt = this.monotonic();
    } catch { /* No offline access unless the protected signed cache validates. */ }
  }

  private serverNow(): number {
    return this.trustedAt + Math.max(0, this.monotonic() - this.monotonicAt);
  }

  snapshot(): LicenseAccessStatus {
    const claims = this.claims;
    const now = this.serverNow();
    const trialExpiresAt = claims?.trialExpiresAt ? claims.trialExpiresAt * 1000 : undefined;
    const activation = this.options.activation();
    const fullMatches = claims?.edition === "full" ? activation?.licenseId === claims.licenseId : !activation;
    const trialExpired = this.expired || Boolean(trialExpiresAt && now >= trialExpiresAt);
    const allowed = Boolean(claims && !this.denial && fullMatches && !trialExpired && now < claims.exp * 1000);
    const accessState = allowed ? (claims!.edition === "full" ? "activated" : "trial")
      : trialExpired ? "expired" : this.checking && !claims ? "checking" : "verification_required";
    return {
      allowed, accessState,
      trialStartedAt: claims?.trialStartedAt ? claims.trialStartedAt * 1000 : undefined,
      trialExpiresAt, remainingTrialMs: trialExpiresAt ? Math.max(0, trialExpiresAt - now) : 0,
      leaseExpiresAt: claims ? claims.exp * 1000 : undefined,
      accessMessage: allowed ? (claims!.edition === "full" ? "授权有效" : "七天试用中")
        : trialExpired ? "七天试用已到期，请输入兑换码激活后继续使用"
        : this.denial || (accessState === "checking" ? "正在联网核验授权" : "请联网核验授权，或输入兑换码激活"),
    };
  }

  async start(): Promise<void> {
    this.publish();
    await this.refresh();
    if (!this.closed) {
      this.refreshTimer = setInterval(() => { void this.refresh(); }, LICENSE_REFRESH_MS);
      this.refreshTimer.unref();
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pendingRevision === this.revision ? this.pending : this.pending.then(() => this.refresh());
    this.pendingRevision = this.revision;
    this.pending = this.request().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async request(): Promise<void> {
    const revision = this.revision;
    const requestStartedAt = this.monotonic();
    const activation = this.options.activation();
    const nonce = randomBytes(32).toString("hex");
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
        body: JSON.stringify({ deviceCode: this.options.deviceCode, nonce, ...(activation ? { activationCode: activation.code } : {}) }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      if (text.length > 16000) throw new Error("授权响应过长");
      const body = JSON.parse(text);
      if (this.closed || revision !== this.revision) return;
      if (response.status === 403) {
        this.denial = typeof body.message === "string" ? body.message.slice(0, 300) : "授权已停用，请重新激活";
        this.expired = body.reason === "TRIAL_EXPIRED";
        this.token = "";
        this.removeCache();
      } else if (!response.ok) {
        throw new Error("授权服务暂时不可用");
      } else {
        if (typeof body.accessToken !== "string") throw new Error("授权服务响应无效");
        let claims: AccessClaims;
        try { claims = this.options.verify(body.accessToken, this.options.deviceCode, nonce); }
        catch { this.denial = "授权凭证签名或请求绑定校验失败"; this.removeCache(); throw new Error(this.denial); }
        const current = this.options.activation();
        if (activation?.code !== current?.code || (claims.edition === "full" && claims.licenseId !== current?.licenseId) ||
            (claims.edition === "trial" && current)) throw new Error("核验期间授权已变更，请重新核验");
        this.claims = claims;
        this.token = body.accessToken;
        this.trustedAt = claims.iat * 1000 + Math.max(0, this.monotonic() - requestStartedAt);
        this.monotonicAt = this.monotonic();
        this.denial = "";
        this.expired = false;
        this.persist();
      }
    } catch {
      // A temporary outage may only use the remaining life of an already signed lease.
    } finally {
      this.checking = false;
      if (!this.closed && revision === this.revision) this.publish();
    }
  }

  private removeCache(): void {
    try { fs.rmSync(this.options.filePath, { force: true }); } catch { /* Denied in memory as well. */ }
  }

  private persist(): void {
    if (!this.claims || !this.token || !this.snapshot().allowed) return;
    try {
      const cache: Cache = { token: this.token, trustedSeenAt: Math.floor(this.serverNow()), wallSeenAt: this.now() };
      const encrypted = this.options.encrypt(JSON.stringify(cache));
      fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      const temporary = `${this.options.filePath}.tmp`;
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, this.options.filePath);
    } catch { /* No persistent offline grace when secure storage is unavailable. */ }
  }

  private publish(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const status = this.snapshot();
    this.options.onChange(status);
    if (status.allowed) {
      const remaining = this.claims!.exp * 1000 - this.serverNow();
      this.expiryTimer = setTimeout(() => { this.persist(); this.publish(); }, Math.max(1, Math.min(60000, remaining)));
      this.expiryTimer.unref();
    }
  }

  invalidate(): void {
    this.revision++;
    this.denial = "授权状态已变更，正在重新核验";
    this.removeCache();
    this.publish();
  }

  close(): void {
    this.persist();
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
  }
}
