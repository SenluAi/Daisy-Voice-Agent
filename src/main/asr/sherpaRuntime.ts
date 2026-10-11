import fs from "node:fs";
import {
  OnlineRecognizer,
  type OnlineRecognizerConfig,
  type OnlineStream,
} from "sherpa-onnx-node";
import {
  config,
  getSherpaOnnxModelFiles,
  isSherpaOnnxModelReady,
  SHERPA_ONNX_MODEL_NAME,
} from "../config/env";
import { log } from "../utils/logger";

export const SHERPA_SAMPLE_RATE = 16000;
export const SHERPA_DEFAULT_NUM_THREADS = 4;
export const SHERPA_MAX_NUM_THREADS = 32;
export const SHERPA_DEFAULT_BLOCK_SIZE = 160;
export const SHERPA_MIN_BLOCK_SIZE = 160;
export const SHERPA_BLOCK_SIZE = SHERPA_DEFAULT_BLOCK_SIZE;
export const SHERPA_BLOCK_BYTES = SHERPA_BLOCK_SIZE * 2;
export const SHERPA_NUM_THREADS = SHERPA_DEFAULT_NUM_THREADS;

let recognizer: OnlineRecognizer | null = null;
let recognizerConfigKey = "";

export function getSherpaNumThreads(): number {
  const parsed = Number.parseInt(String(config.sherpa.numThreads || SHERPA_DEFAULT_NUM_THREADS), 10);
  if (!Number.isFinite(parsed)) return SHERPA_DEFAULT_NUM_THREADS;
  return Math.min(SHERPA_MAX_NUM_THREADS, Math.max(1, parsed));
}

export function getSherpaBlockSize(): number {
  const parsed = Number.parseInt(String(config.sherpa.blockSize || SHERPA_DEFAULT_BLOCK_SIZE), 10);
  if (!Number.isFinite(parsed)) return SHERPA_DEFAULT_BLOCK_SIZE;
  return Math.max(SHERPA_MIN_BLOCK_SIZE, parsed);
}

export function getSherpaBlockBytes(): number {
  return getSherpaBlockSize() * 2;
}

export function getSherpaModelStatus(modelName = config.sherpa.model) {
  const files = getSherpaOnnxModelFiles(modelName || SHERPA_ONNX_MODEL_NAME);
  return {
    ...files,
    ready: isSherpaOnnxModelReady(modelName || SHERPA_ONNX_MODEL_NAME),
    encoderExists: fs.existsSync(files.encoder),
    decoderExists: fs.existsSync(files.decoder),
    tokensExists: fs.existsSync(files.tokens),
  };
}

export function resetSherpaRecognizerForTest(): void {
  recognizer = null;
  recognizerConfigKey = "";
}

export function createSherpaStream(): { recognizer: OnlineRecognizer; stream: OnlineStream } {
  const status = getSherpaModelStatus();
  if (!status.ready) {
    throw new Error(`Sherpa-ONNX Paraformer 模型未就绪：${status.modelDir}`);
  }

  const numThreads = getSherpaNumThreads();
  const blockSize = getSherpaBlockSize();
  const configKey = `${status.modelDir}|threads=${numThreads}`;

  if (!recognizer || recognizerConfigKey !== configKey) {
    const recognizerConfig: OnlineRecognizerConfig = {
      featConfig: {
        sampleRate: SHERPA_SAMPLE_RATE,
        featureDim: 80,
      },
      modelConfig: {
        paraformer: {
          encoder: status.encoder,
          decoder: status.decoder,
        },
        tokens: status.tokens,
        numThreads,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };

    recognizer = new OnlineRecognizer(recognizerConfig);
    recognizerConfigKey = configKey;
    log(
      `SherpaOnnx: recognizer loaded model=${status.modelDir}, numThreads=${numThreads}, blockSize=${blockSize}, encoder=encoder.int8.onnx, decoder=decoder.int8.onnx`,
    );
  }

  return { recognizer, stream: recognizer.createStream() };
}

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = Math.floor(pcm.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return samples;
}
