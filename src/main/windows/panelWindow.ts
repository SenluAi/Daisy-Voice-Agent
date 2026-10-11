import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { log } from "../utils/logger";
import {
  configureMacOSOverlay,
  raiseMacOSOverlay,
  setMacOSOverlayVisible,
} from "./macosOverlay";

let panelWindow: BrowserWindow | null = null;
let panelRecycleTimer: NodeJS.Timeout | null = null;
let panelReady = false;
let pendingPanelText: string | null = null;

function cancelPanelRecycle(): void {
  if (panelRecycleTimer) {
    clearTimeout(panelRecycleTimer);
    panelRecycleTimer = null;
  }
}

export function destroyPanelWindow(): void {
  cancelPanelRecycle();
  pendingPanelText = null;
  panelReady = false;
  if (panelWindow && !panelWindow.isDestroyed()) {
    log("[panelWindow] Recycling panelWindow after 30s idle");
    panelWindow.removeAllListeners();
    panelWindow.webContents?.removeAllListeners();
    panelWindow.destroy();
  }
  panelWindow = null;
  setMacOSOverlayVisible("panel", false);
}

function sendPanelStartSpeaking(text: string): void {
  if (!panelWindow || panelWindow.isDestroyed() || panelWindow.webContents.isDestroyed()) {
    pendingPanelText = text;
    return;
  }

  if (!panelReady || panelWindow.webContents.isLoading()) {
    pendingPanelText = text;
    log("[panelWindow] Panel not ready; queued latest speaking text");
    return;
  }

  pendingPanelText = null;
  panelWindow.webContents.send("panel:start-speaking", text);
}

function flushPendingPanelText(): void {
  const text = pendingPanelText;
  if (text === null) return;
  sendPanelStartSpeaking(text);
}

function schedulePanelRecycle(): void {
  cancelPanelRecycle();
  panelRecycleTimer = setTimeout(() => {
    panelRecycleTimer = null;
    destroyPanelWindow();
  }, 30000);
}

/** Keep the answer panel in the active macOS fullscreen Space without focus. */
function preparePanelOverlayForFullScreen(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  if (process.platform === "darwin") {
    panelWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }
  panelWindow.setAlwaysOnTop(true, "screen-saver", 1);
  configureMacOSOverlay(panelWindow);
}

export function createPanelWindow(): BrowserWindow {
  cancelPanelRecycle();
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow;
  }

  const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
  const targetW = 720;
  const targetH = 360;
  const x = screenX + Math.round((screenWidth - targetW) / 2);
  const y = screenY - 20; // Aligns perfectly with floatWindow's y position

  panelWindow = new BrowserWindow({
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
    movable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  panelWindow.loadFile(path.join(__dirname, "../../renderer/panel.html"));
  panelReady = false;
  panelWindow.webContents.once("did-finish-load", () => {
    panelReady = true;
    flushPendingPanelText();
  });
  panelWindow.setAlwaysOnTop(true, "screen-saver", 1);
  configureMacOSOverlay(panelWindow);
  panelWindow.setIgnoreMouseEvents(true, { forward: true });

  panelWindow.on("closed", () => {
    panelWindow = null;
    panelReady = false;
  });

  return panelWindow;
}

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow;
}

export function ensurePanelWindow(): BrowserWindow {
  return createPanelWindow();
}

export function showPanelWindow(text: string): void {
  cancelPanelRecycle();
  if (!panelWindow || panelWindow.isDestroyed()) {
    createPanelWindow();
  }

  if (panelWindow && !panelWindow.isDestroyed()) {
    setMacOSOverlayVisible("panel", true);
    preparePanelOverlayForFullScreen();
    try {
      const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
      const targetW = 720;
      const x = screenX + Math.round((screenWidth - targetW) / 2);
      const y = screenY - 20;
      const currentPos = panelWindow.getPosition();
      if (currentPos[0] !== x || currentPos[1] !== y) {
        panelWindow.setPosition(x, y);
      }
    } catch (err) {
      console.error("Error setting panel window position:", err);
    }
    
    panelWindow.showInactive();
    raiseMacOSOverlay(panelWindow);
    panelWindow.moveTop();
    sendPanelStartSpeaking(text);
    log("Panel window shown");
  }
}

export function hidePanelWindow(): void {
  pendingPanelText = null;
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("panel:hide");
    panelWindow.hide();
    setMacOSOverlayVisible("panel", false);
    log("Panel window hidden");
  }
  schedulePanelRecycle();
}

export function sendToPanelWindow(channel: string, ...args: unknown[]): void {
  try {
    if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.webContents.isDestroyed()) {
      panelWindow.webContents.send(channel, ...args);
    }
  } catch (err) {
    console.error(`Error sending to panel window on channel ${channel}:`, err);
  }
}
