export interface SpeechFrameAnalysis {
  rms: number;
  speechLike: boolean;
}

export interface SpeechActivityResult extends SpeechFrameAnalysis {
  confirmed: boolean;
}

const MEANINGFUL_SINGLE_CHARS = new Set([
  "好", "对", "是", "不", "行", "停", "开", "关", "发", "删", "查", "看", "读", "写", "播", "来", "走", "退", "喂",
]);

const NON_SPEECH_TRANSCRIPTS = [
  /^(?:嗯|啊|哦|呃|额|唔|哼|哈|诶|唉|哎|嘶|呀)+$/u,
  /^(?:字幕|字幕组|谢谢观看|感谢观看|本期视频|请勿使用)[。.!！?？]*$/u,
];

const STOP_TASK_PATTERN = /^(?:停一下|停止执行|停止任务|结束任务)$/;

export function isStopTaskCommand(text: string): boolean {
  return STOP_TASK_PATTERN.test(text.replace(/[\s,，。！!？?、~"“”'‘’]/g, ""));
}

export function analyzeSpeechFrame(buffer: Buffer, rmsThreshold: number): SpeechFrameAnalysis {
  const samples = Math.floor(buffer.length / 2);
  if (samples < 2) return { rms: 0, speechLike: false };

  let sum = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    sum += buffer.readInt16LE(offset);
  }
  const mean = sum / samples;

  let squareSum = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previous = buffer.readInt16LE(0) - mean;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) - mean;
    squareSum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if ((sample >= 0) !== (previous >= 0)) zeroCrossings += 1;
    previous = sample;
  }

  const rms = Math.sqrt(squareSum / samples);
  if (rmsThreshold <= 0) return { rms, speechLike: false };
  if (rms < rmsThreshold) return { rms, speechLike: false };

  const crestFactor = peak / Math.max(rms, 1);
  const zeroCrossingRate = zeroCrossings / samples;
  const isShortImpact = crestFactor > 12;
  const isLowFrequencyHum = zeroCrossingRate < 0.008 && rms < rmsThreshold * 2.5;
  const isHighFrequencyNoise = zeroCrossingRate > 0.48;
  return {
    rms,
    speechLike: !isShortImpact && !isLowFrequencyHum && !isHighFrequencyNoise,
  };
}

export class SpeechActivityDetector {
  private startedAt = Date.now();
  private noiseFloorRms = 0;
  private voicedMs = 0;
  private confirmed = false;

  reset(): void {
    this.startedAt = Date.now();
    this.noiseFloorRms = 0;
    this.voicedMs = 0;
    this.confirmed = false;
  }

  feed(buffer: Buffer, baseThreshold: number, sensitivityValue: number): SpeechActivityResult {
    const sensitivity = Math.min(100, Math.max(1, sensitivityValue));
    const raw = analyzeSpeechFrame(buffer, 0);
    const durationMs = (Math.floor(buffer.length / 2) / 16000) * 1000;

    if (Date.now() - this.startedAt < 600) {
      this.updateNoiseFloor(raw.rms);
      return { ...raw, speechLike: false, confirmed: false };
    }

    const noiseMultiplier = 2.8 - sensitivity * 0.012;
    const effectiveThreshold = Math.max(baseThreshold, this.noiseFloorRms * noiseMultiplier);
    const analysis = analyzeSpeechFrame(buffer, effectiveThreshold);
    if (analysis.speechLike) {
      this.voicedMs += durationMs;
      const requiredSpeechMs = 750 - sensitivity * 5.5;
      if (this.voicedMs >= requiredSpeechMs) this.confirmed = true;
    } else if (!this.confirmed) {
      this.voicedMs = 0;
      if (raw.rms < effectiveThreshold * 1.15) this.updateNoiseFloor(raw.rms);
    }

    return { ...analysis, confirmed: this.confirmed };
  }

  private updateNoiseFloor(rms: number): void {
    this.noiseFloorRms = this.noiseFloorRms === 0
      ? rms
      : this.noiseFloorRms * 0.94 + rms * 0.06;
  }
}

export function filterVoiceTranscript(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";

  const compact = text.replace(/[\s,，。.!！?？、~"“”'‘’]/g, "").toLocaleLowerCase();
  if (!compact || NON_SPEECH_TRANSCRIPTS.some((pattern) => pattern.test(compact))) return "";

  const characters = Array.from(compact);
  if (characters.length === 1 && !MEANINGFUL_SINGLE_CHARS.has(characters[0])) return "";
  return text;
}
