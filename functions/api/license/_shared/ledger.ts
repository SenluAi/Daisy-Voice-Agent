// 兑换码账本：私有仓库 Daisy-license-ledger 的 redemptions.json。
// 用 GitHub Contents API 的 sha 条件更新实现原子绑定，一个兑换码只能绑定一台设备。

import { base64ToBytes, bytesToBase64, sha256Hex, utf8Decode, utf8Encode } from "./encoding";
import { LicensePayload, normalizeDeviceCode } from "./license";

const CODE_PATTERN = /^DAISY-RDM1(?:-[A-F0-9]{5}){6}$/;
const CONTENT_PATH = "redemptions.json";
const MAX_WRITE_RETRIES = 5;

export interface LedgerEnv {
  DAISY_LICENSE_LEDGER_REPOSITORY?: string;
  DAISY_LICENSE_LEDGER_GITHUB_TOKEN?: string;
}

interface RedemptionRecord {
  state: "available" | "redeemed" | "revoked";
  licenseId: string;
  customer: string;
  createdAt: string;
  redeemedAt?: string;
  deviceCode?: string;
  issuedAt?: string;
}

interface LedgerFile {
  version: 1;
  codes: Record<string, RedemptionRecord>;
}

interface LedgerSnapshot {
  ledger: LedgerFile;
  sha: string;
}

export type ClaimResult =
  | { kind: "claimed" | "already-claimed-by-this-device"; payload: LicensePayload }
  | { kind: "invalid-code" | "already-claimed-by-another-device" };

function requireEnv(env: LedgerEnv, name: keyof LedgerEnv): string {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error("授权服务配置不完整");
  return value.trim();
}

function repository(env: LedgerEnv): string {
  const value = requireEnv(env, "DAISY_LICENSE_LEDGER_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("授权服务配置不正确");
  }
  return value;
}

function headers(env: LedgerEnv): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${requireEnv(env, "DAISY_LICENSE_LEDGER_GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Daisy-License-Service",
  };
}

function contentUrl(env: LedgerEnv): string {
  return `https://api.github.com/repos/${repository(env)}/contents/${CONTENT_PATH}`;
}

export function normalizeRedeemCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^DAISYRDM1[A-F0-9]{30}$/.test(compact)) {
    throw new Error("兑换码格式不正确");
  }
  const id = compact.slice("DAISYRDM1".length);
  const normalized = `DAISY-RDM1-${id.match(/.{1,5}/g)!.join("-")}`;
  if (!CODE_PATTERN.test(normalized)) throw new Error("兑换码格式不正确");
  return normalized;
}

export function redeemCodeHash(code: string): Promise<string> {
  return sha256Hex(normalizeRedeemCode(code));
}

function parseLedger(value: unknown): LedgerFile {
  if (!value || typeof value !== "object") throw new Error("授权记录格式无效");
  const candidate = value as Partial<LedgerFile>;
  if (candidate.version !== 1 || !candidate.codes || typeof candidate.codes !== "object") {
    throw new Error("授权记录格式无效");
  }
  return candidate as LedgerFile;
}

async function readLedger(env: LedgerEnv): Promise<LedgerSnapshot> {
  const response = await fetch(contentUrl(env), { headers: headers(env) });
  if (!response.ok) throw new Error("授权记录暂时不可用");
  const body = await response.json() as { content?: string; sha?: string };
  if (typeof body.content !== "string" || typeof body.sha !== "string") {
    throw new Error("授权记录格式无效");
  }
  try {
    const text = utf8Decode(base64ToBytes(body.content));
    return { ledger: parseLedger(JSON.parse(text)), sha: body.sha };
  } catch {
    throw new Error("授权记录格式无效");
  }
}

async function writeLedger(env: LedgerEnv, ledger: LedgerFile, sha: string): Promise<boolean> {
  const response = await fetch(contentUrl(env), {
    method: "PUT",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Record Daisy redemption",
      content: bytesToBase64(utf8Encode(`${JSON.stringify(ledger, null, 2)}\n`)),
      sha,
    }),
  });
  if (response.status === 409 || response.status === 422) return false;
  if (!response.ok) throw new Error("授权记录暂时不可用");
  return true;
}

export async function claimRedeemCode(
  env: LedgerEnv,
  codeInput: string,
  deviceCodeInput: string,
): Promise<ClaimResult> {
  const codeHash = await redeemCodeHash(codeInput);
  const deviceCode = normalizeDeviceCode(deviceCodeInput);

  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
    const { ledger, sha } = await readLedger(env);
    const record = ledger.codes[codeHash];
    if (!record) return { kind: "invalid-code" };
    if (record.state === "revoked") return { kind: "invalid-code" };

    if (record.state === "redeemed") {
      if (record.deviceCode !== deviceCode || !record.issuedAt) {
        return { kind: "already-claimed-by-another-device" };
      }
      return {
        kind: "already-claimed-by-this-device",
        payload: {
          v: 1,
          appId: "com.daisy.app",
          deviceCode,
          licenseId: record.licenseId,
          issuedAt: record.issuedAt,
          edition: "full",
          customer: record.customer || "",
        },
      };
    }

    const issuedAt = new Date().toISOString();
    record.state = "redeemed";
    record.deviceCode = deviceCode;
    record.redeemedAt = issuedAt;
    record.issuedAt = issuedAt;

    if (!await writeLedger(env, ledger, sha)) continue;
    return {
      kind: "claimed",
      payload: {
        v: 1,
        appId: "com.daisy.app",
        deviceCode,
        licenseId: record.licenseId,
        issuedAt,
        edition: "full",
        customer: record.customer || "",
      },
    };
  }

  throw new Error("兑换请求较多，请稍后重试");
}

export async function isLicenseActive(env: LedgerEnv, payload: LicensePayload): Promise<boolean> {
  const { ledger } = await readLedger(env);
  return Object.values(ledger.codes).some(record => record.state === "redeemed" &&
    record.licenseId === payload.licenseId && record.deviceCode === payload.deviceCode && record.issuedAt === payload.issuedAt);
}

export interface TrialRecord { v: 1; deviceHash: string; startedAt: number }

export async function getOrCreateTrial(env: LedgerEnv, deviceCode: string, now: number): Promise<TrialRecord> {
  const deviceHash = await sha256Hex(normalizeDeviceCode(deviceCode));
  const url = `https://api.github.com/repos/${repository(env)}/contents/trials/${deviceHash}.json`;
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    const read = await fetch(url, { headers: headers(env) });
    if (read.ok) {
      const body = await read.json() as { content: string };
      const record: TrialRecord = JSON.parse(utf8Decode(base64ToBytes(body.content)));
      if (record.v !== 1 || record.deviceHash !== deviceHash || !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) {
        throw new Error("试用记录格式无效");
      }
      return record;
    }
    if (read.status !== 404) throw new Error("试用记录暂时不可用");
    const record: TrialRecord = { v: 1, deviceHash, startedAt: now };
    const write = await fetch(url, {
      method: "PUT", headers: { ...headers(env), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Register Daisy trial", content: bytesToBase64(utf8Encode(JSON.stringify(record))) }),
    });
    if (write.ok) return record;
    if (write.status !== 409 && write.status !== 422) throw new Error("试用登记暂时不可用");
  }
  throw new Error("试用登记繁忙，请稍后重试");
}
