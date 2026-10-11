#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// node scripts/test-extension-host.cjs compiles only the host/worker into a temporary fixture.
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const ts = require("typescript");
  const project = path.resolve(__dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-extension-host-"));
  const cleanup = () => {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("daisy-extension-host-")) {
      throw new Error("Refusing to remove a fixture outside the temporary directory");
    }
    fs.rmSync(target, { recursive: true, force: true });
  };
  try {
    fs.symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const config = ts.readConfigFile(path.join(project, "tsconfig.json"), ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, project).options;
    const program = ts.createProgram([
      path.join(project, "src/main/extensions/pluginHost.ts"),
      path.join(project, "src/main/extensions/pluginWorker.ts"),
      path.join(project, "src/main/extensions/speechWorker.ts"),
      path.join(project, "src/types/sherpa-onnx-node.d.ts"),
    ], { ...options, outDir: path.join(root, "build"), sourceMap: false, noEmitOnError: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => project, getNewLine: () => "\n",
    }));
    if (program.emit().emitSkipped) throw new Error("Fixture compilation failed");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, "--fixture-root", root], {
      cwd: root, env, stdio: "inherit", windowsHide: true,
    });
    const watchdog = setTimeout(() => { console.error("Electron fixture exceeded 100 seconds"); child.kill(); }, 100_000);
    child.once("error", (error) => {
      clearTimeout(watchdog);
      console.error(error);
      cleanup();
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      clearTimeout(watchdog);
      cleanup();
      process.exitCode = code === 0 ? 0 : 1;
    });
  } catch (error) {
    console.error(error);
    cleanup();
    process.exitCode = 1;
  }
} else {
  const { app, utilityProcess } = require("electron");
  const rootArg = process.argv.indexOf("--fixture-root");
  if (rootArg < 0) throw new Error("Run this test with Node to create an isolated fixture");
  const root = path.resolve(process.argv[rootArg + 1]);
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setName("DaisyExtensionHostFixture");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.disableHardwareAcceleration();

  const children = new Set();
  const fork = utilityProcess.fork.bind(utilityProcess);
  utilityProcess.fork = (modulePath, args, options) => {
    assert.equal(app.isReady(), true, "fork must run after Electron app ready");
    assert.deepEqual(options.execArgv, []);
    const child = fork(modulePath, args, options);
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, message, timeout = 3_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await delay(20);
    }
  };
  const fixture = (id, source, meta = {}, filename = "index.cjs") => {
    const directory = path.join(root, "plugins", id);
    fs.mkdirSync(path.dirname(path.join(directory, filename)), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: id, main: filename, ...meta }));
    fs.writeFileSync(path.join(directory, filename), source);
    return { id, directory };
  };
  const definition = (name) => `{ name: ${JSON.stringify(name)}, description: "Fixture tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } }`;
  let assertions = 0;
  const check = async (name, run) => { await run(); assertions++; console.log(`PASS ${name}`); };

  app.whenReady().then(async () => {
    const { PluginHost } = require(path.join(root, "build/main/extensions/pluginHost.js"));
    const host = new PluginHost();
    let closeHost;
    try {
      // These resemble dotenv credentials, without reading or printing real credentials.
      const secretNames = ["DEEPSEEK_API_KEY", "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "FC_API_KEY", "FIRECRAWL_API_KEY", "NODE_OPTIONS", "NODE_PATH", "DAISY_FIXTURE_PRIVATE"];
      for (const key of secretNames) process.env[key] = "fixture-secret-must-not-leak";
      const echo = fixture("echo-a", `
        import { Context } from "@deepseek-ai/cordis";
        import fs from "node:fs";
        import path from "node:path";
        export const inject = ["daisy"];
        export async function apply(ctx, config) {
          if (!Context.is(ctx) || !(ctx instanceof Context)) throw new Error("Not a real Cordis Context");
          let cancelled = false;
          let removeLate;
          ctx.daisy.registerTool(${definition("echo")}, async (args) => config.prefix + ":" + args.text);
          ctx.daisy.registerTool(${definition("info")}, async () => ({
            actualContext: Context.is(ctx), userData: ctx.daisy.userData, pid: process.pid,
            env: process.env, config, gui: typeof globalThis.document,
          }));
          ctx.daisy.registerTool(${definition("wait")}, async (_, signal) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => { cancelled = true; reject(new Error("Cancelled inside plugin")); }, { once: true });
          }));
          ctx.daisy.registerTool(${definition("state")}, async () => ({ cancelled }));
          ctx.daisy.registerTool(${definition("add")}, async () => {
            removeLate = ctx.daisy.registerTool(${definition("late")}, async () => "late");
            return "added";
          });
          ctx.daisy.registerTool(${definition("remove")}, async () => { removeLate(); return "removed"; });
          ctx.provide("fixtureService", { value: "provided" });
          ctx.inject(["fixtureService"], (child) => {
            child.daisy.registerTool(${definition("dependent")}, async () => child.fixtureService.value);
          });
          ctx.effect(() => () => fs.writeFileSync(path.join(ctx.daisy.userData, "disposed.txt"), "disposed"));
        }
      `, {
        type: "module", main: "must-not-load.cjs",
        exports: { ".": { require: "./must-not-load.cjs", node: { import: "./echo.mjs" }, default: "./must-not-load.cjs" } },
      }, "echo.mjs");
      const second = fixture("echo-b", `module.exports = { apply(ctx, config) {
        ctx.daisy.registerTool(${definition("echo")}, async (args) => config.prefix + ":" + args.text);
      } };`, {}, "lib/index.cjs");
      await check("native import exports, actual Cordis apply/config and provided services", async () => {
        assert.deepEqual(await host.load({ ...echo, config: { prefix: "A", enabled: true } }), { status: "ready" });
        assert.deepEqual(host.status("echo-a"), { status: "ready" });
        assert.equal(await host.callTool("plugin:echo-a:echo", { text: "hello" }), "A:hello");
        assert.equal(await host.callTool("plugin:echo-a:dependent", {}), "provided");
      });
      let info;
      await check("worker environment whitelist, userData and separate PID", async () => {
        info = JSON.parse(await host.callTool("plugin:echo-a:info", {}));
        assert.equal(info.actualContext, true);
        assert.notEqual(info.pid, process.pid);
        assert.equal(info.gui, "undefined");
        assert.deepEqual(info.config, { prefix: "A", enabled: true });
        assert.equal(path.relative(profile, info.userData).startsWith(".."), false);
        assert.equal(fs.statSync(info.userData).isDirectory(), true);
        for (const key of secretNames) assert.equal(info.env[key], undefined, `Leaked ${key}`);
        for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA"]) {
          const actual = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase());
          if (actual) assert.equal(info.env[actual], process.env[actual], `Missing ${actual}`);
        }
      });
      await check("CJS main and two plugins with identical tool names", async () => {
        assert.equal((await host.load({ ...second, config: { prefix: "B" } })).status, "ready");
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "hello" }), "B:hello");
        assert.deepEqual(host.listTools().filter((tool) => tool.name === "echo").map((tool) => tool.id).sort(), ["plugin:echo-a:echo", "plugin:echo-b:echo"]);
        const result = await host.load(second);
        assert.equal(result.status, "error");
        assert.match(result.error, /already loaded/);
        const listed = host.listTools();
        listed[0].inputSchema.properties.text.type = "number";
        assert.equal(host.listTools()[0].inputSchema.properties.text.type, "string");
      });
      await check("pre-aborted and cooperative tool cancellation", async () => {
        const already = new AbortController();
        already.abort();
        await assert.rejects(host.callTool("plugin:echo-a:echo", {}, already.signal), { name: "AbortError" });
        const controller = new AbortController();
        const pending = assert.rejects(host.callTool("plugin:echo-a:wait", {}, controller.signal), { name: "AbortError" });
        await delay(50);
        controller.abort();
        await pending;
        assert.equal(JSON.parse(await host.callTool("plugin:echo-a:state", {})).cancelled, true);
        await delay(1_100);
        assert.equal(await host.callTool("plugin:echo-a:echo", { text: "alive" }), "A:alive");
      });
      await check("dynamic registrations and Cordis effect cleanup", async () => {
        await host.callTool("plugin:echo-a:add", {});
        await until(() => host.listTools().some((tool) => tool.id === "plugin:echo-a:late"), "Late tool did not appear");
        assert.equal(await host.callTool("plugin:echo-a:late", {}), "late");
        await host.callTool("plugin:echo-a:remove", {});
        await until(() => !host.listTools().some((tool) => tool.id === "plugin:echo-a:late"), "Disposed tool is still listed");
      });
      await check("DSH STT context contract, host RPC and cancellation/disposal", async () => {
        const entry = fixture('speech-bridge', `exports.inject=['daisy','speechToText','speechController']; exports.apply=ctx=>{
          const stt=ctx.get('speechToText'); const controller=ctx.get('speechController');
          ctx.daisy.registerTool(${definition('catalog')},async()=>({snapshot:stt.snapshot(),catalog:controller.catalog()}));
          ctx.daisy.registerTool(${definition('transcribe')},async(_,signal)=>{
            const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
            wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);
            wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
            return stt.transcribe(stt.resolve({audio:new Uint8Array(wav),language:'auto'}),signal);
          });
        };`);
        assert.equal((await host.load(entry)).status,'ready');
        const metadata=JSON.parse(await host.callTool('plugin:speech-bridge:catalog',{}));
        assert.ok(metadata.snapshot.providers.length);
        assert.equal(metadata.catalog.maxAudioBytes,4*1024*1024);
        assert.equal(metadata.catalog.maxDurationSeconds,120);
        for(const key of secretNames) assert.equal(JSON.stringify(metadata).includes(process.env[key]),false);
        const {config}=require(path.join(root,'build/main/config/env'));
        const previous={asr:{...config.asr},model:config.sherpa.model};
        try {
          config.sherpa.model='fixture-missing-model';
          Object.assign(config.asr,{apiKey:'',appId:'',accessToken:''});
          host.refreshSpeechCatalog();
          assert.equal(JSON.parse(await host.callTool('plugin:speech-bridge:catalog',{})).snapshot.providers.length,0);
        } finally {
          Object.assign(config.asr,previous.asr);config.sherpa.model=previous.model;host.refreshSpeechCatalog();
        }
        const original=host.speech.transcribe;
        host.speech.transcribe=async spec=>{assert.equal(spec.audio.length,32044);return {text:'adapter-result',audioSeconds:1,inferenceSeconds:0.01};};
        assert.equal(JSON.parse(await host.callTool('plugin:speech-bridge:transcribe',{})).text,'adapter-result');
        let aborted=false;
        host.speech.transcribe=(_spec,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true}));
        const controller=new AbortController();
        const pending=assert.rejects(host.callTool('plugin:speech-bridge:transcribe',{},controller.signal),{name:'AbortError'});
        await until(()=>host.plugins.get(entry.id).hostCalls.size===1,'STT RPC did not start');
        controller.abort(); await pending;
        await until(()=>aborted,'STT RPC cancellation did not reach the host');
        aborted=false;
        const unloaded=assert.rejects(host.callTool('plugin:speech-bridge:transcribe',{}),/unloaded/);
        await until(()=>host.plugins.get(entry.id).hostCalls.size===1,'Second STT RPC did not start');
        await host.unload(entry.id);await unloaded;
        await until(()=>aborted,'Unload did not abort the STT RPC');
        host.speech.transcribe=original;
      });
      await check("mandatory array/map injection reports every missing service", async () => {
        for (const [id, source] of [
          ["missing-array", "module.exports = { inject: ['privateHostService', 'tool'], apply() { throw new Error('Must not apply'); } };"],
          ["missing-map", "module.exports = { inject: { privateHostService: { port: 1 }, tool: null }, apply() { throw new Error('Must not apply'); } };"],
        ]) {
          const result = await host.load(fixture(id, source));
          assert.equal(result.status, "requires_host", JSON.stringify(result));
          assert.match(result.error, /privateHostService/);
          assert.match(result.error, /tool/);
          assert.deepEqual(host.status(id), result);
          await host.unload(id);
          assert.equal(host.status(id), undefined);
          assert.equal(host.listTools().some((tool) => tool.id.startsWith(`plugin:${id}:`)), false);
        }
      });
      await check("unsupported DSH client providers never become ready", async () => {
        const client = { client: { inject: ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-private-service"] } };
        for (const entry of [
          fixture("client-no-root", "throw new Error('Client must not execute');", { dsh: client, exports: { "./client": "./client.cjs" } }, "client.cjs"),
          fixture("client-main", "throw new Error('Client must not execute');", { dsh: client }, "client/index.cjs"),
          fixture("client-no-tools", "module.exports = { apply() {} };", { dsh: client }),
        ]) {
          const result = await host.load(entry);
          assert.equal(result.status, "requires_host", JSON.stringify(result));
          assert.match(result.error, /dsh-client-private-service/);
        }
      });
      await check("installed official Hub loads the supported locale/slot contract", async () => {
        const result = await host.load({ id: "official-hub-fixture", directory: path.dirname(require.resolve("dsh-plugin/package.json")) });
        assert.equal(result.status, "ready", JSON.stringify(result));
        assert.equal(result.panelAvailable, true);
        await host.unload("official-hub-fixture");
      });
      await check("default ESM plugin and real Cordis config validation", async () => {
        const entry = fixture("default-esm", `export default {
          inject: ["daisy"],
          Config: { "~standard": { version: 1, vendor: "fixture", validate(config) {
            return typeof config.value === "string" ? { value: config } : { issues: [{ message: "value must be a string" }] };
          } } },
          apply(ctx, config) { ctx.daisy.registerTool(${definition("echo")}, async () => config.value); }
        };`, { type: "module", exports: "./index.mjs" }, "index.mjs");
        const invalid = await host.load({ ...entry, config: { value: 123 } });
        assert.equal(invalid.status, "error");
        assert.match(invalid.error, /value must be a string/);
        assert.equal((await host.load({ ...entry, config: { value: "validated" } })).status, "ready");
        assert.equal(await host.callTool("plugin:default-esm:echo", {}), "validated");
        await host.unload(entry.id);
      });
      await check("deferred optional injections do not disable the working plugin", async () => {
        const entry = fixture("runtime-inject", `exports.apply = (ctx) => {
          ctx.daisy.registerTool(${definition("trigger")}, async () => {
            ctx.inject(["privateHostService", "tool"], () => {});
            return "triggered";
          });
        };`);
        assert.equal((await host.load(entry)).status, "ready");
        assert.equal(await host.callTool("plugin:runtime-inject:trigger", {}), "triggered");
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(host.status(entry.id)?.status, "ready");
        assert.equal(host.listTools().some((tool) => tool.id.startsWith("plugin:runtime-inject:")), true);
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
        await host.unload(entry.id);
        assert.equal(host.status(entry.id), undefined);
      });
      await check("load failures, invalid names, duplicates and per-plugin limit", async () => {
        for (const [id, source, pattern] of [
          ["import-error", "throw new Error('Import fixture failure');", /Import fixture failure/],
          ["apply-error", "exports.apply = () => { throw new Error('Apply fixture failure'); };", /Apply fixture failure/],
          ["invalid-name", `exports.apply = (ctx) => { ctx.daisy.registerTool(${definition("bad name")}, async () => ""); };`, /Tool name/],
          ["long-name", `exports.apply = (ctx) => { ctx.daisy.registerTool(${definition("x".repeat(65))}, async () => ""); };`, /Tool name/],
          ["duplicate-name", `exports.apply = (ctx) => { for (let i = 0; i < 2; i++) ctx.daisy.registerTool(${definition("same")}, async () => ""); };`, /Duplicate/],
          ["too-many", "exports.apply = (ctx) => { for (let i = 0; i < 65; i++) ctx.daisy.registerTool({ name: 't' + i, description: '', inputSchema: {} }, async () => ''); };", /64/],
        ]) {
          const result = await host.load(fixture(id, source));
          assert.equal(result.status, "error", JSON.stringify(result));
          assert.match(result.error, pattern);
          assert.deepEqual(host.status(id), result);
          assert.equal(host.listTools().some((tool) => tool.id.startsWith(`plugin:${id}:`)), false);
        }
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
      });
      await check("worker crash rejects all its calls and preserves the voice host", async () => {
        const entry = fixture("crash", `exports.apply = (ctx) => {
          ctx.daisy.registerTool(${definition("hang")}, async () => new Promise(() => {}));
          ctx.daisy.registerTool(${definition("crash")}, async () => { process.exit(41); });
        };`);
        assert.equal((await host.load(entry)).status, "ready");
        const waiting = assert.rejects(host.callTool("plugin:crash:hang", {}), /exited/);
        await assert.rejects(host.callTool("plugin:crash:crash", {}), /exited/);
        await waiting;
        assert.equal(host.listTools().some((tool) => tool.id.startsWith("plugin:crash:")), false);
        assert.equal(host.status("crash").status, "error");
        assert.match(host.status("crash").error, /exited/);
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
        assert.equal((await host.load({ ...second, id: "crash" })).status, "ready");
        await host.unload("crash");
      });
      await check("CPU-bound plugin ignoring cancellation is terminated alone", async () => {
        const entry = fixture("spin", `exports.apply = (ctx) => { ctx.daisy.registerTool(${definition("spin")}, async () => { while (true) {} }); };`);
        assert.equal((await host.load(entry)).status, "ready");
        const controller = new AbortController();
        const pending = assert.rejects(host.callTool("plugin:spin:spin", {}, controller.signal), { name: "AbortError" });
        await delay(100);
        controller.abort();
        await pending;
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
        await until(() => !host.listTools().some((tool) => tool.id === "plugin:spin:spin"), "Uncooperative worker was not killed");
      });
      await check("unload runs Cordis disposers and removes only its tools", async () => {
        await host.unload("echo-a");
        assert.equal(host.status("echo-a"), undefined);
        assert.deepEqual(host.status("echo-b"), { status: "ready" });
        assert.equal(fs.readFileSync(path.join(info.userData, "disposed.txt"), "utf8"), "disposed");
        await assert.rejects(host.callTool("plugin:echo-a:echo", {}), /unavailable/);
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
        await host.unload("echo-b");
        await host.unload("not-loaded");
      });
      await check("64-tool global limit is atomic across concurrent plugin loads", async () => {
        const bulk = "exports.apply = (ctx, config) => { for (let i = 0; i < config.count; i++) ctx.daisy.registerTool({ name: 't' + i, description: '', inputSchema: {} }, async () => 'ok'); };";
        const entries = [fixture("bulk-a", bulk), fixture("bulk-b", bulk)];
        const loaded = await Promise.all(entries.map((entry) => host.load({ ...entry, config: { count: 32 } })));
        assert.deepEqual(loaded.map((result) => result.status), ["ready", "ready"]);
        assert.equal(host.listTools().length, 64);
        const extra = fixture("extra", bulk);
        assert.match((await host.load({ ...extra, config: { count: 1 } })).error, /64 tools in total/);
        assert.equal(host.listTools().length, 64);
        await host.unload("bulk-a");
        assert.equal((await host.load({ ...extra, config: { count: 1 } })).status, "ready");
        await host.unload("bulk-b");
        await host.unload("extra");
      });
      await check("stuck unload disposer has a bounded timeout", async () => {
        const entry = fixture("unload-hang", "exports.apply = (ctx) => { ctx.effect(() => async () => new Promise(() => {})); };");
        assert.equal((await host.load(entry)).status, "ready");
        const start = Date.now();
        await host.unload(entry.id);
        assert.ok(Date.now() - start < 4_000);
      });
      await check("real request timeouts terminate blocked tool and load workers", async () => {
        assert.equal((await host.load({ ...second, config: { prefix: "B" } })).status, "ready");
        const hanging = fixture("call-timeout", `exports.apply = (ctx) => { ctx.daisy.registerTool(${definition("hang")}, async () => new Promise(() => {})); };`);
        assert.equal((await host.load(hanging)).status, "ready");
        const pending = assert.rejects(host.callTool("plugin:call-timeout:hang", {}), { name: "TimeoutError" });
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
        await pending;
        assert.equal(host.listTools().some((tool) => tool.id.startsWith("plugin:call-timeout:")), false);
        assert.match(host.status("call-timeout").error, /timed out/);
        const loading = fixture("load-timeout", `exports.apply = async (ctx) => {
          ctx.daisy.registerTool(${definition("unready")}, async () => "");
          await new Promise(() => {});
        };`);
        const result = await host.load(loading);
        assert.equal(result.status, "error");
        assert.match(result.error, /load request timed out/);
        assert.deepEqual(host.status("load-timeout"), result);
        assert.equal(host.listTools().some((tool) => tool.id.startsWith("plugin:load-timeout:")), false);
        assert.equal(await host.callTool("plugin:echo-b:echo", { text: "alive" }), "B:alive");
      });
      await check("close rejects in-flight work, prevents reload and leaves no workers", async () => {
        closeHost = new PluginHost();
        assert.equal((await closeHost.load({ ...echo, config: { prefix: "C" } })).status, "ready");
        const pending = assert.rejects(closeHost.callTool("plugin:echo-a:wait", {}), /host is closed/);
        closeHost.close();
        closeHost.close();
        await pending;
        assert.deepEqual(closeHost.listTools(), []);
        assert.equal(closeHost.status("echo-a"), undefined);
        assert.match((await closeHost.load(second)).error, /host is closed/);
        const cancelling = new PluginHost();
        const loading = cancelling.load(second);
        cancelling.close();
        assert.equal((await loading).status, "error");
      });
      console.log(`Extension host: ${assertions} isolated Electron checks passed`);
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      closeHost?.close();
      host.close();
      try { await until(() => children.size === 0, "Fixture workers did not exit", 5_000); }
      catch (error) { console.error(error); process.exitCode = 1; }
      app.exit(process.exitCode || 0);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
