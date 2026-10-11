import type { OnlineRecognizer, OnlineStream } from "sherpa-onnx-node";
import { AsrSession, AsrSessionState } from "../asr";
import { config } from "../config/env";
import { readSpeechWav, type SpeechSpec, type SpeechTranscript } from "./speechContract";

interface Request {
  id: number; spec: SpeechSpec; model: { encoder: string; decoder: string; tokens: string };
  numThreads: number; asr: Pick<typeof config.asr, "apiKey" | "appId" | "accessToken" | "resourceId" | "wsUrl">;
}
const port = process.parentPort;
if (!port) throw new Error("Speech worker requires the trusted Electron parent");
let recognizer: OnlineRecognizer | undefined;
let modelKey = "";
const yieldCpu = () => new Promise<void>(resolve => setImmediate(resolve));

async function sherpa(request: Request, pcm: Buffer): Promise<string> {
  const key = JSON.stringify([request.model, request.numThreads]);
  if (!recognizer || modelKey !== key) {
    const native: typeof import("sherpa-onnx-node") = require("sherpa-onnx-node");
    recognizer = new native.OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
      paraformer: { encoder: request.model.encoder, decoder: request.model.decoder }, tokens: request.model.tokens,
      numThreads: Math.max(1, request.numThreads), provider: "cpu", debug: 0,
    }, decodingMethod: "greedy_search", enableEndpoint: false });
    modelKey = key;
  }
  const stream: OnlineStream = recognizer.createStream();
  try {
    for (let offset = 0; offset < pcm.length; offset += 16000) {
      const part = pcm.subarray(offset, offset + 16000);
      const samples = new Float32Array(part.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = part.readInt16LE(i * 2) / 32768;
      stream.acceptWaveform({ sampleRate: 16000, samples });
      while (recognizer.isReady(stream)) { recognizer.decode(stream); await yieldCpu(); }
    }
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) });
    stream.inputFinished();
    while (recognizer.isReady(stream)) { recognizer.decode(stream); await yieldCpu(); }
    return (recognizer.getResult(stream).text || "").replace(/\s+/g, " ").trim();
  } finally { recognizer.reset(stream); }
}

async function volcengine(request: Request, pcm: Buffer): Promise<string> {
  Object.assign(config.asr, request.asr);
  // Network backoff and bounded PCM buffering are isolated from live voice recognition.
  const session = new AsrSession();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (text?: string, error?: Error) => {
      if (settled) return;
      settled = true; session.cancel();
      if (error) reject(error); else resolve(text || "");
    };
    session.once("error", message => finish(undefined, new Error(message)));
    session.once("final", text => finish(text));
    session.start();
    void (async () => {
      while (!settled && session.getState() === AsrSessionState.CONNECTING) await new Promise(resolve => setTimeout(resolve, 20));
      for (let offset = 0; !settled && offset < pcm.length; offset += 3200) {
        session.feedPcm(pcm.subarray(offset, offset + 3200));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!settled) session.stop();
    })().catch(error => finish(undefined, error));
  });
}

port.on("message", ({ data }: { data: Request }) => {
  void (async (): Promise<SpeechTranscript> => {
    const { pcm, audioSeconds } = readSpeechWav(data.spec.audio);
    const started = performance.now();
    const text = data.spec.providerId === "sherpa" ? await sherpa(data, pcm) : await volcengine(data, pcm);
    return { text, audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 };
  })().then(result => port.postMessage({ id: data.id, result }), error => {
    port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  });
});
