// Daisy 授权签发（Cloudflare Pages Functions 版本）
// 与 netlify/functions/_shared/license.ts 的载荷格式完全一致：
// 客户端只保存并离线验证最终激活码，服务端不记录任何码或密钥。

import {
  base64ToBytes,
  base64UrlFromBytes,
  pemToDer,
  utf8Decode,
  utf8Encode,
} from "./encoding";
import { LICENSE_PUBLIC_KEY, type AccessClaims } from "../../../../src/shared/license";

export const APP_ID = "com.daisy.app";
const DEVICE_CODE_PATTERN = /^DSY1(?:-[0-9A-F]{5}){8}$/;

export interface LicenseEnv {
  DAISY_LICENSE_PRIVATE_KEY_PEM_B64?: string;
}

export interface LicensePayload {
  v: 1;
  appId: typeof APP_ID;
  deviceCode: string;
  licenseId: string;
  issuedAt: string;
  edition: "full";
  customer: string;
}

function requireEnv(env: LicenseEnv, name: keyof LicenseEnv): string {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error("授权服务配置不完整");
  return value.trim();
}

export function normalizeDeviceCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^DSY1[0-9A-F]{40}$/.test(compact)) {
    throw new Error("设备码格式不正确");
  }
  const id = compact.slice(4);
  const normalized = `DSY1-${id.match(/.{1,5}/g)!.join("-")}`;
  if (!DEVICE_CODE_PATTERN.test(normalized)) throw new Error("设备码格式不正确");
  return normalized;
}

export function canonicalPayload(payload: LicensePayload): string {
  return JSON.stringify({
    v: 1,
    appId: APP_ID,
    deviceCode: payload.deviceCode,
    licenseId: payload.licenseId,
    issuedAt: payload.issuedAt,
    edition: "full",
    customer: payload.customer || "",
  });
}

export async function issueActivationCode(
  env: LicenseEnv,
  payload: LicensePayload,
): Promise<string> {
  const pem = utf8Decode(base64ToBytes(requireEnv(env, "DAISY_LICENSE_PRIVATE_KEY_PEM_B64")));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, utf8Encode(canonicalPayload(payload))),
  );
  return base64UrlFromBytes(
    utf8Encode(JSON.stringify({ payload, signature: base64UrlFromBytes(signature) })),
  );
}

export async function issueAccessToken(env: LicenseEnv, claims: AccessClaims): Promise<string> {
  const pem = utf8Decode(base64ToBytes(requireEnv(env, "DAISY_LICENSE_PRIVATE_KEY_PEM_B64")));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "Ed25519" }, false, ["sign"]);
  const header = base64UrlFromBytes(utf8Encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "daisy-1" })));
  const payload = base64UrlFromBytes(utf8Encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("Ed25519", key, utf8Encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

export async function verifyActivationCode(code: string, deviceCode: string): Promise<LicensePayload> {
  if (code.length > 8192) throw new Error("激活码无效");
  const decoded = JSON.parse(utf8Decode(base64ToBytes(code.replace(/-/g, "+").replace(/_/g, "/"))));
  const payload = decoded.payload as LicensePayload;
  if (!payload || payload.v !== 1 || payload.appId !== APP_ID || payload.edition !== "full" ||
      payload.deviceCode !== deviceCode || typeof payload.licenseId !== "string" || !payload.licenseId ||
      typeof decoded.signature !== "string" || typeof payload.issuedAt !== "string" || !Number.isFinite(Date.parse(payload.issuedAt))) {
    throw new Error("激活码绑定或许可字段无效");
  }
  const key = await crypto.subtle.importKey("spki", base64ToBytes(LICENSE_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  const signature = base64ToBytes(decoded.signature.replace(/-/g, "+").replace(/_/g, "/"));
  if (!await crypto.subtle.verify("Ed25519", key, signature, utf8Encode(canonicalPayload(payload)))) throw new Error("激活码签名无效");
  return payload;
}
