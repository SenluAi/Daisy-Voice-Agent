// POST /api/license/redeem —— Cloudflare Pages Functions 版本
// 用户输入 DAISY-RDM1-... 兑换码，接口原子绑定当前 DSY1-... 设备码并返回 Ed25519 激活码。
// 不记录兑换码、设备码、激活码或密钥到日志。

import { issueActivationCode, LicenseEnv, LicensePayload, normalizeDeviceCode } from "./_shared/license";
import { claimRedeemCode, LedgerEnv, normalizeRedeemCode } from "./_shared/ledger";

type Env = LicenseEnv & LedgerEnv;

interface FunctionContext {
  request: Request;
  env: Env;
}

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const onRequest = async (context: FunctionContext): Promise<Response> => {
  if (context.request.method !== "POST") return json(405, { message: "仅支持 POST 请求" });
  return redeem(context);
};

export const onRequestPost = async (context: FunctionContext): Promise<Response> => redeem(context);

async function redeem(context: FunctionContext): Promise<Response> {
  let body: { redeemCode?: unknown; deviceCode?: unknown };
  try {
    body = await context.request.json() as { redeemCode?: unknown; deviceCode?: unknown };
  } catch {
    return json(400, { message: "请求格式不正确" });
  }
  if (typeof body.redeemCode !== "string" || typeof body.deviceCode !== "string") {
    return json(400, { message: "兑换码或设备码格式不正确" });
  }
  try {
    normalizeRedeemCode(body.redeemCode);
    normalizeDeviceCode(body.deviceCode);
  } catch {
    // 格式错误的输入属于客户端错误，不应归类为服务不可用。
    return json(400, { message: "兑换码或设备码格式不正确" });
  }

  try {
    const result = await claimRedeemCode(context.env, body.redeemCode, body.deviceCode);
    if (result.kind === "invalid-code") return json(400, { message: "兑换码无效" });
    if (result.kind === "already-claimed-by-another-device") {
      return json(409, { message: "该兑换码已绑定其他设备" });
    }
    return json(200, { activationCode: await issueActivationCode(context.env, result.payload) });
  } catch (error) {
    // 绝不记录任何码或密钥，只记请求标识。
    console.error("Daisy redemption failed", {
      requestId: context.request.headers.get("cf-ray") || "",
      reason: error instanceof Error ? error.message : "unknown",
    });
    return json(503, { message: error instanceof Error ? error.message : "授权服务暂时不可用" });
  }
}

export type { LicensePayload };
