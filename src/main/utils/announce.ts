import { BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeEdgeTtsFile } from "../tts/edgeTTS";
import { log, logError } from "./logger";

/**
 * Isolated "speak to the user right now" path for tool-driven announcements
 * (e.g. "正在下载安装 ffmpeg，请稍候"). It synthesizes the text with Edge TTS
 * and plays it in a throwaway hidden BrowserWindow, so it never touches the
 * main TTS queue / session state in index.ts (no isSpeaking flip, no
 * TTS_PLAY_ENDED handling). Fire-and-forget callers may ignore the promise;
 * awaiting it guarantees the announcement finished before continuing.
 */
const ANNOUNCE_DIR = path.join(os.tmpdir(), "diri-announce");

let announceLock: Promise<void> = Promise.resolve();
let announceGeneration = 0;
let activeAnnouncementWindow: BrowserWindow | null = null;

export function announceToUser(text: string): Promise<void> {
  const generation = announceGeneration;
  const run = announceLock.then(() => {
    if (generation !== announceGeneration) return;
    return playAnnouncement(text, generation);
  });
  announceLock = run.catch(() => {});
  return run;
}

export function cancelAnnouncements(): void {
  announceGeneration += 1;
  announceLock = Promise.resolve();
  const win = activeAnnouncementWindow;
  activeAnnouncementWindow = null;
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    // The player may already be closing.
  }
}

async function playAnnouncement(text: string, generation: number): Promise<void> {
  if (!text || !text.trim()) return;
  let filePath = "";
  let htmlPath = "";
  try {
    if (generation !== announceGeneration) return;
    if (!fs.existsSync(ANNOUNCE_DIR)) fs.mkdirSync(ANNOUNCE_DIR, { recursive: true });
    filePath = path.join(ANNOUNCE_DIR, `announce-${Date.now()}.mp3`);
    await synthesizeEdgeTtsFile(text, filePath);
    if (generation !== announceGeneration) return;
    if (!fs.existsSync(filePath)) throw new Error("announcement synthesis produced no file");

    htmlPath = path.join(ANNOUNCE_DIR, `play-${Date.now()}.html`);
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
      `<audio src="${path.basename(filePath)}" autoplay ` +
      `onended="window.close()" onerror="window.close()" oncanplay="this.play()"></audio></body></html>`;
    fs.writeFileSync(htmlPath, html, "utf-8");

    await playInHiddenWindow(htmlPath, generation);
  } catch (err) {
    logError("[announce] failed", err);
  } finally {
    if (filePath) fs.promises.unlink(filePath).catch(() => {});
    if (htmlPath) fs.promises.unlink(htmlPath).catch(() => {});
  }
}

function playInHiddenWindow(htmlPath: string, generation: number): Promise<void> {
  return new Promise((resolve) => {
    let win: BrowserWindow | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      if (activeAnnouncementWindow === win) activeAnnouncementWindow = null;
      resolve();
    };
    try {
      if (generation !== announceGeneration) {
        finish();
        return;
      }
      win = new BrowserWindow({
        width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
        resizable: false, focusable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          autoplayPolicy: "no-user-gesture-required",
        },
      });
      activeAnnouncementWindow = win;
      win.on("closed", finish);
      win.loadFile(htmlPath).catch(() => finish());
      // Hard cap so a stuck player can never block the tool forever.
      setTimeout(finish, 20000);
    } catch (err) {
      logError("[announce] hidden window failed", err);
      finish();
    }
  });
}
