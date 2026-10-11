import fs from "node:fs";
import { nativeImage } from "electron";
import { capturePrimaryScreenDataUrl, saveScreenCapture, getSavedObservation, ScreenCaptureResult } from "../vision/screenCapture";
import { getFloatWindow } from "../windows/floatWindow";
import { getPanelWindow } from "../windows/panelWindow";

const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
const PIXEL_DELTA_THRESHOLD = 24;

export interface ScreenFrame extends ScreenCaptureResult {
  capturedAt: number;
  sample: Buffer;
  bitmap: Buffer;
}

export interface ScreenSettleResult {
  frame: ScreenFrame;
  screenshotPath: string;
  settled: boolean;
  probes: number;
  elapsedMs: number;
  changeRatio: number;
}

export interface ScreenSettleOptions {
  minWaitMs?: number;
  shouldStop?: () => boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFrame(capture: ScreenCaptureResult): ScreenFrame {
  const image = nativeImage.createFromDataURL(capture.dataUrl);
  if (image.isEmpty()) throw new Error("截图解码失败");
  const sample = image.resize({ width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT }).toBitmap();
  return { ...capture, capturedAt: capture.capturedAt ?? Date.now(), sample, bitmap: image.toBitmap() };
}

export function calculateTargetChangeRatio(before: ScreenFrame, after: ScreenFrame, x: number, y: number, radius = 24): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  if (!before.bitmap || !after.bitmap || before.bitmap.length !== before.width * before.height * 4
    || after.bitmap.length !== before.bitmap.length) return 1;
  let changed = 0;
  let pixels = 0;
  // Compare the full-resolution target neighbourhood, using the existing pre-action capture.
  for (let row = Math.max(0, Math.floor(y) - radius); row <= Math.min(before.height - 1, Math.floor(y) + radius); row++) {
    for (let col = Math.max(0, Math.floor(x) - radius); col <= Math.min(before.width - 1, Math.floor(x) + radius); col++) {
      const index = (row * before.width + col) * 4;
      const delta = Math.abs(before.bitmap[index] - after.bitmap[index])
        + Math.abs(before.bitmap[index + 1] - after.bitmap[index + 1])
        + Math.abs(before.bitmap[index + 2] - after.bitmap[index + 2]);
      if (delta >= 72) changed++;
      pixels++;
    }
  }
  return pixels > 0 ? changed / pixels : 1;
}

export function measureCoordinateChange(before: ScreenFrame, after: ScreenFrame, points: readonly number[]) {
  let targetRatio = 0;
  let contextRatio = 0;
  for (let index = 0; index < points.length; index += 2) {
    targetRatio = Math.max(targetRatio, calculateTargetChangeRatio(before, after, points[index], points[index + 1]));
    contextRatio = Math.max(contextRatio, calculateTargetChangeRatio(before, after, points[index], points[index + 1], 96));
  }
  const layoutChanged = before.width !== after.width || before.height !== after.height || before.geometry !== after.geometry;
  // Unrelated animated wallpaper, clocks and background windows do not invalidate a stable target.
  const reason = layoutChanged ? "display_layout_changed"
    : targetRatio > 0.12 ? "target_changed"
      : contextRatio > 0.18 ? "target_context_changed" : null;
  return { globalRatio: calculateScreenChangeRatio(before, after), targetRatio, contextRatio, reason };
}

export function calculateScreenChangeRatio(before: ScreenFrame, after: ScreenFrame): number {
  if (before.sample.length !== after.sample.length || before.sample.length === 0) return 1;
  let changed = 0;
  let pixels = 0;
  for (let index = 0; index + 3 < before.sample.length; index += 4) {
    const delta = Math.abs(before.sample[index] - after.sample[index])
      + Math.abs(before.sample[index + 1] - after.sample[index + 1])
      + Math.abs(before.sample[index + 2] - after.sample[index + 2]);
    if (delta >= PIXEL_DELTA_THRESHOLD) changed += 1;
    pixels += 1;
  }
  return pixels > 0 ? changed / pixels : 1;
}

export async function captureAutomationFrame(): Promise<ScreenFrame> {
  const capture = await capturePrimaryScreenDataUrl([getFloatWindow(), getPanelWindow()]);
  return toFrame(capture);
}

export async function loadAutomationFrame(filePath: string): Promise<ScreenFrame> {
  const source = await fs.promises.readFile(filePath);
  const image = nativeImage.createFromBuffer(source);
  if (image.isEmpty()) throw new Error("截图文件解码失败");
  const size = image.getSize();
  return toFrame({
    ...getSavedObservation(filePath),
    dataUrl: `data:image/png;base64,${source.toString("base64")}`,
    width: size.width,
    height: size.height,
  });
}

export async function waitForScreenStable(
  before: ScreenFrame,
  options: ScreenSettleOptions = {},
): Promise<ScreenSettleResult> {
  const minWaitMs = options.minWaitMs ?? 250;
  const startedAt = Date.now();

  await wait(minWaitMs);
  if (options.shouldStop?.()) throw new Error("任务已取消");
  const current = await captureAutomationFrame();

  const saved = await saveScreenCapture(current, "verify");
  return {
    frame: current,
    screenshotPath: saved.path,
    // A single sample cannot establish stability; the model must inspect loading state.
    settled: false,
    probes: 1,
    elapsedMs: Date.now() - startedAt,
    changeRatio: calculateScreenChangeRatio(before, current),
  };
}
