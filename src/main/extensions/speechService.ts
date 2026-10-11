import { app, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { config, getSherpaOnnxModelFiles, isSherpaOnnxModelReady } from "../config/env";
import { MAX_SPEECH_AUDIO_BYTES, MAX_SPEECH_DURATION_SECONDS, resolveSpeechRequest, speechAbortError,
  type SpeechCatalog, type SpeechProvider, type SpeechSpec, type SpeechTranscript } from "./speechContract";

export function speechCatalog(): SpeechCatalog {
  const providers: SpeechProvider[] = [];
  if (isSherpaOnnxModelReady()) {
    providers.push({ id: "sherpa", name: "Sherpa-ONNX Paraformer", location: "local", languages: ["auto", "zh", "en"], preparation: { phase: "ready" } });
  }
  if ((config.asr.apiKey || (config.asr.appId && config.asr.accessToken)) && config.asr.wsUrl) {
    providers.push({ id: "volcengine", name: "火山 ASR", location: "cloud", languages: ["auto", "zh", "en"], preparation: { phase: "ready" } });
  }
  const preferred = config.asr.localSherpaFirst ? "sherpa" : "volcengine";
  return { providers, selection: { providerId: providers.find(x => x.id === preferred)?.id || providers[0]?.id, language: "auto" },
    maxAudioBytes: MAX_SPEECH_AUDIO_BYTES, maxDurationSeconds: MAX_SPEECH_DURATION_SECONDS };
}

interface Job {
  id: number; spec: SpeechSpec; signal?: AbortSignal;
  resolve(value: SpeechTranscript): void; reject(error: Error): void; detach(): void;
}

// Media audio uses a dedicated trusted worker, never the microphone's ASR session.
export class DaisySpeechService {
  private child?: UtilityProcess;
  private active?: Job;
  private pending: Job[] = [];
  private nextId = 0;
  private timer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  transcribe(request: unknown, signal?: AbortSignal): Promise<SpeechTranscript> {
    if (this.closed) return Promise.reject(new Error("Speech service is closed"));
    if (signal?.aborted) return Promise.reject(speechAbortError());
    const spec = resolveSpeechRequest(request, speechCatalog());
    if (this.pending.length >= 8) return Promise.reject(new Error("Speech transcription queue is full"));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, spec, signal, resolve, reject, detach: () => signal?.removeEventListener("abort", cancel) };
      const cancel = () => {
        if (this.active === job) this.finish(undefined, speechAbortError(), true);
        else { this.pending = this.pending.filter(x => x !== job); job.detach(); reject(speechAbortError()); }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(job);
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    for (const job of this.pending.splice(0)) { job.detach(); job.reject(speechAbortError()); }
    this.finish(undefined, speechAbortError(), true);
  }

  private worker(): UtilityProcess {
    if (this.child) return this.child;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(path|systemroot|windir|temp|tmp|userprofile|home|appdata|localappdata)$/i.test(key)) env[key] = value;
    }
    const child = utilityProcess.fork(path.join(__dirname, "speechWorker.js"), [], {
      env, cwd: app.getPath("temp"), execArgv: [], stdio: "ignore", serviceName: "Daisy media speech transcription",
    });
    this.child = child;
    child.on("message", (message: { id: number; result?: SpeechTranscript; error?: string }) => {
      if (this.child !== child || message?.id !== this.active?.id) return;
      this.finish(message.result, message.error ? new Error(message.error) : undefined);
    });
    child.on("exit", () => { if (this.child === child) this.finish(undefined, new Error("Speech transcription process exited"), true); });
    child.on("error", () => { if (this.child === child) this.finish(undefined, new Error("Speech transcription process failed"), true); });
    return child;
  }

  private pump(): void {
    if (this.closed || this.active) return;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const job = this.pending.shift();
    if (!job) {
      this.idleTimer = setTimeout(() => { this.child?.kill(); this.child = undefined; }, 30000);
      this.idleTimer.unref(); return;
    }
    this.active = job;
    this.timer = setTimeout(() => this.finish(undefined, new Error("Speech transcription timed out"), true), 180000);
    try {
      this.worker().postMessage({ id: job.id, spec: job.spec, model: getSherpaOnnxModelFiles(),
        numThreads: Math.min(2, config.sherpa.numThreads), asr: {
          apiKey: config.asr.apiKey, appId: config.asr.appId, accessToken: config.asr.accessToken,
          resourceId: config.asr.resourceId, wsUrl: config.asr.wsUrl,
        } });
    } catch { this.finish(undefined, new Error("Cannot start speech transcription worker"), true); }
  }

  private finish(result?: SpeechTranscript, error?: Error, kill = false): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (kill) {
      const child = this.child; this.child = undefined; child?.kill();
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    }
    const job = this.active; this.active = undefined;
    if (job) {
      job.detach();
      if (error) job.reject(error);
      else if (!result || typeof result.text !== "string" || !Number.isFinite(result.audioSeconds)) job.reject(new Error("Invalid speech transcript"));
      else job.resolve(result);
    }
    if (!this.closed) this.pump();
  }
}
