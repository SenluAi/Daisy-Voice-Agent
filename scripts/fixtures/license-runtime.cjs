const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const base = path.resolve(__dirname, '../../dist/main');
const load = file => require(path.join(base, file));
app.setPath('userData', process.env.DAISY_TEST_USER_DATA);
app.setName('Daisy License Test');
const guard = load('license/access');
const channels = load('ipc/channels').IPC_CHANNELS;
let notify;
let status = { allowed: true, accessState: 'trial', activated: false,
  deviceCode: 'DSY1-' + Array(8).fill('ABCDE').join('-'), remainingTrialMs: 86400000,
  trialStartedAt: Date.now() - 6 * 86400000, trialExpiresAt: Date.now() + 86400000,
  leaseExpiresAt: Date.now() + 86400000, accessMessage: '七天试用中', filePath: '' };
const stats = { recording: false, recordingStopped: 0, shortcuts: 0, shortcutDestroyed: 0,
  wakeActive: false, wakeStopped: 0, pluginsActive: false, pluginsClosed: 0, llmStarted: 0, llmAborted: 0, ttsStarted: 0, ttsStopped: 0 };
function publish() {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.LICENSE_CHANGED, status);
  notify?.();
}
Object.assign(load('license'), {
  initializeLicense: async onChange => { notify = onChange; guard.setLicenseAccessCheck(() => status.allowed); publish(); },
  closeLicense: () => {},
  registerLicenseIpc: () => {
    ipcMain.handle(channels.LICENSE_STATUS, () => status);
    ipcMain.handle(channels.LICENSE_REFRESH, () => status);
    ipcMain.handle(channels.LICENSE_ACTIVATE, () => ({ ok: false, message: 'Fixture does not redeem real codes', status }));
  },
});
const env = load('config/env');
env.config.wakeWord.enabled = true;
env.config.autoLaunch = false;
env.config.asr.primaryProvider = 'sherpa';
env.config.llm.apiKey = 'test-not-a-credential';
env.isSherpaOnnxModelReady = () => true;
Object.assign(load('audio/recorder'), {
  initAudioRecorder: () => {}, ensureAudioWindow: () => {}, getAudioWindow: () => null,
  getIsRecording: () => stats.recording,
  startRecording: () => { stats.recording = true; },
  stopRecording: () => { stats.recording = false; stats.recordingStopped++; },
  setWakeWordCaptureEnabled: enabled => { stats.wakeActive = enabled; },
});
load('shortcut/globalShortcut').GlobalShortcut = class extends EventEmitter {
  constructor() { super(); stats.shortcuts++; }
  destroy() { stats.shortcutDestroyed++; this.removeAllListeners(); }
};
load('wakeword/monitor').WakeWordMonitor = class extends EventEmitter {
  start() { stats.wakeActive = true; }
  stop() { stats.wakeActive = false; stats.wakeStopped++; }
  pause() {} resume() {} feedPcm() {} setInterruptOnly() {}
};
load('llm/deepseek').DeepSeekClient = class extends EventEmitter {
  async sendMessage() { stats.llmStarted++; this.emit('tool_ack', '正在处理测试任务'); }
  abort() { stats.llmAborted++; }
};
Object.assign(load('tts/edgeTTS'), {
  synthesizeEdgeTtsFile: async () => {}, startTTSCleanup: () => {}, stopTTSCleanup: () => {},
  EdgeTTSPlayer: class extends EventEmitter {
    speak() { stats.ttsStarted++; this.emit('start'); }
    stop() { stats.ttsStopped++; }
  },
});
Object.assign(load('extensions/manager'), {
  initializeExtensions: () => { stats.pluginsActive = true; },
  closeExtensions: () => { stats.pluginsActive = false; stats.pluginsClosed++; },
  extensionPrompt: () => '', refreshExtensionSpeechProviders: () => {},
});
Object.assign(load('control/finderSelection'), { warmupExplorerSelection: () => {}, getSelectedFinderItems: async () => ({ items: [] }) });
load('command/router').initCommandRouter = () => {};
global.__licenseRuntimeTest = {
  stats,
  expire: () => { status = { ...status, allowed: false, accessState: 'expired', remainingTrialMs: 0, accessMessage: '七天试用已到期，请输入兑换码激活后继续使用' }; publish(); },
  activate: () => { status = { ...status, allowed: true, activated: true, accessState: 'activated', accessMessage: '授权有效' }; publish(); },
};
require(path.join(base, 'index'));
