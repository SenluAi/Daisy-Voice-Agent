// 离线验签激活码：只依赖内置公钥，不联网即可判断激活码是否有效且属于本机。
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { LICENSE_APP_ID, LICENSE_ISSUER, LICENSE_PUBLIC_KEY, LEASE_SECONDS, TRIAL_SECONDS, type AccessClaims } from "../../shared/license";

const APP_ID = "com.daisy.app";

/** 内置 Ed25519 公钥（SPKI DER 的 base64）。换密钥时需要同步这里的值。 */
const ACTIVATION_PUBLIC_KEY_BASE64 = LICENSE_PUBLIC_KEY;

export interface LicensePayload {
  v: 1;
  appId: string;
  deviceCode: string;
  licenseId: string;
  issuedAt: string;
  edition: "full";
  customer?: string;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: string };

let cachedPublicKey: KeyObject | null = null;

function getPublicKey(): KeyObject {
  if (!cachedPublicKey) {
    cachedPublicKey = createPublicKey({
      key: Buffer.from(ACTIVATION_PUBLIC_KEY_BASE64, "base64"),
      format: "der",
      type: "spki",
    });
  }
  return cachedPublicKey;
}

/** 与服务端 canonicalPayload 严格一致，字段顺序不能改动。 */
function canonicalPayload(payload: LicensePayload): string {
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

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** 校验激活码签名、应用标识，以及是否绑定到期望的设备码。 */
export function verifyActivationCode(code: string, expectedDeviceCode?: string): VerifyResult {
  let decoded: { payload?: LicensePayload; signature?: string };
  try {
    decoded = JSON.parse(fromBase64Url(code.trim()).toString("utf8"));
  } catch {
    return { ok: false, reason: "激活码内容无法解析" };
  }

  const payload = decoded.payload;
  if (!payload || typeof decoded.signature !== "string") {
    return { ok: false, reason: "激活码内容不完整" };
  }
  if (payload.appId !== APP_ID) return { ok: false, reason: "激活码不属于本应用" };
  if (payload.v !== 1 || payload.edition !== "full" || typeof payload.licenseId !== "string" ||
      !payload.licenseId || typeof payload.issuedAt !== "string" || !Number.isFinite(Date.parse(payload.issuedAt))) {
    return { ok: false, reason: "激活码许可字段无效" };
  }

  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      null,
      Buffer.from(canonicalPayload(payload), "utf8"),
      getPublicKey(),
      fromBase64Url(decoded.signature),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "激活码签名校验未通过" };

  if (expectedDeviceCode && payload.deviceCode !== expectedDeviceCode) {
    return { ok: false, reason: "该激活码绑定的是其他设备" };
  }
  return { ok: true, payload };
}

export function verifyAccessToken(token: string, deviceCode: string, nonce?: string): AccessClaims {
  if (token.length > 8192) throw new Error("授权凭证过长");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error("授权凭证格式无效");
  const header = JSON.parse(fromBase64Url(parts[0]).toString("utf8"));
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || header.kid !== "daisy-1") throw new Error("授权凭证签名算法无效");
  const signature = fromBase64Url(parts[2]);
  if (signature.length !== 64 || !cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), getPublicKey(), signature)) {
    throw new Error("授权凭证签名校验失败");
  }
  const claims: AccessClaims = JSON.parse(fromBase64Url(parts[1]).toString("utf8"));
  if (claims.v !== 2 || claims.iss !== LICENSE_ISSUER || claims.aud !== LICENSE_APP_ID || claims.sub !== deviceCode ||
      !["trial", "full"].includes(claims.edition) || typeof claims.licenseId !== "string" ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat <= 0 ||
      claims.exp <= claims.iat || claims.exp - claims.iat > LEASE_SECONDS ||
      !/^[a-f0-9]{64}$/.test(claims.nonce) || (nonce !== undefined && claims.nonce !== nonce)) {
    throw new Error("授权凭证绑定或有效期无效");
  }
  if (claims.edition === "trial" && (!Number.isSafeInteger(claims.trialStartedAt) || !Number.isSafeInteger(claims.trialExpiresAt) ||
      claims.trialStartedAt! <= 0 || claims.trialExpiresAt! - claims.trialStartedAt! !== TRIAL_SECONDS ||
      claims.iat < claims.trialStartedAt! || claims.exp > claims.trialExpiresAt!)) throw new Error("试用期限无效");
  if (claims.edition === "full" && (!claims.licenseId || claims.trialStartedAt !== null || claims.trialExpiresAt !== null)) {
    throw new Error("完整许可字段无效");
  }
  return claims;
}
