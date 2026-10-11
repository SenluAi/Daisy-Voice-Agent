const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const contract = require('../dist/main/extensions/speechContract');

function wav(seconds = 1) {
  const buffer = Buffer.alloc(44 + Math.ceil(seconds * 32000));
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

(async () => {
  assert.equal(contract.readSpeechWav(wav(120)).audioSeconds, 120);
  for (const mutate of [audio => audio.writeUInt16LE(2, 22), audio => audio.writeUInt32LE(48000, 24),
    audio => audio.writeUInt16LE(32, 34), audio => audio.writeUInt32LE(999, 40), audio => audio.write('NOPE')]) {
    const audio = wav(); mutate(audio); assert.throws(() => contract.readSpeechWav(audio));
  }
  assert.throws(() => contract.readSpeechWav(wav(121)), /120 seconds/);
  assert.throws(() => contract.readSpeechWav(Buffer.alloc(5 * 1024 * 1024)), /size/);
  assert.throws(() => contract.readSpeechWav(new Uint8Array(0)), /size/);

  const workers = [];
  class Worker extends EventEmitter {
    messages = []; killed = false;
    postMessage(message) { this.messages.push(message); }
    kill() { this.killed = true; }
  }
  let localReady = false;
  const config = { asr: { apiKey: 'fixture', appId: '', accessToken: '', resourceId: 'fixture', wsUrl: 'wss://fixture', localSherpaFirst: true }, sherpa: { numThreads: 4 } };
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return { app: { getPath: () => require('node:os').tmpdir() }, utilityProcess: {
      fork(_file, _args, options) { assert.equal(options.env.DEEPSEEK_API_KEY, undefined); const worker = new Worker(); workers.push(worker); return worker; },
    } };
    if (name === '../config/env') return { config, isSherpaOnnxModelReady: () => localReady,
      getSherpaOnnxModelFiles: () => ({ encoder: '/fixture/encoder', decoder: '/fixture/decoder', tokens: '/fixture/tokens' }) };
    return load.call(this, name, ...args);
  };
  let serviceModule;
  try { serviceModule = require('../dist/main/extensions/speechService'); } finally { Module._load = load; }
  const { speechCatalog, DaisySpeechService } = serviceModule;
  assert.equal(speechCatalog().selection.providerId, 'volcengine');
  localReady = true;
  assert.equal(speechCatalog().selection.providerId, 'sherpa');
  config.asr.localSherpaFirst = false;
  assert.equal(speechCatalog().selection.providerId, 'volcengine');
  config.asr.apiKey = ''; localReady = false;
  assert.equal(speechCatalog().providers.length, 0);
  assert.throws(() => contract.resolveSpeechRequest({ audio: wav() }, speechCatalog()), /No available/);
  config.asr.apiKey = 'fixture';
  const input = { audio: wav(), language: 'auto' };
  const spec = contract.resolveSpeechRequest(input, speechCatalog());
  input.audio[44] = 7; assert.equal(spec.audio[44], 0, 'resolved audio must be immutable from the caller');
  assert.throws(() => contract.resolveSpeechRequest({ ...input, language: 'xx' }, speechCatalog()), /language/);
  assert.throws(() => contract.resolveSpeechRequest({ ...input, providerId: 'wechat' }, speechCatalog()), /No available/);

  const service = new DaisySpeechService();
  const result = service.transcribe(spec);
  const worker = workers.at(-1);
  worker.emit('message', { id: worker.messages[0].id, result: { text: '完整音频', audioSeconds: 1, inferenceSeconds: 0.1 } });
  assert.equal((await result).text, '完整音频');
  const controller = new AbortController();
  const cancelled = service.transcribe(spec, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); await rejected; assert.equal(worker.killed, true);
  const jobs = Array.from({ length: 9 }, () => service.transcribe(spec));
  const settled = Promise.allSettled(jobs);
  await assert.rejects(() => service.transcribe(spec), /queue is full/);
  const current = workers.at(-1);
  current.emit('exit', 1);
  service.close();
  assert.equal((await settled).every(x => x.status === 'rejected'), true);
  assert.equal(workers.at(-1).killed, true);
  await assert.rejects(() => service.transcribe(spec), /closed/);
  console.log('PASS: STT WAV/rate/channel/size/duration validation, immutable specs, actual provider selection, credential isolation, queue bounds, cancellation, worker crash and shutdown.');
})().catch(error => { console.error(error); process.exitCode = 1; });
