import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app } from "electron";
import dotenv from "dotenv";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeModelName(value: string | undefined, fallback: string): string {
  const model = value?.trim() || fallback;
  if (model === "deepseek-v4.1-flash-expires-on-0910") return "deepseek-flash";
  return model;
}

function getUserDataEnvPath(): string {
  try {
    return path.join(app.getPath("userData"), "daisy.env");
  } catch {
    return path.join(os.homedir(), ".daisy.env");
  }
}

function findEnvFile(): string | null {
  const userDataEnv = getUserDataEnvPath();
  const candidates = [
    userDataEnv,
    path.join(process.cwd(), "daisy.env"),
    path.join(__dirname, "..", "..", "..", "daisy.env"),
    path.join(__dirname, "..", "..", "daisy.env"),
    path.join(app?.getAppPath?.() || "", "daisy.env"),
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", "..", "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
    path.join(app?.getAppPath?.() || "", ".env"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadEnv(): void {
  const envPath = findEnvFile();
  if (envPath) {
    // The user's persisted Daisy settings must win over inherited process
    // variables. Without override, a stale GLOBAL_SHORTCUT supplied by a
    // parent process can silently replace the value the user just saved.
    dotenv.config({ path: envPath, override: true });
  }
}

loadEnv();

export function getWritableEnvPath(): string {
  const userDataEnv = getUserDataEnvPath();
  if (fs.existsSync(userDataEnv)) return userDataEnv;
  const found = findEnvFile();
  if (found) {
    try {
      fs.accessSync(found, fs.constants.W_OK);
      return found;
    } catch {
      // bundled file is read-only, fall through to userData
    }
  }
  return userDataEnv;
}

export const config = {
  asr: {
    apiKey: process.env.VOLCENGINE_API_KEY || "",
    appId: process.env.VOLCENGINE_APP_ID || "",
    accessToken: process.env.VOLCENGINE_ACCESS_TOKEN || "",
    resourceId: process.env.VOLCENGINE_RESOURCE_ID || "volc.seedasr.sauc.duration",
    wsUrl: process.env.VOLCENGINE_ASR_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    primaryProvider: process.env.ASR_PRIMARY_PROVIDER || (process.platform === "win32" ? "wechat" : "sherpa"),
    localSherpaFirst: process.env.ASR_LOCAL_SHERPA_FIRST !== "false",
    wechatSpeechRmsThreshold: parsePositiveInteger(process.env.WECHAT_SPEECH_RMS_THRESHOLD, 260),
    microphoneSensitivity: Math.min(100, parsePositiveInteger(process.env.MICROPHONE_SENSITIVITY, 35)),
  },
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.AI_TRANSLATION_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: normalizeModelName(process.env.DEEPSEEK_MODEL || process.env.AI_TRANSLATION_MODEL, "deepseek-flash"),
    thinkingEnabled: process.env.DEEPSEEK_THINKING_ENABLED !== "false",
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
  },
  tts: {
    voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.EDGE_TTS_RATE || "+20%",
    pitch: process.env.EDGE_TTS_PITCH || "+0Hz",
    style: process.env.EDGE_TTS_STYLE || "general",
  },
  sherpa: {
    model: process.env.SHERPA_ONNX_MODEL || "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
    numThreads: parsePositiveInteger(process.env.SHERPA_ONNX_NUM_THREADS, 4),
    blockSize: parsePositiveInteger(process.env.SHERPA_ONNX_BLOCK_SIZE, 160),
  },
  shortcut: {
    // Windows uses the 3.0-style physical key poller so the wake shortcut has
    // real DOWN/UP edges: hold to talk and release to send. Default: Space.
    // macOS keeps RightOption hold-to-talk via the native key listener.
    globalShortcut: process.env.GLOBAL_SHORTCUT || (process.platform === "win32" ? "Space" : "RightOption"),
  },
  wakeWord: {
    enabled: process.env.WAKE_WORD_ENABLED !== "false",
    keyword: process.env.WAKE_WORD || "嘿 Daisy, 你好 Daisy",
    startListeningTimeoutMs: parsePositiveInteger(
      process.env.WAKE_START_LISTENING_TIMEOUT_MS,
      90 * 1000,
    ),
  },
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY || "",
  },
  conversation: {
    continuousEnabled: process.env.CONTINUOUS_CONVERSATION_ENABLED !== "false",
    continuousWindowMs: parsePositiveInteger(process.env.CONTINUOUS_CONVERSATION_WINDOW_MS, 90 * 1000),
  },
  autoLaunch: process.env.AUTO_LAUNCH === "true",
  showDockIcon: process.env.SHOW_DOCK_ICON !== "false",
};

export const SHERPA_ONNX_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";

export const SHERPA_ONNX_MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";

export function getSherpaOnnxModelDir(modelName = config.sherpa.model): string {
  const appPath = app?.getAppPath?.() || "";
  const bundled = path.join(appPath, "assets", "models", "sherpa-onnx", modelName);
  if (fs.existsSync(bundled)) {
    if (appPath.includes(".asar")) {
      const unpacked = bundled.replace(".asar", ".asar.unpacked");
      if (fs.existsSync(unpacked)) return unpacked;
    }
    return bundled;
  }
  return path.join(os.homedir(), "Models", "sherpa-onnx", modelName);
}

export function getSherpaOnnxModelFiles(modelName = config.sherpa.model) {
  const modelDir = getSherpaOnnxModelDir(modelName);
  return {
    modelDir,
    encoder: path.join(modelDir, "encoder.int8.onnx"),
    decoder: path.join(modelDir, "decoder.int8.onnx"),
    tokens: path.join(modelDir, "tokens.txt"),
  };
}

export function isSherpaOnnxModelReady(modelName = config.sherpa.model): boolean {
  const files = getSherpaOnnxModelFiles(modelName);
  return fs.existsSync(files.encoder) && fs.existsSync(files.decoder) && fs.existsSync(files.tokens);
}

export function getBundledBin(name: string): string {
  const appPath = app?.getAppPath?.() || "";
  const isWin = process.platform === "win32";
  const bundled = path.join(appPath, "assets", "bin", name);
  const candidates: string[] = [];
  if (appPath.includes(".asar")) candidates.push(bundled.replace(".asar", ".asar.unpacked"));
  candidates.push(bundled);
  // On Windows, the bare name (e.g. "yt-dlp") won't match the .exe file.
  // Add an explicit <name>.exe candidate so callers can keep passing bare names.
  if (isWin && !name.toLowerCase().endsWith(".exe")) {
    const withExe = path.join(appPath, "assets", "bin", name + ".exe");
    if (appPath.includes(".asar")) candidates.push(withExe.replace(".asar", ".asar.unpacked"));
    candidates.push(withExe);
  }
  if (!isWin) {
    candidates.push("/opt/homebrew/bin/" + name);
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return name; // fallback to PATH
}

export function isLlmConfigured(): boolean {
  return Boolean(config.llm.apiKey);
}
