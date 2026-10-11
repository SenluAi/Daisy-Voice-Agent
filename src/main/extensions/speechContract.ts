export const MAX_SPEECH_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_SPEECH_DURATION_SECONDS = 120;

export interface SpeechProvider {
  id: "sherpa" | "volcengine";
  name: string;
  location: "local" | "cloud";
  languages: string[];
  preparation: { phase: "ready" };
}
export interface SpeechCatalog {
  providers: SpeechProvider[];
  selection: { providerId?: string; language: string };
  maxAudioBytes: number;
  maxDurationSeconds: number;
}
export interface SpeechSpec { audio: Uint8Array; language: string; providerId: string }
export interface SpeechTranscript { text: string; audioSeconds: number; inferenceSeconds: number }

export function readSpeechWav(audio: unknown): { pcm: Buffer; audioSeconds: number } {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44 || audio.byteLength > MAX_SPEECH_AUDIO_BYTES) {
    throw new Error("Invalid speech audio size (maximum 4 MiB)");
  }
  const wav = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Invalid speech WAV length or header");
  let format = false;
  let pcm: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("Invalid speech WAV chunk");
    if (kind === "fmt ") {
      if (format || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error("Speech audio must be 16 kHz mono PCM16 WAV");
      }
      format = true;
    } else if (kind === "data") {
      if (pcm || !size || size % 2) throw new Error("Invalid speech WAV data");
      pcm = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !pcm || offset !== wav.length) throw new Error("Invalid speech WAV chunks");
  const audioSeconds = pcm.length / 32000;
  if (audioSeconds > MAX_SPEECH_DURATION_SECONDS) throw new Error("Speech audio exceeds 120 seconds; split it first");
  return { pcm, audioSeconds };
}

export function resolveSpeechRequest(request: unknown, catalog: SpeechCatalog): SpeechSpec {
  if (!request || typeof request !== "object") throw new Error("Invalid speech request");
  const input = request as Partial<SpeechSpec>;
  readSpeechWav(input.audio);
  const providerId = input.providerId || catalog.selection.providerId;
  const provider = catalog.providers.find(x => x.id === providerId);
  if (!provider) throw new Error("No available speech provider; configure Sherpa or Volcengine ASR");
  const language = input.language || catalog.selection.language || "auto";
  if (!provider.languages.includes(language)) throw new Error(`Unsupported speech language: ${language}`);
  return { providerId: provider.id, language, audio: new Uint8Array(input.audio!) };
}

export function speechAbortError(): Error {
  const error = new Error("Speech transcription cancelled");
  error.name = "AbortError";
  return error;
}
