// diriAPI 类型（跟 preload/index.ts 里的 DiriAPI 对齐）
import type { ExtensionRequestAPI } from "../shared/extensions";
import type { LicenseAccessStatus } from "../shared/license";
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

export interface LicenseActivateResult {
  ok: boolean;
  message: string;
  status: LicenseStatus;
}

export interface DiriAPI {
  extensionsRequest: ExtensionRequestAPI;
  startRecording: () => void;
  stopRecording: () => void;
  sendText: (text: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  onSettingsNavigate: (cb: (section: "llm" | "tasks" | "license") => void) => () => void;
  openHistory: () => void;
  closeHistory: () => void;
  getConfig: () => Promise<Record<string, string>>;
  updateConfig: (cfg: Record<string, string>) => Promise<boolean>;
  quitApp: () => void;

  sendAudioData: (base64: string) => void;
  sendAudioError: (message: string) => void;
  sendRendererError: (message: string) => void;
  sendRendererLog: (message: string) => void;
  sendTtsPlayEnded: () => void;
  muteCurrentTts: () => void;

  getSherpaStatus: () => Promise<{
    installed: boolean;
    modelReady: boolean;
    modelDir: string;
    modelName: string;
    encoderExists: boolean;
    decoderExists: boolean;
    tokensExists: boolean;
    numThreads: number;
    blockSize: number;
    wechatInstalled: boolean;
    url: string;
  }>;
  downloadSherpaModel: () => void;
  onSherpaDownloadProgress: (
    cb: (p: { percent: number; status: string }) => void
  ) => () => void;

  captureShortcut: (mode: "single" | "combo") => void;
  cancelShortcutCapture: () => void;
  onShortcutCaptured: (
    cb: (payload: { keyName: string; cancelled?: boolean }) => void
  ) => () => void;

  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<void>;

  getChatHistory: () => Promise<
    Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>
  >;
  clearChatHistory: () => Promise<void>;
  onChatHistoryUpdated: (
    cb: (history: Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>) => void
  ) => () => void;

  getTaskActivity: () => Promise<{
    updatedAt: number;
    tasks: Array<{
      request: string;
      status: "pending" | "completed" | "blocked";
      result?: string;
      updatedAt: number;
    }>;
    files: string[];
    applications: string[];
    pages: string[];
    preferences: string[];
    logs: string[];
  }>;
  getLongTermMemory: () => Promise<{
    retentionDays: 30;
    entries: Array<{
      id: string;
      category: "profile" | "preference" | "task";
      text: string;
      status: "active";
      createdAt: number;
      updatedAt: number;
    }>;
    counts: Record<"profile" | "preference" | "task", number>;
  }>;
  deleteLongTermMemories: (ids: string[]) => Promise<number>;

  // App update
  licenseStatus: () => Promise<LicenseStatus>;
  licenseActivate: (redeemCode: string) => Promise<LicenseActivateResult>;
  licenseClear: () => Promise<LicenseStatus>;
  licenseRefresh: () => Promise<LicenseStatus>;
  onLicenseChanged: (cb: (status: LicenseStatus) => void) => () => void;

  getAppVersion: () => Promise<string>;
  checkForUpdate: () => Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion?: string;
    releaseNotes?: string;
    error?: string;
  }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => void;
  onUpdateDownloadProgress: (
    cb: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void
  ) => () => void;

  onAsrPartial: (cb: (text: string) => void) => () => void;
  onAsrFinal: (cb: (text: string) => void) => () => void;
  onAsrError: (cb: (message: string) => void) => () => void;
  onLlmStream: (cb: (chunk: string) => void) => () => void;
  onLlmDone: (cb: () => void) => () => void;
  onLlmError: (cb: (message: string) => void) => () => void;
  onTtsStart: (cb: () => void) => () => void;
  onTtsPlay: (cb: (filePath: string) => void) => () => void;
  onTtsEnd: (cb: () => void) => () => void;
  onStateUpdate: (cb: (state: string) => void) => () => void;
  onShowWindow: (cb: () => void) => () => void;
  onHideWindow: (cb: () => void) => () => void;
  onStartRecording: (cb: () => void) => () => void;
  onStopRecording: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    diriAPI: DiriAPI;
  }
}

export {};
