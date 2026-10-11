const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright-core');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-license-runtime-'));
(async () => {
  let application;
  try {
    const env = { ...process.env, DAISY_TEST_USER_DATA: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [path.join(__dirname, 'fixtures/license-runtime.cjs')], env, timeout: 30000 });
    application.context().setDefaultTimeout(10000);
    const window = await application.firstWindow();
    let settings;
    const deadline = Date.now() + 20000;
    while (!settings && Date.now() < deadline) {
      settings = application.windows().find(page => /settings\.html/.test(page.url()));
      if (!settings) await window.waitForTimeout(50);
    }
    assert.ok(settings, 'Settings window must be available');
    await settings.getByRole('button', { name: '模型配置', exact: true }).waitFor();
    await settings.evaluate(() => window.diriAPI.sendText('你好'));
    await settings.waitForTimeout(500);
    const before = await application.evaluate(() => ({ ...global.__licenseRuntimeTest.stats }));
    assert.equal(before.llmStarted, 1); assert.equal(before.ttsStarted, 1); assert.equal(before.pluginsActive, true);
    const command = application.evaluate(async ({ app }) => {
      const path = process.mainModule.require('node:path');
      return process.mainModule.require(path.join(app.getAppPath(), '../../dist/main/control/windows')).runShellCommand('Start-Sleep -Seconds 20; Write-Output done', 'powershell');
    });
    await settings.waitForTimeout(600);
    await application.evaluate(() => { global.__licenseRuntimeTest.stats.recording = true; global.__licenseRuntimeTest.expire(); });
    const started = Date.now();
    assert.match(await command, /失败|取消|aborted/i);
    assert.ok(Date.now() - started < 5000, 'Running script must be cancelled, not left for its 20-second sleep');
    await settings.getByText('试用已到期 · 已锁定', { exact: true }).waitFor();
    assert.equal(await settings.locator('nav button').count(), 1);
    assert.equal(await settings.locator('nav button').innerText(), '授权激活');
    const locked = await application.evaluate(() => ({ ...global.__licenseRuntimeTest.stats }));
    assert.equal(locked.recording, false); assert.ok(locked.recordingStopped > 0);
    assert.equal(locked.wakeActive, false); assert.equal(locked.pluginsActive, false);
    assert.ok(locked.llmAborted > 0); assert.ok(locked.ttsStopped > 0); assert.ok(locked.shortcutDestroyed > 0);
    await settings.evaluate(() => { window.diriAPI.startRecording(); window.diriAPI.sendText('请继续测试'); window.diriAPI.openHistory(); });
    await settings.waitForTimeout(200);
    const blocked = await application.evaluate(() => ({ ...global.__licenseRuntimeTest.stats }));
    assert.equal(blocked.llmStarted, before.llmStarted); assert.equal(blocked.recording, false);
    const screenshot = path.resolve(__dirname, '../../work/license-2.1.6/expired-settings.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true }); await settings.screenshot({ path: screenshot });
    await application.evaluate(() => global.__licenseRuntimeTest.activate());
    await settings.getByRole('button', { name: '模型配置', exact: true }).waitFor();
    const restored = await application.evaluate(() => ({ ...global.__licenseRuntimeTest.stats }));
    assert.equal(restored.pluginsActive, true); assert.equal(restored.wakeActive, true); assert.equal(restored.shortcuts, before.shortcuts + 1);
    await settings.evaluate(() => window.diriAPI.sendText('再问一个问题')); await settings.waitForTimeout(250);
    assert.equal(await application.evaluate(() => global.__licenseRuntimeTest.stats.llmStarted), 2);
    console.log(JSON.stringify({ result: 'PASS real main-process lock and recovery, real settings UI and running PowerShell cancellation',
      isolation: 'temporary userData; simulated license, speech, LLM and plugin services; no microphone or real redemption', screenshot }));
  } finally {
    await application?.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
