import path from "node:path";
import { BrowserWindow, screen } from "electron";

let historyWindow: BrowserWindow | null = null;

export function createHistoryWindow(): BrowserWindow {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return historyWindow;
  }

  const { x: screenX, y: screenY, width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workArea;
  const targetW = 560;
  const targetH = 680;
  const x = screenX + Math.round((screenWidth - targetW) / 2);
  const y = screenY + Math.round((screenHeight - targetH) / 2);

  historyWindow = new BrowserWindow({
    width: targetW,
    height: targetH,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  historyWindow.loadFile(path.join(__dirname, "../../renderer-settings/settings.html"), {
    query: { mode: "history" },
  });
  historyWindow.once("ready-to-show", () => {
    historyWindow?.show();
    historyWindow?.focus();
  });
  historyWindow.on("closed", () => {
    historyWindow = null;
  });

  return historyWindow;
}

export function getHistoryWindow(): BrowserWindow | null {
  return historyWindow;
}
