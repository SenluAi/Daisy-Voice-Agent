const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const root = process.env.DAISY_EXTENSION_TEST_ROOT;
const buildRoot = process.env.DAISY_EXTENSION_BUILD_ROOT || path.resolve(__dirname, "..");
if (!root) throw new Error("This fixture must be launched by test-extension-ui.cjs");
app.setName("DaisyExtensionUiTest");
app.setPath("userData", root);
app.setPath("sessionData", path.join(root, "session"));
app.disableHardwareAcceleration();
if (process.env.DAISY_EXTENSION_BUILD_ROOT) Object.defineProperty(app, "isPackaged", { value: true });
let manager;
let settingsWindow;
app.whenReady().then(async () => {
  const { initializeExtensions, getExtensionManager } = require(path.join(buildRoot, "dist/main/extensions/manager"));
  const { IPC_CHANNELS: channels } = require(path.join(buildRoot, "dist/main/ipc/channels"));
  initializeExtensions(root);
  manager = getExtensionManager();
  global.extensionTestManager = manager;
  global.extensionTestRequire = require;
  await manager.start();
  ipcMain.handle(channels.EXTENSIONS_REQUEST, (event, action, input) => {
    if (!settingsWindow || event.sender.id !== settingsWindow.webContents.id || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Extension requests must originate from the settings main frame");
    }
    return manager.request(action, input);
  });
  ipcMain.handle(channels.GET_CONFIG, () => ({}));
  global.settingsTestSaves = 0;
  ipcMain.handle(channels.UPDATE_CONFIG, () => {
    if (process.env.DAISY_SETTINGS_FOOTER_TEST) { global.settingsTestSaves++; return true; }
    throw new Error("Tests must not change voice configuration");
  });
  ipcMain.handle(channels.AUTOLAUNCH_GET, () => false);
  ipcMain.handle(channels.APP_VERSION, () => require(path.join(buildRoot, "package.json")).version);
  ipcMain.handle(channels.SHERPA_STATUS, () => ({ installed: false, modelReady: false, wechatInstalled: false }));
  ipcMain.handle(channels.HISTORY_GET, () => []);
  ipcMain.handle(channels.TASK_ACTIVITY_GET, () => {
    if (global.settingsTestTaskFailure) throw new Error("Fixture task activity failure");
    return { updatedAt: Date.now(), tasks: [], files: [], applications: [], pages: [], preferences: [], logs: [] };
  });
  ipcMain.handle(channels.LONG_TERM_MEMORY_GET, () => ({ retentionDays: 30, entries: [], counts: { profile: 0, preference: 0, task: 0 } }));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(root, "external-plugin")] });
  const window = new BrowserWindow({ width: 1000, height: 750, show: true,
    webPreferences: { preload: path.join(buildRoot, "dist/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  settingsWindow = window;
  window.loadFile(path.join(buildRoot, "dist/renderer-settings/settings.html"));
});
app.on("before-quit", () => manager?.close());
app.on("window-all-closed", () => app.quit());
