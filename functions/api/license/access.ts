import { LICENSE_APP_ID, LICENSE_ISSUER, TRIAL_SECONDS, LEASE_SECONDS, type AccessClaims } from "../../../src/shared/license";
import { issueAccessToken, verifyActivationCode, normalizeDeviceCode, type LicenseEnv } from "./_shared/license";
import { getOrCreateTrial, isLicenseActive, type LedgerEnv } from "./_shared/ledger";

interface Context { request: Request; env: LicenseEnv & LedgerEnv }
function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}

export async function onRequest({ request, env }: Context): Promise<Response> {
  if (request.method !== "POST") return json(405, { message: "仅支持 POST 请求" });
  let body: { deviceCode?: unknown; nonce?: unknown; activationCode?: unknown };
  try {
    const text = await request.text();
    if (text.length > 12000) return json(413, { message: "请求过长" });
    body = JSON.parse(text);
    if (!body || typeof body.deviceCode !== "string" || typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce) ||
        (body.activationCode !== undefined && typeof body.activationCode !== "string")) throw new Error();
    body.deviceCode = normalizeDeviceCode(body.deviceCode);
  } catch { return json(400, { message: "授权请求格式无效" }); }

  const now = Math.floor(Date.now() / 1000);
  let claims: AccessClaims = {
    v: 2, iss: LICENSE_ISSUER, aud: LICENSE_APP_ID, sub: body.deviceCode as string,
    edition: "trial", licenseId: "", iat: now, exp: now + LEASE_SECONDS,
    trialStartedAt: null, trialExpiresAt: null, nonce: body.nonce as string,
  };
  try {
    if (body.activationCode) {
      let payload;
      try { payload = await verifyActivationCode(body.activationCode as string, claims.sub); }
      catch { return json(403, { reason: "INVALID_LICENSE", message: "激活码校验失败，请重新激活" }); }
      if (!await isLicenseActive(env, payload)) return json(403, { reason: "LICENSE_REVOKED", message: "该许可已停用或未登记，请联系作者" });
      claims = { ...claims, edition: "full", licenseId: payload.licenseId };
    } else {
      const record = await getOrCreateTrial(env, claims.sub, now);
      const expiresAt = record.startedAt + TRIAL_SECONDS;
      if (now >= expiresAt) return json(403, { reason: "TRIAL_EXPIRED", message: "七天试用已到期，请输入兑换码激活后继续使用",
        trialStartedAt: record.startedAt * 1000, trialExpiresAt: expiresAt * 1000 });
      claims = { ...claims, trialStartedAt: record.startedAt, trialExpiresAt: expiresAt, exp: Math.min(claims.exp, expiresAt) };
    }
    return json(200, { accessToken: await issueAccessToken(env, claims) });
  } catch {
    return json(503, { message: "授权服务暂时不可用，请稍后重试" });
  }
}
