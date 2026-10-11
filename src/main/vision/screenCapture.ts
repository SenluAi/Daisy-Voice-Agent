import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, screen } from "electron";
import { log } from "../utils/logger";

export interface ScreenCaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  geometry?: string;
  capturedAt?: number;
}

// Bind saved observations to the display layout that produced them; bounded to one task's recent frames.
const savedObservations = new Map<string, { geometry?: string; capturedAt: number }>();

export function getSavedObservation(filePath: string): { geometry?: string; capturedAt: number } | undefined {
  return savedObservations.get(filePath);
}

function displayGeometry(): string {
  const display = screen.getPrimaryDisplay();
  return JSON.stringify({ id: display.id, bounds: display.bounds, scale: display.scaleFactor, rotation: display.rotation });
}

const MAX_CAPTURE_WIDTH = 1800;
const HIDE_OVERLAY_DELAY_MS = 180;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVisibleWindows(windows: Array<BrowserWindow | null>): BrowserWindow[] {
  return windows.filter((win): win is BrowserWindow => (
    Boolean(win) && !win!.isDestroyed() && win!.isVisible()
  ));
}

export async function capturePrimaryScreenDataUrl(
  windowsToHide: Array<BrowserWindow | null> = [],
  maxWidth = MAX_CAPTURE_WIDTH,
): Promise<ScreenCaptureResult> {
  const hiddenWindows = getVisibleWindows(windowsToHide);

  for (const win of hiddenWindows) {
    win.hide();
  }
  if (hiddenWindows.length > 0) {
    await wait(HIDE_OVERLAY_DELAY_MS);
  }

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const geometry = displayGeometry();
    const scaleFactor = primaryDisplay.scaleFactor || 1;
    const thumbnailSize = {
      width: Math.round(primaryDisplay.size.width * scaleFactor),
      height: Math.round(primaryDisplay.size.height * scaleFactor),
    };

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
    });
    const source = sources.find((item) => item.display_id === String(primaryDisplay.id))
      || (screen.getAllDisplays().length === 1 && sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("没有获取到屏幕截图");
    }

    let image = source.thumbnail;
    const originalSize = image.getSize();
    if (originalSize.width > maxWidth) {
      image = image.resize({
        width: maxWidth,
        height: Math.round(originalSize.height * (maxWidth / originalSize.width)),
      });
    }

    const size = image.getSize();
    const png = image.toPNG();
    if (geometry !== displayGeometry()) throw new Error("截图期间屏幕布局已改变，请重新观察");
    log(`ScreenVision: captured primary screen ${size.width}x${size.height}, ${png.length} bytes`);

    return {
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      width: size.width,
      height: size.height,
      geometry,
      capturedAt: Date.now(),
    };
  } finally {
    for (const win of hiddenWindows) {
      if (!win.isDestroyed()) {
        win.showInactive();
      }
    }
  }
}

export async function savePrimaryScreenSnapshot(
  windowsToHide: Array<BrowserWindow | null> = [],
  purpose = "observe",
): Promise<{ path: string; width: number; height: number }> {
  const capture = await capturePrimaryScreenDataUrl(windowsToHide);
  return saveScreenCapture(capture, purpose);
}

export async function saveScreenCapture(
  capture: ScreenCaptureResult,
  purpose = "observe",
): Promise<{ path: string; width: number; height: number }> {
  const directory = path.join(app.getPath("userData"), "screen-observations");
  await fs.promises.mkdir(directory, { recursive: true });
  const safePurpose = purpose.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "observe";
  const filePath = path.join(directory, `${Date.now()}-${safePurpose}.png`);
  const base64 = capture.dataUrl.replace(/^data:image\/png;base64,/, "");
  await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));
  savedObservations.set(filePath, { geometry: capture.geometry, capturedAt: capture.capturedAt ?? Date.now() });
  if (savedObservations.size > 64) savedObservations.delete(savedObservations.keys().next().value!);
  return { path: filePath, width: capture.width, height: capture.height };
}
