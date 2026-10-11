const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { _electron } = require("playwright-core");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-dsh-compat-"));
  const buildRoot = process.env.DAISY_EXTENSION_BUILD_ROOT || path.resolve(__dirname, "..");
  const screenshots = path.resolve(__dirname, `../../work/dsh-compat-${require("../package.json").version}`);
  fs.mkdirSync(screenshots, { recursive: true });
  const fixture = path.join(root, "external-plugin");
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "daisy-dsh-fixture", version: "1.0.0",
    exports: { ".": "./index.cjs", "./client": "./client.js" }, dsh: { client: { inject: ["@deepseek-ai/dsh-client-ui-sidebar-right"] } } }));
  fs.writeFileSync(path.join(fixture, "index.cjs"), `exports.inject=['tools','webServer']; exports.apply=(ctx, config)=>{
    ctx.tools.register({name:'echo',description:'DSH echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},
      output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_,v)=>[{type:'text',text:v.text}]},
      execute:args=>args.text==='invalid-output'?{}:{text:(config.prefix||'')+args.text}});
    ctx.webServer.register({kind:'exact',path:'/fixture/state',handler:(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,prefix:config.prefix||'',method:req.method}));}});
  };`);
  fs.writeFileSync(path.join(fixture, "client.js"), `window.__ModuleLoader__.load({id:'fixture',factory:require=>{
    const React=require('react');return {inject:['slots','sidebarRightTabs','sessions'],apply(ctx){
      ctx.sidebarRightTabs.register({id:'fixture:panel',kind:'fixture',title:()=> '兼容测试'});
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:'fixture:panel'},props=>React.createElement('div',null,
        React.createElement('h2',null,'真实 DSH 插件面板'),React.createElement('button',{onClick:async()=>{const ref=ctx.sessions.retain(props.sessionId);await ref.ready;await ref.binding.session.prompt([{type:'text',text:'兼容测试总结'}],'queue');ref.release();}},'发送到 Daisy'))));
    }};}});`);
  let application;
  let mediaServer;
  const stt = process.argv.includes('--stt');
  try {
    const env = { ...process.env, DAISY_EXTENSION_TEST_ROOT: root, HOME: root, USERPROFILE: root };
    if (stt) { env.HOME = os.homedir(); env.USERPROFILE = os.homedir(); }
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "extension-ui-fixture.cjs")], env, timeout: 30000 });
    const settings = await application.firstWindow();
    settings.setDefaultTimeout(30000);
    const errors = [];
    settings.on("pageerror", cause => errors.push(cause.message));
    await application.evaluate(() => {
      global.dshPrompts = [];
      global.extensionTestManager.setConversationHandler(prompt => { global.dshPrompts.push(prompt); return { ok: true, queued: true }; });
    });
    if (stt) await application.evaluate((_e, { base, cloud }) => {
      const require = global.extensionTestRequire;
      const persisted = require('dotenv').parse(require('node:fs').readFileSync(require('node:path').join(process.env.APPDATA,'Daisy/daisy.env'),'utf8'));
      const { config } = require(require('node:path').join(base,'dist/main/config/env'));
      Object.assign(config.asr, { apiKey:persisted.VOLCENGINE_API_KEY || '', appId:persisted.VOLCENGINE_APP_ID || '',
        accessToken:persisted.VOLCENGINE_ACCESS_TOKEN || '', resourceId:persisted.VOLCENGINE_RESOURCE_ID || config.asr.resourceId,
        wsUrl:persisted.VOLCENGINE_ASR_WS_URL || config.asr.wsUrl, localSherpaFirst: !cloud });
      global.extensionTestManager.host.refreshSpeechCatalog();
    }, { base:buildRoot, cloud:process.argv.includes('--cloud-stt') });
    await settings.getByRole("button", { name: "插件技能", exact: true }).click();
    await settings.getByRole("tab", { name: "已安装", exact: true }).click();
    await settings.getByRole("button", { name: "导入外部插件", exact: true }).click();
    await settings.getByRole("button", { name: "信任并选择插件", exact: true }).click();
    await settings.getByRole("heading", { name: "daisy-dsh-fixture", exact: true }).waitFor();
    const state = await application.evaluate(() => {
      const manager = global.extensionTestManager;
      const plugin = manager.snapshot().plugins.find(x => x.name === 'daisy-dsh-fixture');
      return { plugin, endpoint: manager.host.panel(plugin.id), tool: manager.host.listTools().find(x => x.name === 'echo') };
    });
    assert.equal(state.plugin.status, "ready", state.plugin.error);
    assert.equal(state.plugin.panelAvailable, true);
    const call = args => application.evaluate(async (_electron, value) => global.extensionTestManager.execute('extension_call_tool', JSON.stringify({ id:value.id,args_json:JSON.stringify(value.args) })), { id: state.tool.id, args });
    assert.equal(await call({ text: "中文工具调用" }), "中文工具调用");
    await assert.rejects(() => call({}), /Invalid tool arguments/);
    await assert.rejects(() => call({ text: "invalid-output" }), /Invalid tool output/);
    const auth = { authorization: `Bearer ${state.endpoint.token}` };
    assert.equal((await fetch(`${state.endpoint.origin}/fixture/state`)).status, 401);
    assert.equal((await fetch(`${state.endpoint.origin}/fixture/state`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${state.endpoint.origin}/fixture/state`, { headers: { ...auth, origin: "https://evil.invalid" } })).status, 403);
    assert.equal((await fetch(`${state.endpoint.origin}/fixture/state`, { headers: { ...auth, "sec-fetch-site": "same-site" } })).status, 403);
    assert.equal((await fetch(`${state.endpoint.origin}/_daisy/assets/../../package.json`, { headers: auth })).status, 404);
    const windowPromise = application.waitForEvent("window");
    await settings.getByRole("button", { name: "打开 daisy-dsh-fixture 面板", exact: true }).click();
    const panel = await windowPromise;
    panel.on("pageerror", cause => errors.push(cause.message));
    await panel.getByRole("heading", { name: "真实 DSH 插件面板", exact: true }).waitFor();
    const isolation = await panel.evaluate(() => ({ node: typeof window.require, api: typeof window.diriAPI }));
    assert.deepEqual(isolation, { node: "undefined", api: "undefined" });
    await panel.getByRole("button", { name: "发送到 Daisy", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "已加入 Daisy 对话队列" }).waitFor();
    assert.equal((await application.evaluate(() => global.dshPrompts))[0].text, "兼容测试总结");
    await panel.screenshot({ path: path.join(screenshots, "fixture-panel.png") });
    await settings.getByRole("button", { name: "配置 daisy-dsh-fixture", exact: true }).click();
    await settings.getByLabel("插件配置", { exact: true }).fill("{invalid");
    await settings.getByRole("button", { name: "保存并应用", exact: true }).click();
    await settings.getByRole("alert").last().waitFor();
    assert.equal(await call({ text: "old" }), "old");
    await settings.getByLabel("插件配置", { exact: true }).fill('{"prefix":"configured:"}');
    await settings.getByRole("button", { name: "保存并应用", exact: true }).click();
    await settings.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await call({ text: "new" }), "configured:new");
    assert.equal(panel.isClosed(), true);
    await settings.getByRole("switch", { name: "启用daisy-dsh-fixture", exact: true }).uncheck();
    await assert.rejects(() => call({ text: "disabled" }), /Unknown|unavailable/);
    await settings.getByRole("button", { name: "删除 daisy-dsh-fixture", exact: true }).click();
    await settings.getByRole("button", { name: "删除", exact: true }).click();
    await settings.getByRole("heading", { name: "daisy-dsh-fixture", exact: true }).waitFor({ state: "hidden" });
    const clientOnly = path.join(root, 'client-only');
    fs.mkdirSync(clientOnly);
    fs.writeFileSync(path.join(clientOnly,'package.json'),JSON.stringify({name:'daisy-client-only',version:'1.0.0',
      exports:{'./client':'./client.js'},dsh:{client:{inject:['@deepseek-ai/dsh-client-ui-sidebar-right']}}}));
    fs.copyFileSync(path.join(fixture,'client.js'),path.join(clientOnly,'client.js'));
    await application.evaluate(async(_e,directory)=>global.extensionTestManager.install('fixture/client-only',directory),clientOnly);
    const clientState = await application.evaluate(()=>global.extensionTestManager.snapshot().plugins.find(x=>x.id==='fixture/client-only'));
    assert.equal(clientState.status,'ready',clientState.error);
    assert.equal(clientState.toolCount,0);
    const clientWindowPromise = application.waitForEvent('window');
    await application.evaluate(async()=>global.extensionTestManager.request('openPluginPanel',{id:'fixture/client-only'}));
    const clientPanel = await clientWindowPromise;
    await clientPanel.getByRole('heading',{name:'真实 DSH 插件面板',exact:true}).waitFor();
    await application.evaluate(async()=>global.extensionTestManager.request('deletePlugin',{id:'fixture/client-only'}));
    assert.equal(clientPanel.isClosed(),true);
    let mediaResult;
    if (process.argv.includes("--media")) {
      const ffmpeg = require("ffmpeg-static");
      const video = path.join(root, "video.mp4");
      let videoArgs = ['-y','-f','lavfi','-i','color=c=blue:s=320x180:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-shortest','-c:v','libx264','-c:a','aac',video];
      if (stt) {
        const speech = path.join(root,'speech.mp3');
        const { EdgeTTS } = require('node-edge-tts');
        await new EdgeTTS({voice:'zh-CN-XiaoxiaoNeural'}).ttsPromise('会议讨论发布清单和测试计划。大家完成文档，截止时间是周五。',speech);
        videoArgs = ['-y','-f','lavfi','-i','color=c=blue:s=320x180:d=60','-i',speech,'-filter_complex',
          '[1:a]aresample=16000,asplit[a][b];[a]apad=pad_dur=3[first];[first][b]concat=n=2:v=0:a=1[audio]',
          '-map','0:v','-map','[audio]','-shortest','-c:v','libx264','-c:a','aac',video];
      }
      const generated = spawnSync(ffmpeg, videoArgs, { windowsHide:true,timeout:30000,encoding:'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.900\nThe meeting covered a release checklist, documentation, and a test plan. Alice owns documentation. Ben will run regression tests. The deadline is Friday.\n";
      mediaServer = http.createServer((req,res) => {
        if (req.url === '/video.mp4') { res.writeHead(200,{'content-type':'video/mp4'}); res.end(fs.readFileSync(video)); }
        else if (req.url === '/captions.vtt') { res.writeHead(200,{'content-type':'text/vtt'}); res.end(vtt); }
        else { res.writeHead(200,{'content-type':'text/html'}); res.end(`<html><head><title>Daisy Compatibility Meeting</title></head><body><video src="/video.mp4" controls>${stt ? '' : '<track kind="subtitles" src="/captions.vtt" srclang="en" label="English">'}</video></body></html>`); }
      });
      await new Promise(resolve => mediaServer.listen(0,"127.0.0.1",resolve));
      const media = await application.evaluate(async () => {
        const manager = global.extensionTestManager;
        const catalog = await manager.request('catalog',{search:'dsh-media-dock'});
        const entry = catalog.entries.find(x=>x.repository==='lemonhall/dsh-media-dock');
        if (!entry) throw new Error('Media dock absent from official catalog');
        await manager.request('installPlugin',{id:entry.id});
        return { id:entry.id, endpoint:manager.host.panel(entry.id), tool:manager.host.listTools().find(x=>x.name==='media_panel'), plugin:manager.snapshot().plugins.find(x=>x.id===entry.id) };
      });
      assert.equal(media.plugin.status,'ready',media.plugin.error);
      assert.ok(media.tool);
      const mediaAuth = { authorization:`Bearer ${media.endpoint.token}` };
      const toolCall = args => application.evaluate(async (_e,value) => global.extensionTestManager.execute('extension_call_tool',JSON.stringify({id:value.id,args_json:JSON.stringify(value.args)})),{id:media.tool.id,args});
      const mediaWindowPromise = application.waitForEvent('window');
      await application.evaluate(async (_e,id)=>global.extensionTestManager.request('openPluginPanel',{id}),media.id);
      const mediaPanel = await mediaWindowPromise;
      mediaPanel.on('pageerror',cause=>errors.push(cause.message));
      await mediaPanel.getByRole('tab',{name:/媒体台/}).waitFor();
      await mediaPanel.locator('input').first().waitFor();
      await mediaPanel.screenshot({path:path.join(screenshots,'media-panel.png')});
      const status = await toolCall({action:'status'});
      assert.match(status,/媒体|STT|yt-dlp|转写/);
      if (stt) {
        assert.match(status,/STT：可用/); assert.match(status,/maxDurationSeconds=120/);
        assert.match(status,process.argv.includes('--cloud-stt') ? /选中：火山 ASR/ : /选中：Sherpa/);
      }
      await toolCall({action:'add',url:`http://127.0.0.1:${mediaServer.address().port}/index.html`});
      const deadline = Date.now()+90000;
      let item;
      while(Date.now()<deadline) {
        const payload = await fetch(`${media.endpoint.origin}/dsh-media/state`,{headers:mediaAuth}).then(response=>response.json());
        item = payload.items[0];
        if(item?.transcript) break;
        if(item?.status==='error') throw new Error(item.error || item.note);
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      assert.ok(item?.transcript,'Real yt-dlp subtitle pipeline did not produce a transcript');
      const transcript = await toolCall({action:'read',id:item.id});
      if (stt) {
        assert.equal(item.transcriptSource,'stt');
        assert.match(transcript,/测试|计划/);
        assert.match(transcript,/周五/);
        assert.ok((item.transcript.match(/会议/g) || []).length >= 2,'File ASR ended before speech after the long pause');
      } else assert.match(transcript,/Alice/);
      let summary;
      if(process.argv.includes('--llm')) {
        await application.evaluate(async (_e,base) => {
          const require = global.extensionTestRequire;
          const dotenv = require('dotenv');
          const fs = require('node:fs');
          const path = require('node:path');
          const persisted = dotenv.parse(fs.readFileSync(path.join(process.env.APPDATA,'Daisy/daisy.env'),'utf8'));
          const { config } = require(path.join(base,'dist/main/config/env'));
          Object.assign(config.llm,{apiKey:persisted.DEEPSEEK_API_KEY,baseUrl:persisted.DEEPSEEK_BASE_URL,model:persisted.DEEPSEEK_MODEL});
          if(!config.llm.apiKey) throw new Error('No configured model key; cannot verify real summary');
          const { DeepSeekClient } = require(path.join(base,'dist/main/llm/deepseek'));
          const { PluginConversationQueue } = require(path.join(base,'dist/main/extensions/conversationQueue'));
          global.dshSummary = null; global.dshSummaryError = null; let busy = false;
          global.dshQueue = new PluginConversationQueue(()=>!busy, prompt=>{
            busy=true; const client = new DeepSeekClient([]); global.dshClient=client;
            client.once('done',answer=>{global.dshSummary=answer.display;busy=false;});
            client.once('error',cause=>{global.dshSummaryError=String(cause);busy=false;});
            void client.sendMessage(prompt.text+'\n只读取上述媒体台条目的字幕并用简短中文总结，不执行文件或桌面操作。');
          });
          global.extensionTestManager.setConversationHandler(prompt=>global.dshQueue.enqueue(prompt),id=>global.dshQueue.cancel(id));
        },buildRoot);
      }
      await mediaPanel.getByText(item.title,{exact:true}).first().click();
      await mediaPanel.getByRole('button',{name:/让 Agent 总结/}).first().click();
      if(process.argv.includes('--llm')) {
        const end=Date.now()+120000;
        while(Date.now()<end) {
          const result = await application.evaluate(()=>({summary:global.dshSummary,error:global.dshSummaryError}));
          if(result.error) throw new Error(result.error);
          if(result.summary) { summary=result.summary;break; }
          await new Promise(resolve=>setTimeout(resolve,500));
        }
        assert.ok(summary && summary.length>30,'Real model did not complete the video summary');
        assert.match(summary,/[\u4e00-\u9fff]/);
        assert.match(summary,/文档|文件|测试|周五|星期五/);
      } else await mediaPanel.getByRole('status').filter({hasText:'已加入 Daisy 对话队列'}).waitFor();
      await mediaPanel.screenshot({path:path.join(screenshots,'media-summary.png')});
      await application.evaluate(({BrowserWindow}, origin)=>{BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith(origin)).setSize(720,650);}, media.endpoint.origin);
      await mediaPanel.waitForFunction(()=>innerWidth<730);
      await mediaPanel.screenshot({path:path.join(screenshots,'media-720.png')});
      assert.ok(await mediaPanel.evaluate(()=>document.body.scrollWidth<=innerWidth+2));
      const mediaClosed = mediaPanel.waitForEvent('close');
      await application.evaluate(async(_e,id)=>global.extensionTestManager.request('togglePlugin',{id,enabled:false}),media.id);
      await mediaClosed;
      assert.equal(mediaPanel.isClosed(),true);
      await assert.rejects(()=>toolCall({action:'list'}),/Unknown|unavailable/);
      mediaResult={realRepository:true,actualClient:true,downloadedFixtureVideo:true,extractedSubtitles:!stt,
        realFileTranscription:stt,selectedProvider:stt ? (status.match(/选中：([^\n]+)/)||[])[1] : undefined,
        transcript:stt ? item.transcript : undefined,realModelSummary:!!summary,summary};
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,dshToolValidation:true,authenticatedRoutes:true,sandboxedPanel:true,clientOnlyPanel:true,conversationBridge:true,configLifecycle:true,disableAndUninstall:true,media:mediaResult,screenshots}));
  } catch(cause) {
    if(application) for(const [index,page] of (await application.windows()).entries()) await page.screenshot({path:path.join(screenshots,`failure-${index}.png`)}).catch(()=>{});
    throw cause;
  } finally {
    if(application) await application.evaluate(()=>{global.dshClient?.abort();global.dshQueue?.close();}).catch(()=>{});
    if(application) await application.evaluate(()=>global.extensionTestManager?.close()).catch(()=>{});
    await application?.close();
    if(mediaServer) await new Promise(resolve=>mediaServer.close(resolve));
    const target=path.resolve(root);
    assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('daisy-dsh-compat-'));
    await fs.promises.rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
})().catch(cause=>{console.error(cause);process.exitCode=1;});
