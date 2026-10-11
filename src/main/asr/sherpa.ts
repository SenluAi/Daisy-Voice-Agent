import { EventEmitter } from "node:events";
import type { OnlineRecognizer, OnlineStream } from "sherpa-onnx-node";
import { log } from "../utils/logger";
import {
  createSherpaStream,
  getSherpaBlockBytes,
  getSherpaBlockSize,
  getSherpaNumThreads,
  pcm16ToFloat32,
  SHERPA_SAMPLE_RATE,
} from "./sherpaRuntime";

export class SherpaAsrSession extends EventEmitter {
  private recognizer: OnlineRecognizer | null = null;
  private stream: OnlineStream | null = null;
  private pendingPcm: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private sessionActive = false;
  private finalEmitted = false;
  private lastText = "";
  private totalAudioBytes = 0;
  private blockBytes = getSherpaBlockBytes();
  private blockSize = getSherpaBlockSize();
  private numThreads = getSherpaNumThreads();

  getLastText(): string {
    return this.lastText;
  }

  start(): void {
    if (this.sessionActive) return;
    try {
      const created = createSherpaStream();
      this.recognizer = created.recognizer;
      this.stream = created.stream;
      this.pendingPcm = Buffer.alloc(0);
      this.sessionActive = true;
      this.finalEmitted = false;
      this.lastText = "";
      this.totalAudioBytes = 0;
      this.blockBytes = getSherpaBlockBytes();
      this.blockSize = getSherpaBlockSize();
      this.numThreads = getSherpaNumThreads();
      log(
        `SherpaAsrSession: started streaming Paraformer INT8, numThreads=${this.numThreads}, blockSize=${this.blockSize}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`SherpaAsrSession: start failed: ${message}`);
      queueMicrotask(() => this.emit("error", message));
    }
  }

  stop(): void {
    if (!this.sessionActive || this.finalEmitted) return;
    log(`SherpaAsrSession: stop() called, total audio: ${this.totalAudioBytes} bytes`);
    try {
      this.flushPending(true);
      this.stream?.inputFinished();
      this.decodeReady();
      this.emitFinal();
    } catch (error) {
      this.fail(error);
    }
  }

  cancel(): void {
    this.resetStream();
    this.cleanup();
  }

  reset(): void {
    this.resetStream();
    this.pendingPcm = Buffer.alloc(0);
    this.lastText = "";
    this.totalAudioBytes = 0;
  }

  feedPcm(buffer: Buffer): void {
    if (!this.sessionActive || this.finalEmitted || !this.stream || buffer.length === 0) return;
    this.totalAudioBytes += buffer.length;
    this.pendingPcm = this.pendingPcm.length > 0 ? Buffer.concat([this.pendingPcm, buffer]) : buffer;

    try {
      this.flushPending(false);
      this.decodeReady();
      this.emitPartialIfChanged();
      if (this.recognizer?.isEndpoint(this.stream)) {
        log(`SherpaAsrSession: endpoint detected, final="${this.lastText}"`);
        if (this.lastText.trim()) {
          this.emitFinal();
        } else {
          this.recognizer.reset(this.stream);
          this.pendingPcm = Buffer.alloc(0);
          this.totalAudioBytes = 0;
          log("SherpaAsrSession: ignored empty silence endpoint and kept listening");
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private flushPending(flushAll: boolean): void {
    if (!this.stream) return;
    while (this.pendingPcm.length >= this.blockBytes) {
      const chunk = this.pendingPcm.subarray(0, this.blockBytes);
      this.pendingPcm = this.pendingPcm.subarray(this.blockBytes);
      this.acceptChunk(chunk);
    }
    if (flushAll && this.pendingPcm.length > 0) {
      this.acceptChunk(this.pendingPcm);
      this.pendingPcm = Buffer.alloc(0);
    }
  }

  private acceptChunk(chunk: Buffer): void {
    this.stream?.acceptWaveform({
      sampleRate: SHERPA_SAMPLE_RATE,
      samples: pcm16ToFloat32(chunk),
    });
  }

  private decodeReady(): void {
    if (!this.recognizer || !this.stream) return;
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream);
    }
  }

  private emitPartialIfChanged(): void {
    const text = this.currentText();
    if (text && text !== this.lastText) {
      this.lastText = text;
      this.emit("partial", text);
    }
  }

  private emitFinal(): void {
    if (this.finalEmitted) return;
    this.emitPartialIfChanged();
    this.finalEmitted = true;
    const finalText = this.lastText.trim();
    this.resetStream();
    this.cleanup();
    log(`SherpaAsrSession: final="${finalText}"`);
    this.emit("final", finalText);
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
        log("SherpaAsrSession: stream reset");
      } catch (error) {
        log(`SherpaAsrSession: stream reset failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private fail(error: unknown): void {
    if (this.finalEmitted) return;
    const message = error instanceof Error ? error.message : String(error);
    this.finalEmitted = true;
    this.resetStream();
    this.cleanup();
    log(`SherpaAsrSession error: ${message}`);
    this.emit("error", message);
  }

  private cleanup(): void {
    this.sessionActive = false;
    this.pendingPcm = Buffer.alloc(0);
    this.recognizer = null;
    this.stream = null;
    this.totalAudioBytes = 0;
  }
}
