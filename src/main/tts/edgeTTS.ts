import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomUUID } from "node:crypto";
import { EdgeTTS } from "node-edge-tts";
import { config } from "../config/env";
import { log } from "../utils/logger";

const TTS_DIR = path.join(os.tmpdir(), "diri-tts");
const TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS = 3 * 60;
const MIN_AUDIO_FILE_BYTES = 1024;

type TranslatorEndpoint = {
  r: string;
  t: string;
};

let translatorEndpointCache: {
  endpoint: TranslatorEndpoint | null;
  expiresAt: number;
} = {
  endpoint: null,
  expiresAt: 0,
};

function normalizeTtsStyle(style: string | undefined): string {
  return (style || "general").trim() || "general";
}

function shouldUseStyledTts(): boolean {
  return normalizeTtsStyle(config.tts.style) !== "general";
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      case "'": return "&apos;";
      default: return char;
    }
  });
}

function base64UrlToJson<T>(value: string): T {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as T;
}

function formatTranslatorDate(): string {
  return new Date().toUTCString().replace(/GMT/, "").trim().toLowerCase() + " gmt";
}

function signTranslatorEndpointUrl(url: string): string {
  const urlWithoutScheme = url.split("://")[1] || url;
  const encodedUrl = encodeURIComponent(urlWithoutScheme);
  const uuid = randomUUID().replace(/-/g, "");
  const date = formatTranslatorDate();
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${date}${uuid}`.toLowerCase();
  const key = Buffer.from("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==", "base64");
  const signature = createHmac("sha256", key).update(bytesToSign).digest("base64");
  return `MSTranslatorAndroidApp::${signature}::${date}::${uuid}`;
}

async function getTranslatorEndpoint(): Promise<TranslatorEndpoint> {
  const nowSeconds = Date.now() / 1000;
  if (
    translatorEndpointCache.endpoint &&
    translatorEndpointCache.expiresAt > nowSeconds + TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS
  ) {
    return translatorEndpointCache.endpoint;
  }

  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Accept-Language": "zh-Hans",
      "X-ClientVersion": "4.0.530a 5fe1dc6c",
      "X-UserId": "0f04d16a175c411e",
      "X-HomeGeographicRegion": "zh-Hans-CN",
      "X-ClientTraceId": randomUUID().replace(/-/g, ""),
      "X-MT-Signature": signTranslatorEndpointUrl(endpointUrl),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": "0",
      "Accept-Encoding": "gzip",
    },
  });

  if (!response.ok) {
    throw new Error(`获取 Edge TTS 风格 endpoint 失败: HTTP ${response.status}`);
  }

  const endpoint = await response.json() as TranslatorEndpoint;
  const tokenPayload = base64UrlToJson<{ exp?: number }>(endpoint.t.split(".")[1] || "");
  translatorEndpointCache = {
    endpoint,
    expiresAt: tokenPayload.exp || 0,
  };
  return endpoint;
}

function buildStyledSsml(text: string): string {
  const style = normalizeTtsStyle(config.tts.style);
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
    <voice name="${escapeXml(config.tts.voice)}">
      <mstts:express-as style="${escapeXml(style)}" styledegree="2.0" role="default">
        <prosody rate="${escapeXml(config.tts.rate)}" pitch="${escapeXml(config.tts.pitch)}" volume="default">${escapeXml(text)}</prosody>
      </mstts:express-as>
    </voice>
  </speak>`;
}

async function synthesizeStyledTts(text: string, filePath: string): Promise<void> {
  const endpoint = await getTranslatorEndpoint();
  const response = await fetch(`https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Authorization": endpoint.t,
      "Content-Type": "application/ssml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
    },
    body: buildStyledSsml(text),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Edge TTS 风格合成失败: HTTP ${response.status} ${errorText}`.trim());
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (audioBuffer.length < MIN_AUDIO_FILE_BYTES) {
    throw new Error(`Edge TTS 风格合成返回空音频: ${audioBuffer.length} bytes`);
  }
  await fs.promises.writeFile(filePath, audioBuffer);
}

export async function synthesizeEdgeTtsFile(text: string, filePath: string): Promise<"styled" | "general"> {
  if (shouldUseStyledTts()) {
    try {
      log(`[TTS_PERF] Styled Edge TTS Request Start (${normalizeTtsStyle(config.tts.style)})`);
      await synthesizeStyledTts(text, filePath);
      log(`[TTS_PERF] Styled Edge TTS File Saved: ${filePath}`);
      return "styled";
    } catch (error) {
      log(`Styled Edge TTS failed, falling back to general voice: ${error instanceof Error ? error.message : String(error)}`);
      fs.promises.unlink(filePath).catch(() => {});
    }
  }

  const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate, pitch: config.tts.pitch });
  await tts.ttsPromise(text, filePath);
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (size < MIN_AUDIO_FILE_BYTES) {
    throw new Error(`Edge TTS 返回空音频: ${size} bytes`);
  }
  return "general";
}

// Clean old files on startup (in case of crash)
export function startTTSCleanup(): void {
  try {
    if (fs.existsSync(TTS_DIR)) {
      let deleted = 0;
      for (const file of fs.readdirSync(TTS_DIR)) {
        if (file.startsWith("diri-tts-") && file.endsWith(".mp3")) {
          fs.unlinkSync(path.join(TTS_DIR, file));
          deleted++;
        }
      }
      if (deleted > 0) log(`TTS startup cleanup: deleted ${deleted} leftover files`);
    }
  } catch {
    // ignore
  }
}

export function stopTTSCleanup(): void {}

export function unmarkPlaying(_filePath: string): void {}

export class EdgeTTSPlayer extends EventEmitter {
  private cancelled = false;

  async speak(text: string): Promise<void> {
    if (!text.trim()) {
      this.emit("end");
      return;
    }

    this.emit("start");

    if (!fs.existsSync(TTS_DIR)) {
      fs.mkdirSync(TTS_DIR, { recursive: true });
    }

    const fileName = `diri-tts-${Date.now()}.mp3`;
    const filePath = path.join(TTS_DIR, fileName);

    try {
      let retries = 3;
      let lastError: any = null;
      while (retries > 0) {
        try {
          log(`[TTS_PERF] TTS Request Start (speak) for text: "${text.slice(0, 30)}..."`);
          const mode = await synthesizeEdgeTtsFile(text, filePath);
          log(`[TTS_PERF] TTS Response & File Saved (speak): ${filePath}`);
          log(`[TTS_PERF] TTS mode (speak): ${mode}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            log(`TTS speak failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 500ms (${retries} attempts left)...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      if (lastError) {
        throw lastError;
      }

      if (this.cancelled) {
        fs.promises.unlink(filePath).catch(() => {});
        return;
      }

      this.emit("play", filePath);
    } catch (error) {
      fs.promises.unlink(filePath).catch(() => {});
      if (this.cancelled) return;
      this.emit("error", error instanceof Error ? error.message : String(error));
      this.emit("end");
    }
  }

  async synthesize(text: string): Promise<string | null> {
    if (!text.trim()) return null;

    if (!fs.existsSync(TTS_DIR)) {
      fs.mkdirSync(TTS_DIR, { recursive: true });
    }

    const fileName = `diri-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const filePath = path.join(TTS_DIR, fileName);

    try {
      let retries = 3;
      let lastError: any = null;
      while (retries > 0) {
        try {
          log(`[TTS_PERF] TTS Request Start (synthesize) for text: "${text.slice(0, 30)}..."`);
          const mode = await synthesizeEdgeTtsFile(text, filePath);
          log(`[TTS_PERF] TTS Response & File Saved (synthesize): ${filePath}`);
          log(`[TTS_PERF] TTS mode (synthesize): ${mode}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 500ms (${retries} attempts left)...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      if (lastError) {
        throw lastError;
      }
      return filePath;
    } catch (error) {
      fs.promises.unlink(filePath).catch(() => {});
      log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  stop(): void {
    this.cancelled = true;
  }
}
