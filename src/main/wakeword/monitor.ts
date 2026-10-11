import { EventEmitter } from "node:events";
import type { OnlineRecognizer, OnlineStream } from "sherpa-onnx-node";
import {
  createSherpaStream,
  getSherpaBlockBytes,
  getSherpaBlockSize,
  getSherpaNumThreads,
  pcm16ToFloat32,
  SHERPA_SAMPLE_RATE,
} from "../asr/sherpaRuntime";
import { config } from "../config/env";
import { isStopTaskCommand } from "../asr/voiceFilter";
import { log } from "../utils/logger";
import { extractWakeCommand, findWakeWord } from "./patterns";

const SAMPLE_RATE = 16000;

export class WakeWordMonitor extends EventEmitter {
  private recognizer: OnlineRecognizer | null = null;
  private stream: OnlineStream | null = null;
  private pendingPcm: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private paused = true;
  private interruptOnly = false;
  private lastText = "";
  private lastWakeAt = 0;
  private blockBytes = getSherpaBlockBytes();
  private blockSize = getSherpaBlockSize();
  private numThreads = getSherpaNumThreads();

  constructor(_keyword: string) {
    super();
  }

  start(): void {
    this.paused = false;
    this.lastText = "";
    this.pendingPcm = Buffer.alloc(0);
    this.blockBytes = getSherpaBlockBytes();
    this.blockSize = getSherpaBlockSize();
    this.numThreads = getSherpaNumThreads();
    this.ensureStream();
    log(
      `WakeWordMonitor: started with Sherpa-ONNX streaming Paraformer INT8, numThreads=${this.numThreads}, blockSize=${this.blockSize}`,
    );
  }

  stop(): void {
    this.pause();
  }

  pause(): void {
    this.paused = true;
    this.pendingPcm = Buffer.alloc(0);
    this.lastText = "";
    this.resetStream();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pendingPcm = Buffer.alloc(0);
    this.lastText = "";
    this.blockBytes = getSherpaBlockBytes();
    this.blockSize = getSherpaBlockSize();
    this.numThreads = getSherpaNumThreads();
    this.ensureStream();
    log("WakeWordMonitor: resumed");
  }

  setInterruptOnly(enabled: boolean): void {
    if (this.interruptOnly === enabled) return;
    this.interruptOnly = enabled;
    this.resetStream();
  }

  feedPcm(buffer: Buffer): void {
    if (this.paused || buffer.length === 0) return;
    if (!this.ensureStream()) return;

    try {
      this.pendingPcm = this.pendingPcm.length > 0 ? Buffer.concat([this.pendingPcm, buffer]) : buffer;
      while (this.pendingPcm.length >= this.blockBytes) {
        const chunk = this.pendingPcm.subarray(0, this.blockBytes);
        this.pendingPcm = this.pendingPcm.subarray(this.blockBytes);
        this.stream?.acceptWaveform({
          sampleRate: SHERPA_SAMPLE_RATE,
          samples: pcm16ToFloat32(chunk),
        });
        this.decodeReady();
        this.checkWakeCandidate();
      }

      if (this.stream && this.recognizer?.isEndpoint(this.stream)) {
        this.checkWakeCandidate(true);
        this.resetStream();
      }
    } catch (error) {
      log(`WakeWordMonitor: Sherpa streaming error: ${error instanceof Error ? error.message : String(error)}`);
      this.pause();
    }
  }

  private ensureStream(): boolean {
    if (this.recognizer && this.stream) return true;
    try {
      const created = createSherpaStream();
      this.recognizer = created.recognizer;
      this.stream = created.stream;
      return true;
    } catch (error) {
      log(`WakeWordMonitor: Sherpa stream unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private decodeReady(): void {
    if (!this.recognizer || !this.stream) return;
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream);
    }
  }

  private checkWakeCandidate(fromEndpoint = false): void {
    const text = this.currentText();
    if (this.interruptOnly) {
      if (fromEndpoint && isStopTaskCommand(text)) {
        log(`WakeWordMonitor: stop task command="${text}"`);
        this.emit("stop_task");
        this.resetStream();
      }
      return;
    }
    if (!text || text === this.lastText) return;
    this.lastText = text;
    log(`WakeWordMonitor: sherpa result="${text}"`);

    const match = findWakeWord(text);
    if (!match) return;
    if (Date.now() - this.lastWakeAt < 1500) return;

    this.lastWakeAt = Date.now();
    const command = extractWakeCommand(text);
    log(`WakeWordMonitor: matched pattern ${match.pattern}`);
    log(`WakeWordMonitor: wake word detected! kind=${match.kind}, endpoint=${fromEndpoint}, command="${command}"`);
    this.emit("wake", command);
    this.resetStream();
  }

  private currentText(): string {
    if (!this.recognizer || !this.stream) return "";
    const result = this.recognizer.getResult(this.stream);
    return (result.text || "").replace(/\s+/g, " ").trim();
  }

  private resetStream(): void {
    if (this.recognizer && this.stream) {
      try {
        this.recognizer.reset(this.stream);
      } catch (error) {
        log(`WakeWordMonitor: Sherpa reset failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.stream = null;
    this.pendingPcm = Buffer.alloc(0);
    this.lastText = "";
  }

}

export class VAD {
  private noiseFloor = 0.005;
  private speechStartMs = 0;
  private silenceEndMs = 2000;
  private inSpeech = false;
  private speechCounter = 0;
  private silenceCounter = 0;
  private frameCount = 0;

  constructor(silenceEndMs = 2000, speechStartMs = 0) {
    this.silenceEndMs = silenceEndMs;
    this.speechStartMs = speechStartMs;
  }

  feed(buffer: Buffer): { speechStart: boolean; silenceEnd: boolean } {
    const energy = this.calculateEnergy(buffer);
    const chunkMs = ((buffer.length / 2) / SAMPLE_RATE) * 1000;

    if (!this.inSpeech) {
      this.noiseFloor = this.noiseFloor * 0.97 + energy * 0.03;
    }
    const sensitivity = Math.min(100, Math.max(1, config.asr.microphoneSensitivity));
    const threshold = Math.max(
      this.noiseFloor * (1.8 + (100 - sensitivity) * 0.012),
      0.012 + (100 - sensitivity) * 0.00018,
    );
    const isLoud = energy > threshold;

    this.frameCount++;
    if (this.frameCount % 50 === 0) {
      log(`VAD: energy=${energy.toFixed(4)} noiseFloor=${this.noiseFloor.toFixed(4)} threshold=${threshold.toFixed(4)} isLoud=${isLoud} inSpeech=${this.inSpeech}`);
    }

    if (!this.inSpeech) {
      if (isLoud) {
        this.speechCounter += chunkMs;
        this.silenceCounter = 0;
        const requiredSpeechMs = Math.max(this.speechStartMs, 150 + (100 - sensitivity) * 4);
        if (this.speechCounter >= requiredSpeechMs) {
          this.inSpeech = true;
          return { speechStart: true, silenceEnd: false };
        }
      } else {
        this.speechCounter = 0;
      }
      return { speechStart: false, silenceEnd: false };
    }

    if (isLoud) {
      this.silenceCounter = 0;
    } else {
      this.silenceCounter += chunkMs;
      if (this.silenceCounter >= this.silenceEndMs) {
        this.inSpeech = false;
        this.speechCounter = 0;
        this.silenceCounter = 0;
        return { speechStart: false, silenceEnd: true };
      }
    }
    return { speechStart: false, silenceEnd: false };
  }

  reset(): void {
    this.inSpeech = false;
    this.speechCounter = 0;
    this.silenceCounter = 0;
    this.noiseFloor = 0.005;
  }

  private calculateEnergy(buffer: Buffer): number {
    let sum = 0;
    const samples = buffer.length / 2;
    if (samples === 0) return 0;
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += Math.abs(sample);
    }
    return sum / samples / 32768;
  }
}
