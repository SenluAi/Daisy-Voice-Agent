// 本机设备码：由系统机器标识推导出的稳定指纹，格式与授权服务端一致：DSY1-XXXXX-...（40 位十六进制）
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

const DEVICE_CODE_PATTERN = /^DSY1(?:-[0-9A-F]{5}){8}$/;

function readRawMachineId(): string {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true },
      );
      const matched = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/);
      if (matched) return matched[1];
    } else if (process.platform === "darwin") {
      const output = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
      });
      const matched = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (matched) return matched[1];
    }
  } catch {
    // 读不到机器标识时退回主机信息，仍然稳定且不采集隐私数据
  }
  return [os.hostname(), os.userInfo().username, os.homedir()].join("|");
}

/** 规范化用户或服务端给出的设备码，格式不合法时返回 null。 */
export function normalizeDeviceCode(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^DSY1[0-9A-F]{40}$/.test(compact)) return null;
  const normalized = `DSY1-${compact.slice(4).match(/.{1,5}/g)!.join("-")}`;
  return DEVICE_CODE_PATTERN.test(normalized) ? normalized : null;
}

let cachedDeviceCode: string | null = null;

/** 本机设备码，同一台机器每次调用结果一致。 */
export function getDeviceCode(): string {
  if (cachedDeviceCode) return cachedDeviceCode;
  const digest = createHash("sha256")
    .update(`daisy-device-v1|${readRawMachineId()}`, "utf8")
    .digest("hex")
    .toUpperCase()
    .slice(0, 40);
  cachedDeviceCode = `DSY1-${digest.match(/.{1,5}/g)!.join("-")}`;
  return cachedDeviceCode;
}
