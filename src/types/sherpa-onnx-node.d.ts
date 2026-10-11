declare module "sherpa-onnx-node" {
  export interface OnlineRecognizerConfig {
    featConfig: {
      sampleRate: number;
      featureDim: number;
    };
    modelConfig: {
      paraformer: {
        encoder: string;
        decoder: string;
      };
      tokens: string;
      numThreads: number;
      provider: string;
      debug: number;
    };
    decodingMethod?: string;
    maxActivePaths?: number;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
  }

  export interface OnlineRecognizerResult {
    text?: string;
  }

  export interface OnlineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
  }

  export function readWave(filename: string): { sampleRate: number; samples: Float32Array };
  export const version: string;
}
