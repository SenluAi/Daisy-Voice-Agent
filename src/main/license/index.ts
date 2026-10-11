// 授权激活：把一次性兑换码换成绑定本机的激活码，并离线校验、保存到本机。
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, BrowserWindow, safeStorage } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { getDeviceCode, normalizeDeviceCode } from "./device";
import { verifyActivationCode, verifyAccessToken, type LicensePayload } from "./verify";
import { LicenseLease } from "./lease";
import { setLicenseAccessCheck } from "./access";
import type { LicenseAccessStatus } from "../../shared/license";

/** 兑换接口地址，可用环境变量指向测试环境。 */
const DEFAULT_REDEEM_ENDPOINT = "https://daisy-voice.pages.dev/api/license/redeem";
const REQUEST_TIMEOUT_MS = 20000;

export interface LicenseStatus extends LicenseAccessStatus {
  activated: boolean;
  deviceCode: string;
  licenseId?: string;
  customer?: string;
  issuedAt?: string;
  edition?: "full";
  problem?: string;
  filePath: string;
}

let lease: LicenseLease | undefined;
let currentActivation: { code: string; licenseId: string } | null = null;
let onStatusChange: (() => void) | undefined;
const INITIAL_ACCESS: LicenseAccessStatus = { allowed: false, accessState: "checking", remainingTrialMs: 0, accessMessage: "正在联网核验授权" };

function accessStatus(): LicenseAccessStatus { return lease?.snapshot() ?? INITIAL_ACCESS; }
function publishStatus(): void {
  const status = getLicenseStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.LICENSE_CHANGED, status);
  }
  onStatusChange?.();
}

export async function initializeLicense(onChange: () => void): Promise<void> {
  onStatusChange = onChange;
  const stored = readStored();
  const verified = stored ? verifyActivationCode(stored.activationCode, getDeviceCode()) : null;
  currentActivation = stored && verified?.ok ? { code: stored.activationCode, licenseId: verified.payload.licenseId } : null;
  lease = new LicenseLease({
    filePath: path.join(app.getPath("userData"), "license-lease.bin"),
    endpoint: new URL("access", redeemEndpoint()).href,
    deviceCode: getDeviceCode(),
    activation: () => currentActivation,
    verify: verifyAccessToken,
    encrypt: text => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage unavailable");
      return safeStorage.encryptString(text);
    },
    decrypt: data => safeStorage.decryptString(data),
    onChange: publishStatus,
  });
  setLicenseAccessCheck(() => accessStatus().allowed);
  await lease.start();
}

export function closeLicense(): void { lease?.close(); }
export async function refreshLicense(): Promise<LicenseStatus> { await lease?.refresh(); return getLicenseStatus(); }

export interface ActivateResult {
  ok: boolean;
  message: string;
  status: LicenseStatus;
}

interface StoredLicense {
  activationCode: string;
  licenseId: string;
  customer?: string;
  issuedAt: string;
  deviceCode: string;
  activatedAt: number;
}

function licenseFilePath(): string {
  return path.join(app.getPath("userData"), "license.json");
}

function redeemEndpoint(): string {
  const override = process.env.DAISY_LICENSE_REDEEM_ENDPOINT?.trim();
  return override && /^https?:\/\//.test(override) ? override : DEFAULT_REDEEM_ENDPOINT;
}

function readStored(): StoredLicense | null {
  try {
    const raw = fs.readFileSync(licenseFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredLicense;
    return typeof parsed?.activationCode === "string" && parsed.activationCode.trim()
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredLicense): void {
  const filePath = licenseFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clearStored(): void {
  try {
    fs.rmSync(licenseFilePath(), { force: true });
  } catch {
    // 文件本就不存在时忽略
  }
}

function statusFromPayload(payload: LicensePayload, filePath: string): LicenseStatus {
  return {
    ...accessStatus(),
    activated: true,
    deviceCode: payload.deviceCode,
    licenseId: payload.licenseId,
    customer: payload.customer || "",
    issuedAt: payload.issuedAt,
    edition: payload.edition,
    filePath,
  };
}

/** 读取当前激活状态：每次都重新离线验签，并确认激活码绑定的是本机。 */
export function getLicenseStatus(): LicenseStatus {
  const deviceCode = getDeviceCode();
  const filePath = licenseFilePath();
  const stored = readStored();
  if (!stored) {
    return { ...accessStatus(), activated: false, deviceCode, filePath };
  }
  const result = verifyActivationCode(stored.activationCode, deviceCode);
  if (!result.ok) {
    return { ...accessStatus(), activated: false, deviceCode, problem: result.reason, filePath };
  }
  return statusFromPayload(result.payload, filePath);
}

function normalizeRedeemCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const matched = compact.match(/^DAISY-?RDM1([0-9A-F]{30})$/);
  if (!matched) return null;
  return `DAISY-RDM1-${matched[1].match(/.{1,5}/g)!.join("-")}`;
}

interface RedeemResponse {
  activationCode?: unknown;
  message?: unknown;
}

/** 用兑换码激活本机：调用授权服务，验签返回的激活码，然后保存。 */
export async function activateWithRedeemCode(redeemCode: string): Promise<ActivateResult> {
  const deviceCode = getDeviceCode();
  const normalizedCode = normalizeRedeemCode(redeemCode);
  if (!normalizedCode) {
    return {
      ok: false,
      message: "兑换码格式不正确，请核对购买时收到的 DAISY-RDM1-… 兑换码",
      status: getLicenseStatus(),
    };
  }

  let response: Response;
  try {
    response = await fetch(redeemEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeemCode: normalizedCode, deviceCode }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      message: "无法连接授权服务，请检查网络后重试",
      status: getLicenseStatus(),
    };
  }

  let body: RedeemResponse = {};
  try {
    body = (await response.json()) as RedeemResponse;
  } catch {
    body = {};
  }

  if (!response.ok) {
    const serverMessage = typeof body.message === "string" ? body.message.trim() : "";
    const fallback =
      response.status === 409
        ? "该兑换码已绑定其他设备"
        : response.status === 400
          ? "兑换码无效，请核对后重试"
          : "授权服务暂时不可用，请稍后重试";
    return { ok: false, message: serverMessage || fallback, status: getLicenseStatus() };
  }

  const activationCode = typeof body.activationCode === "string" ? body.activationCode.trim() : "";
  if (!activationCode) {
    return {
      ok: false,
      message: "授权服务返回内容异常，请稍后重试",
      status: getLicenseStatus(),
    };
  }

  const verified = verifyActivationCode(activationCode, deviceCode);
  if (!verified.ok) {
    return {
      ok: false,
      message: `激活码校验失败：${verified.reason}`,
      status: getLicenseStatus(),
    };
  }

  writeStored({
    activationCode,
    licenseId: verified.payload.licenseId,
    customer: verified.payload.customer || "",
    issuedAt: verified.payload.issuedAt,
    deviceCode: verified.payload.deviceCode,
    activatedAt: Date.now(),
  });

  currentActivation = { code: activationCode, licenseId: verified.payload.licenseId };
  lease?.invalidate();
  await lease?.refresh();

  const status = getLicenseStatus();
  const customer = status.customer ? `（${status.customer}）` : "";
  return { ok: true, message: `激活成功${customer}`, status };
}

/** 只清除本机保存的激活码；服务端的兑换记录不受影响。 */
export function clearLocalLicense(): LicenseStatus {
  clearStored();
  currentActivation = null;
  lease?.invalidate();
  void lease?.refresh();
  return getLicenseStatus();
}

/** 供设置界面复制粘贴使用的规范化设备码。 */
export function getLicenseDeviceCode(): string {
  return normalizeDeviceCode(getDeviceCode()) ?? getDeviceCode();
}

export function registerLicenseIpc(): void {
  ipcMain.handle(IPC_CHANNELS.LICENSE_STATUS, () => getLicenseStatus());
  ipcMain.handle(IPC_CHANNELS.LICENSE_ACTIVATE, async (_event, code: string) =>
    activateWithRedeemCode(typeof code === "string" ? code : ""),
  );
  ipcMain.handle(IPC_CHANNELS.LICENSE_CLEAR, () => clearLocalLicense());
  ipcMain.handle(IPC_CHANNELS.LICENSE_REFRESH, () => refreshLicense());
}
