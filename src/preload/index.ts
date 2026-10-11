import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS } from "../main/ipc/channels";
import type { ExtensionRequestAPI } from "../shared/extensions";

export interface TaskActivitySnapshot {
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
}

export interface LongTermMemorySnapshot {
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
}

export interface DiriAPI {
  extensionsRequest: ExtensionRequestAPI;
  // Send commands to main
  startRecording: () => void;
  stopRecording: () => void;
  sendText: (text: string) => void;
  sendDroppedFiles: (paths: string[]) => void;
  getPathForFile: (file: File) => string;
  openSettings: () => void;
  closeSettings: () => void;
  onSettingsNavigate: (callback: (section: "llm" | "tasks") => void) => () => void;
  openHistory: () => void;
  closeHistory: () => void;
  getConfig: () => Promise<Record<string, string>>;
  updateConfig: (cfg: Record<string, string>) => Promise<boolean>;
  quitApp: () => void;

  // Audio window -> main
  sendAudioData: (base64: string, generation?: number) => void;
  sendAudioError: (message: string, generation?: number) => void;
  sendRendererError: (message: string) => void;
  sendRendererLog: (message: string) => void;
  sendTtsPlayEnded: () => void;
  muteCurrentTts: () => void;
  sendAudioReady: (generation?: number) => void;
  sendAudioStopped: (generation?: number) => void;

  // Sherpa-ONNX model management
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
  onSherpaDownloadProgress: (callback: (progress: { percent: number; status: string }) => void) => () => void;

  // Shortcut capture
  captureShortcut: (mode: "single" | "combo") => void;
  cancelShortcutCapture: () => void;
  onShortcutCaptured: (callback: (payload: { keyName: string; cancelled?: boolean }) => void) => () => void;

  // Auto launch
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<void>;

  // Conversation history
  getChatHistory: () => Promise<Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>>;
  clearChatHistory: () => Promise<void>;
  onChatHistoryUpdated: (
    callback: (history: Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>) => void
  ) => () => void;

  getTaskActivity: () => Promise<TaskActivitySnapshot>;
  getLongTermMemory: () => Promise<LongTermMemorySnapshot>;
  deleteLongTermMemories: (ids: string[]) => Promise<number>;

  // App update
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
    callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void
  ) => () => void;

  // Listen to events from main
  onAsrPartial: (callback: (text: string) => void) => () => void;
  onAsrFinal: (callback: (text: string) => void) => () => void;
  onAsrError: (callback: (message: string) => void) => () => void;
  onLlmStream: (callback: (chunk: string) => void) => () => void;
  onLlmDone: (callback: () => void) => () => void;
  onLlmError: (callback: (message: string) => void) => () => void;
  onTtsStart: (callback: () => void) => () => void;
  onTtsPlay: (callback: (filePath: string) => void) => () => void;
  onTtsEnd: (callback: () => void) => () => void;
  onStateUpdate: (callback: (state: string) => void) => () => void;
  onShowWindow: (callback: () => void) => () => void;
  onHideWindow: (callback: () => void) => () => void;
  onPanelStartSpeaking: (callback: (text: string) => void) => () => void;
  onStartRecording: (callback: () => void) => () => void;
  onStopRecording: (callback: () => void) => () => void;
  onWakeWordEnabled: (callback: (enabled: boolean) => void) => () => void;
  onLiveCaptureEnabled: (callback: (enabled: boolean) => void) => () => void;
  onLiveExternalPlayback: (callback: (active: boolean) => void) => () => void;
  sendLiveUserActivity: (active: boolean) => void;
  setIgnoreMouse: (ignore: boolean) => void;
  resizeFloatWindow: (width: number, height: number) => void;
  resizePanelWindow: (width: number, height: number) => void;
  lockPanelOpen: () => void;
}

function createListener<T>(channel: string) {
  return (callback: (value: T) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

let latestSettingsSection: "llm" | "tasks" | null = null;
const settingsSectionListeners = new Set<(section: "llm" | "tasks") => void>();
ipcRenderer.on(IPC_CHANNELS.SETTINGS_NAVIGATE, (_event, section: "llm" | "tasks") => {
  latestSettingsSection = section;
  for (const listener of settingsSectionListeners) listener(section);
});

function onSettingsNavigate(callback: (section: "llm" | "tasks") => void): () => void {
  settingsSectionListeners.add(callback);
  if (latestSettingsSection) queueMicrotask(() => callback(latestSettingsSection!));
  return () => settingsSectionListeners.delete(callback);
}

const api: DiriAPI = {
  extensionsRequest: (action, input) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_REQUEST, action, input),
  startRecording: () => ipcRenderer.send(IPC_CHANNELS.START_RECORDING),
  stopRecording: () => ipcRenderer.send(IPC_CHANNELS.STOP_RECORDING),
  sendText: (text: string) => ipcRenderer.send(IPC_CHANNELS.SEND_TEXT, text),
  sendDroppedFiles: (paths: string[]) => ipcRenderer.send(IPC_CHANNELS.FILES_DROPPED, paths),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openSettings: () => ipcRenderer.send(IPC_CHANNELS.OPEN_SETTINGS),
  closeSettings: () => ipcRenderer.send(IPC_CHANNELS.CLOSE_SETTINGS),
  onSettingsNavigate,
  openHistory: () => ipcRenderer.send(IPC_CHANNELS.OPEN_HISTORY),
  closeHistory: () => ipcRenderer.send(IPC_CHANNELS.CLOSE_HISTORY),
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  updateConfig: (cfg: Record<string, string>) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CONFIG, cfg),
  quitApp: () => ipcRenderer.send(IPC_CHANNELS.QUIT_APP),

  sendAudioData: (base64: string, generation = 0) => ipcRenderer.send(IPC_CHANNELS.AUDIO_DATA, base64, generation),
  sendAudioError: (message: string, generation = 0) => ipcRenderer.send(IPC_CHANNELS.AUDIO_ERROR, message, generation),
  sendRendererError: (message: string) => ipcRenderer.send(IPC_CHANNELS.RENDERER_ERROR, message),
  sendRendererLog: (message: string) => ipcRenderer.send(IPC_CHANNELS.RENDERER_LOG, message),
  sendTtsPlayEnded: () => ipcRenderer.send(IPC_CHANNELS.TTS_PLAY_ENDED),
  muteCurrentTts: () => ipcRenderer.send(IPC_CHANNELS.TTS_MUTE_CURRENT),
  sendAudioReady: (generation = 0) => ipcRenderer.send("audio:ready", generation),
  sendAudioStopped: (generation = 0) => ipcRenderer.send("audio:stopped", generation),

  getSherpaStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SHERPA_STATUS),
  downloadSherpaModel: () => ipcRenderer.send(IPC_CHANNELS.SHERPA_DOWNLOAD),
  onSherpaDownloadProgress: createListener<{ percent: number; status: string }>(IPC_CHANNELS.SHERPA_DOWNLOAD_PROGRESS),

  captureShortcut: (mode: "single" | "combo") => ipcRenderer.send(IPC_CHANNELS.SHORTCUT_CAPTURE, mode),
  cancelShortcutCapture: () => ipcRenderer.send(IPC_CHANNELS.SHORTCUT_CAPTURE_CANCEL),
  onShortcutCaptured: createListener<{ keyName: string; cancelled?: boolean }>(IPC_CHANNELS.SHORTCUT_CAPTURED),

  getAutoLaunch: () => ipcRenderer.invoke(IPC_CHANNELS.AUTOLAUNCH_GET),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.AUTOLAUNCH_SET, enabled),

  getChatHistory: () => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET),
  clearChatHistory: () => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_CLEAR),
  onChatHistoryUpdated: createListener<Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>>(IPC_CHANNELS.HISTORY_UPDATED),
  getTaskActivity: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_ACTIVITY_GET),
  getLongTermMemory: () => ipcRenderer.invoke(IPC_CHANNELS.LONG_TERM_MEMORY_GET),
  deleteLongTermMemories: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.LONG_TERM_MEMORY_DELETE, ids),

  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),
  checkForUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.send(IPC_CHANNELS.UPDATE_INSTALL),
  onUpdateDownloadProgress: createListener<{ percent: number; bytesPerSecond: number; transferred: number; total: number }>(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS),

  onAsrPartial: createListener<string>(IPC_CHANNELS.ASR_PARTIAL),
  onAsrFinal: createListener<string>(IPC_CHANNELS.ASR_FINAL),
  onAsrError: createListener<string>(IPC_CHANNELS.ASR_ERROR),
  onLlmStream: createListener<string>(IPC_CHANNELS.LLM_STREAM),
  onLlmDone: createListener(IPC_CHANNELS.LLM_DONE),
  onLlmError: createListener<string>(IPC_CHANNELS.LLM_ERROR),
  onTtsStart: createListener(IPC_CHANNELS.TTS_START),
  onTtsPlay: createListener<string>(IPC_CHANNELS.TTS_PLAY),
  onTtsEnd: createListener(IPC_CHANNELS.TTS_END),
  onStateUpdate: createListener<string>(IPC_CHANNELS.STATE_UPDATE),
  onShowWindow: createListener(IPC_CHANNELS.SHOW_WINDOW),
  onHideWindow: createListener(IPC_CHANNELS.HIDE_WINDOW),
  onPanelStartSpeaking: createListener<string>("panel:start-speaking"),
  onStartRecording: createListener(IPC_CHANNELS.START_RECORDING),
  onStopRecording: createListener(IPC_CHANNELS.STOP_RECORDING),
  onWakeWordEnabled: createListener<boolean>(IPC_CHANNELS.AUDIO_WAKE_WORD_ENABLED),
  onLiveCaptureEnabled: createListener<boolean>("audio:live-capture-enabled"),
  onLiveExternalPlayback: createListener<boolean>("audio:live-external-playback"),
  sendLiveUserActivity: (active: boolean) => ipcRenderer.send("audio:live-user-activity", active),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send("window:set-ignore-mouse", ignore),
  resizeFloatWindow: (width: number, height: number) => ipcRenderer.send("window:resize-float", width, height),
  resizePanelWindow: (width: number, height: number) => ipcRenderer.send("window:resize-panel", width, height),
  lockPanelOpen: () => ipcRenderer.send("window:lock-panel-open"),
};

contextBridge.exposeInMainWorld("diriAPI", api);

// Right-click context menu: ask main process to show native menu,
// because Menu / MenuItem are main-process-only in Electron.
window.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  const target = e.target as HTMLElement;
  const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  const selection = window.getSelection()?.toString() || "";
  ipcRenderer.send("context-menu:show", { isInput, selection });
});
