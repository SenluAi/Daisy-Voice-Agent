import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";
import { officeDocument } from "../control/officecli";
import { log, logError } from "../utils/logger";

export interface DroppedFilePrompt {
  prompt: string;
  historyText: string;
  imageDataUrl?: string;
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".csv", ".tsv",
  ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".htm", ".xml",
  ".yaml", ".yml", ".toml", ".ini", ".env", ".py", ".java", ".c", ".cpp",
  ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".bat", ".cmd",
  ".ps1", ".sh",
]);

const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const MAX_FILES = 6;
const MAX_TEXT_CHARS_PER_FILE = 35_000;
const MAX_TOTAL_CONTEXT_CHARS = 70_000;
const MAX_TEXT_BYTES_PER_FILE = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function normalizeDroppedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of paths) {
    const trimmed = item?.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized.slice(0, MAX_FILES);
}

function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le");
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.alloc(buffer.length - 2);
      for (let i = 2; i + 1 < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return swapped.toString("utf16le");
    }
  }
  return buffer.toString("utf8");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) return false;
  let nulCount = 0;
  for (const byte of sample) {
    if (byte === 0) nulCount += 1;
  }
  return nulCount / sample.length > 0.02;
}

function readTextPreview(filePath: string, stat: fs.Stats): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesToRead = Math.min(stat.size, MAX_TEXT_BYTES_PER_FILE);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const data = buffer.subarray(0, bytesRead);
    if (looksBinary(data)) {
      return "该文件看起来是二进制内容，未按文本直接读取。";
    }
    let text = decodeTextBuffer(data).replace(/\u0000/g, "").trim();
    if (text.length > MAX_TEXT_CHARS_PER_FILE) {
      text = `${text.slice(0, MAX_TEXT_CHARS_PER_FILE)}\n...（单个文件内容过长，已截断）`;
    }
    if (stat.size > bytesToRead) {
      text += "\n...（文件较大，仅读取开头部分）";
    }
    return text || "文件为空或未读取到可见文本。";
  } finally {
    fs.closeSync(fd);
  }
}

async function readOfficeSummary(filePath: string): Promise<string> {
  return await officeDocument(filePath, "query", {
    query: "请提取这个文档的主要内容、标题、关键数字、表格重点和结论，输出可用于后续总结的中文要点。",
  });
}

async function capturePdfFirstPage(filePath: string): Promise<string | null> {
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadURL(pathToFileURL(filePath).toString());
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return null;
    const png = image.resize({ width: 1200 }).toPNG();
    log(`FileDrop: captured PDF first page preview ${png.length} bytes`);
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (error) {
    logError("FileDrop PDF preview failed", error);
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function imageFileToDataUrl(filePath: string, stat: fs.Stats): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXTENSION[ext];
  if (!mime || stat.size > MAX_IMAGE_BYTES) return null;
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

async function extractOne(filePath: string): Promise<{ text: string; imageDataUrl?: string }> {
  if (!fs.existsSync(filePath)) {
    return { text: `找不到文件：${filePath}` };
  }

  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(filePath, { withFileTypes: true }).slice(0, 80);
    const lines = entries.map((entry) => `${entry.isDirectory() ? "[目录]" : "[文件]"} ${entry.name}`);
    return {
      text: `拖入的是文件夹：${name}\n路径：${filePath}\n包含：\n${lines.join("\n") || "空文件夹"}`,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const header = `文件名：${name}\n路径：${filePath}\n大小：${stat.size} 字节`;

  if (TEXT_EXTENSIONS.has(ext)) {
    return { text: `${header}\n\n${readTextPreview(filePath, stat)}` };
  }

  if (OFFICE_EXTENSIONS.has(ext)) {
    try {
      return { text: `${header}\n\n${await readOfficeSummary(filePath)}` };
    } catch (error) {
      return {
        text: `${header}\n\nOffice 文档读取失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const imageDataUrl = imageFileToDataUrl(filePath, stat);
  if (imageDataUrl) {
    return {
      text: `${header}\n\n这是用户拖入的图片文件，请结合图片内容进行说明。`,
      imageDataUrl,
    };
  }

  if (ext === ".pdf") {
    const pdfPreview = await capturePdfFirstPage(filePath);
    if (pdfPreview) {
      return {
        text: `${header}\n\n这是用户拖入的 PDF 文件。当前已截取第一页预览图，请结合页面内容总结；如果需要完整多页内容，请提示用户后续指定页码或转换为文本。`,
        imageDataUrl: pdfPreview,
      };
    }
  }

  if (stat.size <= 64 * 1024) {
    return { text: `${header}\n\n${readTextPreview(filePath, stat)}` };
  }

  return {
    text: `${header}\n\n暂时无法自动抽取此格式的正文内容。支持直接读取文本/代码/CSV/JSON/Markdown/日志、Word/Excel/PPTX，以及图片和 PDF 首页预览。`,
  };
}

export async function buildDroppedFilePrompt(paths: string[]): Promise<DroppedFilePrompt> {
  const droppedPaths = normalizeDroppedPaths(paths);
  if (droppedPaths.length === 0) {
    throw new Error("没有获取到拖入文件的本地路径");
  }

  const parts: string[] = [];
  let totalChars = 0;
  let imageDataUrl: string | undefined;

  for (const filePath of droppedPaths) {
    const extracted = await extractOne(filePath);
    let text = extracted.text;
    if (totalChars + text.length > MAX_TOTAL_CONTEXT_CHARS) {
      const remaining = Math.max(0, MAX_TOTAL_CONTEXT_CHARS - totalChars);
      text = `${text.slice(0, remaining)}\n...（拖入内容总量过长，后续内容已截断）`;
    }
    if (text.trim()) {
      parts.push(text);
      totalChars += text.length;
    }
    if (!imageDataUrl && extracted.imageDataUrl) {
      imageDataUrl = extracted.imageDataUrl;
    }
    if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
  }

  const names = droppedPaths.map((item) => path.basename(item)).join("、");
  const prompt = [
    "用户把文件拖到了 Daisy 悬浮球上。请读取下面提取到的文件内容，并用中文给出有用摘要。",
    "要求：先说明文件大意，再列出关键点；如果内容是代码/配置/报错日志，要指出作用、风险或明显问题；默认简洁，不超过 6 条要点。",
    imageDataUrl ? "本次消息还附带了一张用户拖入文件的图片或 PDF 页面预览，请结合图片内容回答。" : "",
    "",
    "【拖入文件内容】",
    parts.join("\n\n---\n\n"),
  ].filter(Boolean).join("\n");

  return {
    prompt,
    historyText: `已拖入文件：${names}`,
    imageDataUrl,
  };
}
