const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { generateKeyPairSync, sign } = require('node:crypto');
const ts = require('typescript');
const shared = require('../dist/shared/license');
const { LicenseLease } = require('../dist/main/license/lease');
const guard = require('../dist/main/license/access');
const root = path.resolve(__dirname, '..');
const keys = generateKeyPairSync('ed25519');
const testShared = { ...shared, LICENSE_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const modules = new Map();

// Use real signatures with an ephemeral key; never load the author's signing key.
function load(relative) {
  const file = path.resolve(root, relative);
  if (file === path.join(root, 'src/shared/license.ts')) return testShared;
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const nativeRequire = createRequire(file);
  const requireLocal = name => name.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), name + '.ts'))) : nativeRequire(name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(requireLocal, module, module.exports);
  return module.exports;
}
const { verifyAccessToken, verifyActivationCode } = load('src/main/license/verify.ts');
const server = load('functions/api/license/access.ts');
const signer = load('functions/api/license/_shared/license.ts');
const ledger = load('functions/api/license/_shared/ledger.ts');
const device = 'DSY1-' + Array(8).fill('ABCDE').join('-');
const otherDevice = 'DSY1-' + Array(8).fill('12345').join('-');
const nonce = 'a'.repeat(64);
const epoch = Math.floor(Date.now() / 1000);
const claims = extra => ({ v: 2, iss: shared.LICENSE_ISSUER, aud: shared.LICENSE_APP_ID, sub: device,
  edition: 'trial', licenseId: '', iat: epoch, exp: epoch + shared.LEASE_SECONDS,
  trialStartedAt: epoch, trialExpiresAt: epoch + shared.TRIAL_SECONDS, nonce, ...extra });
function token(value, header = { alg: 'EdDSA', typ: 'JWT', kid: 'daisy-1' }) {
  const input = [header, value].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return input + '.' + sign(null, Buffer.from(input), keys.privateKey).toString('base64url');
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-license-test-'));
  let wall = epoch * 1000, mono = 0, activation = null, fetcher = async () => { throw new Error('offline'); };
  const changes = [];
  const options = { filePath: path.join(directory, 'lease.bin'), endpoint: 'https://license.invalid/access', deviceCode: device,
    activation: () => activation, verify: verifyAccessToken,
    encrypt: text => Buffer.from(text), decrypt: data => data.toString(),
    now: () => wall, monotonic: () => mono, fetch: (...args) => fetcher(...args), onChange: state => changes.push(state) };
  const leases = [];
  return { directory, options, changes, lease: () => { const item = new LicenseLease(options); leases.push(item); return item; },
    advance: ms => { wall += ms; mono += ms; }, rollback: ms => { wall -= ms; },
    activate: value => { activation = value; }, fetch: value => { fetcher = value; },
    online: extra => { fetcher = async (_url, init) => new Response(JSON.stringify({ accessToken: token(claims({
      iat: Math.floor(wall / 1000), exp: Math.floor(wall / 1000) + shared.LEASE_SECONDS,
      nonce: JSON.parse(init.body).nonce, ...extra })) })); },
    cleanup: () => { leases.forEach(item => item.close()); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('Ed25519 JWT validates and rejects tampering, algorithm downgrade, cross-device, nonce and excessive life', () => {
  const valid = token(claims());
  assert.equal(verifyAccessToken(valid, device, nonce).edition, 'trial');
  const parts = valid.split('.');
  parts[1] = Buffer.from(JSON.stringify(claims({ edition: 'full' }))).toString('base64url');
  assert.throws(() => verifyAccessToken(parts.join('.'), device));
  assert.throws(() => verifyAccessToken(valid, otherDevice));
  assert.throws(() => verifyAccessToken(valid, device, 'b'.repeat(64)));
  for (const extra of [{ exp: epoch + shared.LEASE_SECONDS + 1 }, { trialExpiresAt: epoch + shared.TRIAL_SECONDS + 1 },
    { aud: 'another-app' }, { iss: 'https://evil.invalid' }, { iat: 0 }]) {
    assert.throws(() => verifyAccessToken(token(claims(extra)), device));
  }
  assert.throws(() => verifyAccessToken(token(claims(), { alg: 'none', typ: 'JWT', kid: 'daisy-1' }), device));
});

test('new installation fails closed offline; secure signed cache gives at most 24 hours', async () => {
  const f = fixture();
  try {
    const first = f.lease(); await first.start(); assert.equal(first.snapshot().allowed, false);
    f.online(); await first.refresh(); assert.equal(first.snapshot().allowed, true);
    first.close(); f.fetch(async () => { throw new Error('offline'); });
    f.advance(shared.LEASE_SECONDS * 1000 - 1);
    const restored = f.lease(); await restored.start(); assert.equal(restored.snapshot().allowed, true);
    f.advance(1); assert.equal(restored.snapshot().allowed, false);
  } finally { f.cleanup(); }
});

test('seven-day boundary locks even if the network is unavailable', async () => {
  const f = fixture();
  try {
    f.online({ trialStartedAt: epoch - shared.TRIAL_SECONDS + 10, trialExpiresAt: epoch + 10, exp: epoch + 10 });
    const lease = f.lease(); await lease.start(); assert.equal(lease.snapshot().allowed, true);
    f.advance(10000); assert.equal(lease.snapshot().accessState, 'expired');
    assert.equal(lease.snapshot().allowed, false);
  } finally { f.cleanup(); }
});

test('rollback during execution cannot extend life; rollback on restart requires online verification', async () => {
  const f = fixture();
  try {
    f.online(); const lease = f.lease(); await lease.start();
    f.advance(3600000); f.rollback(7200000); assert.equal(lease.snapshot().remainingTrialMs, shared.TRIAL_SECONDS * 1000 - 3600000);
    lease.close(); f.rollback(600000); f.fetch(async () => { throw new Error('offline'); });
    const restarted = f.lease(); await restarted.start(); assert.equal(restarted.snapshot().allowed, false);
  } finally { f.cleanup(); }
});

test('server revocation and invalid signatures remove offline grace immediately', async () => {
  for (const response of [() => new Response(JSON.stringify({ reason: 'LICENSE_REVOKED', message: 'revoked' }), { status: 403 }),
    () => new Response(JSON.stringify({ accessToken: 'invalid.token.signature' }))]) {
    const f = fixture();
    try {
      f.online(); const lease = f.lease(); await lease.start();
      f.fetch(async () => response()); await lease.refresh(); assert.equal(lease.snapshot().allowed, false);
      assert.equal(fs.existsSync(f.options.filePath), false);
      lease.close(); f.fetch(async () => { throw new Error('offline'); });
      const restarted = f.lease(); await restarted.start(); assert.equal(restarted.snapshot().allowed, false);
    } finally { f.cleanup(); }
  }
});

test('corrupt cache is rejected; full license cache cannot survive clearing the activation', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.options.filePath, 'corrupt'); const empty = f.lease(); await empty.start(); assert.equal(empty.snapshot().allowed, false);
    f.activate({ code: 'test', licenseId: 'test-full' }); f.online({ edition: 'full', licenseId: 'test-full', trialStartedAt: null, trialExpiresAt: null });
    await empty.refresh(); assert.equal(empty.snapshot().accessState, 'activated'); empty.close();
    f.activate(null); f.fetch(async () => { throw new Error('offline'); });
    const cleared = f.lease(); await cleared.start(); assert.equal(cleared.snapshot().allowed, false);
  } finally { f.cleanup(); }
});

test('activation during an old request ignores stale denials and fetches a fresh full lease', async () => {
  const f = fixture();
  try {
    f.online(); const lease = f.lease(); await lease.start();
    let finish; f.fetch(() => new Promise(resolve => { finish = resolve; }));
    const old = lease.refresh();
    f.activate({ code: 'test', licenseId: 'full' }); lease.invalidate();
    f.online({ edition: 'full', licenseId: 'full', trialStartedAt: null, trialExpiresAt: null });
    const newRequest = lease.refresh();
    finish(new Response(JSON.stringify({ reason: 'TRIAL_EXPIRED' }), { status: 403 }));
    await Promise.all([old, newRequest]); assert.equal(lease.snapshot().accessState, 'activated');
    assert.equal(lease.snapshot().allowed, true);
  } finally { f.cleanup(); }
});

test('expiry timer notifies guards without relying on another user interaction', async () => {
  const f = fixture();
  try {
    f.online({ exp: epoch + 1 }); const lease = f.lease();
    f.options.onChange = status => guard.setLicenseAccessCheck(() => status.allowed);
    await lease.start(); guard.requireLicenseAccess(); f.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 1050));
    assert.throws(() => guard.requireLicenseAccess(), /授权/);
  } finally { f.cleanup(); guard.setLicenseAccessCheck(() => true); }
});

const env = { DAISY_LICENSE_LEDGER_REPOSITORY: 'test/ledger', DAISY_LICENSE_LEDGER_GITHUB_TOKEN: 'test-not-a-credential',
  DAISY_LICENSE_PRIVATE_KEY_PEM_B64: Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64') };
function fakeGit() {
  const files = new Map(); let writes = 0;
  return { files, get writes() { return writes; }, fetch: async (url, init = {}) => {
    const file = String(url).split('/contents/')[1]; assert.ok(file);
    if (init.method === 'PUT') {
      if (files.has(file)) return new Response('{}', { status: 409 });
      writes++; files.set(file, JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString()));
      return new Response('{}', { status: 201 });
    }
    return files.has(file) ? new Response(JSON.stringify({ sha: 'test-sha', content: Buffer.from(JSON.stringify(files.get(file))).toString('base64') }))
      : new Response('{}', { status: 404 });
  } };
}
async function withGit(callback) {
  const original = global.fetch; const git = fakeGit(); global.fetch = git.fetch;
  try { await callback(git); } finally { global.fetch = original; }
}
const request = data => new Request('https://license.invalid/api/license/access', { method: 'POST', body: JSON.stringify(data) });

test('server and client share real activation/JWT signatures', async () => {
  const signed = await signer.issueAccessToken(env, claims());
  assert.equal(verifyAccessToken(signed, device, nonce).exp, epoch + shared.LEASE_SECONDS);
  const payload = { v: 1, appId: shared.LICENSE_APP_ID, deviceCode: device, licenseId: 'full', issuedAt: new Date().toISOString(), edition: 'full', customer: '' };
  const activationCode = await signer.issueActivationCode(env, payload);
  assert.equal(verifyActivationCode(activationCode, device).ok, true);
  assert.equal(verifyActivationCode(activationCode, otherDevice).ok, false);
  assert.equal((await signer.verifyActivationCode(activationCode, device)).licenseId, 'full');
});

test('parallel first-use registration converges on one trial and reinstall never resets it', async () => withGit(async git => {
  const results = await Promise.all([ledger.getOrCreateTrial(env, device, epoch), ledger.getOrCreateTrial(env, device, epoch + 5)]);
  assert.equal(results[0].startedAt, results[1].startedAt); assert.equal(git.writes, 1);
  const later = await ledger.getOrCreateTrial(env, device, epoch + shared.TRIAL_SECONDS + 5);
  assert.equal(later.startedAt, results[0].startedAt); assert.equal(git.writes, 1);
}));

test('server shortens final trial lease and rejects expired trial at the exact seventh day', async () => withGit(async git => {
  const now = Math.floor(Date.now() / 1000);
  const record = await ledger.getOrCreateTrial(env, device, now - shared.TRIAL_SECONDS + 10);
  const response = await server.onRequest({ request: request({ deviceCode: device, nonce }), env });
  assert.equal(response.status, 200);
  const result = verifyAccessToken((await response.json()).accessToken, device, nonce);
  assert.equal(result.exp, record.startedAt + shared.TRIAL_SECONDS);
  [...git.files.values()].find(value => value.v === 1 && value.deviceHash).startedAt = now - shared.TRIAL_SECONDS;
  const expired = await server.onRequest({ request: request({ deviceCode: device, nonce }), env });
  assert.equal(expired.status, 403); assert.equal((await expired.json()).reason, 'TRIAL_EXPIRED');
}));

test('server validates active ledger, detects revocation and does not downgrade invalid activation to trial', async () => withGit(async git => {
  const payload = { v: 1, appId: shared.LICENSE_APP_ID, deviceCode: device, licenseId: 'full', issuedAt: new Date().toISOString(), edition: 'full', customer: '' };
  const activationCode = await signer.issueActivationCode(env, payload);
  const record = { ...payload, state: 'redeemed', createdAt: payload.issuedAt };
  git.files.set('redemptions.json', { version: 1, codes: { hash: record } });
  const response = await server.onRequest({ request: request({ deviceCode: device, nonce, activationCode }), env });
  assert.equal(response.status, 200); assert.equal(verifyAccessToken((await response.json()).accessToken, device, nonce).edition, 'full');
  record.state = 'revoked';
  const revoked = await server.onRequest({ request: request({ deviceCode: device, nonce, activationCode }), env });
  assert.equal(revoked.status, 403); assert.equal((await revoked.json()).reason, 'LICENSE_REVOKED');
  assert.equal((await server.onRequest({ request: request({ deviceCode: device, nonce, activationCode: 'invalid' }), env })).status, 403);
  assert.equal(git.writes, 0);
}));

test('malformed requests and inaccessible ledger never issue a lease', async () => {
  for (const data of [null, {}, { deviceCode: 'invalid', nonce }, { deviceCode: device, nonce: 'bad' }]) {
    assert.equal((await server.onRequest({ request: request(data), env })).status, 400);
  }
  await withGit(async () => {
    global.fetch = async () => new Response('{}', { status: 500 });
    assert.equal((await server.onRequest({ request: request({ deviceCode: device, nonce }), env })).status, 503);
  });
});

test('runtime, IPC, tools and plugin host have authorization checks at actual dispatch boundaries', () => {
  for (const [file, symbol] of [['src/main/control/windows.ts', 'export async function executeTool'],
    ['src/main/control/macos.ts', 'export async function executeTool'], ['src/main/command/router.ts', 'export async function tryLocalCommand'],
    ['src/main/llm/deepseek.ts', 'async sendMessage'], ['src/main/llm/deepseek.ts', 'async sendImageMessage'],
    ['src/main/extensions/manager.ts', 'async request<'], ['src/main/extensions/manager.ts', 'async execute(']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const start = source.indexOf(symbol); assert.ok(start >= 0, symbol);
    assert.match(source.slice(start, start + 320), /requireLicenseAccess\(\)/);
  }
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /await initializeLicense\(handleLicenseChange\)/);
  const locking = main.slice(main.indexOf('function handleLicenseChange'), main.indexOf('function handleLicenseChange') + 2100);
  for (const action of ['abortAllTasks()', 'closeExtensions()', 'globalShortcut?.destroy()', 'wakeWordMonitor?.stop()', 'hideFloatWindow()']) assert.ok(locking.includes(action), action);
});
