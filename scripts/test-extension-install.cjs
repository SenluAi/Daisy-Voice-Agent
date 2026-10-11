const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { _electron } = require("playwright-core");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-extension-install-"));
  const cli = path.join(path.dirname(require.resolve("npm/package.json")), "bin/npm-cli.js");
  let application;
  let server;
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  };
  const fixture = (name, dependencies = {}) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      name, version: "1.0.0", main: "index.cjs", daisy: {}, dependencies,
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN','unexpected')\"" },
    }));
    fs.writeFileSync(path.join(directory, "index.cjs"), "exports.inject=['daisy']; exports.apply=ctx=>ctx.daisy.registerTool({name:'echo',description:'Echo',inputSchema:{type:'object'}},()=> 'installed');");
    return directory;
  };
  try {
    const gitDirectory = fixture("daisy-git-fixture");
    run("git", ["init", "--quiet"], gitDirectory);
    run("git", ["add", "package.json", "index.cjs"], gitDirectory);
    run("git", ["-c", "user.name=DaisyFixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], gitDirectory);
    const gitTarget = `git+${pathToFileURL(gitDirectory).href}`;
    const tarDirectory = fixture("daisy-tar-fixture");
    const tarName = JSON.parse(run(process.execPath, [cli, "pack", "--ignore-scripts", "--json"], tarDirectory))["daisy-tar-fixture"].filename;
    const archive = fs.readFileSync(path.join(tarDirectory, tarName));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
      response.end(archive);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const tarTarget = `http://127.0.0.1:${server.address().port}/fixture.tgz`;
    const transitiveDirectory = fixture("daisy-transitive-fixture", { "daisy-git-fixture": gitTarget });
    const env = { ...process.env, DAISY_EXTENSION_TEST_ROOT: root, HOME: root, USERPROFILE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: require("electron"),
      args: [path.join(__dirname, "extension-ui-fixture.cjs")], env, timeout: 30000 });
    await application.firstWindow();
    const install = async (id, target) => application.evaluate(async (_electron, input) => {
      const manager = global.extensionTestManager;
      const original = manager.catalog.target;
      manager.catalog.target = async () => ({ target: input.target });
      try { return await manager.request("installPlugin", { id: input.id }); }
      finally { manager.catalog.target = original; }
    }, { id, target });
    const verify = (snapshot, id) => {
      const plugin = snapshot.plugins.find(x => x.id === id);
      assert.equal(plugin?.status, "ready", plugin?.error);
      const state = JSON.parse(fs.readFileSync(path.join(root, "extensions/plugins.json"), "utf8"));
      const directory = state.find(x => x.id === id).directory;
      assert.equal(fs.existsSync(path.join(directory, "SCRIPT_RAN")), false);
      return directory;
    };
    const gitSnapshot = await install("fixture/git", gitTarget);
    verify(gitSnapshot, "fixture/git");
    const tarSnapshot = await install("fixture/tar", tarTarget);
    const tarInstalled = verify(tarSnapshot, "fixture/tar");
    // A confirmed tarball cannot introduce an unconfirmed Git dependency transitively.
    const transitiveTarName = JSON.parse(run(process.execPath, [cli, "pack", "--ignore-scripts", "--json"], transitiveDirectory))["daisy-transitive-fixture"].filename;
    const transitiveArchive = fs.readFileSync(path.join(transitiveDirectory, transitiveTarName));
    server.removeAllListeners("request");
    server.on("request", (_request, response) => { response.end(transitiveArchive); });
    await assert.rejects(() => install("fixture/transitive", tarTarget.replace("fixture.tgz", "transitive.tgz")), /EALLOWGIT/);
    assert.equal((await application.evaluate(() => global.extensionTestManager.snapshot())).plugins.some(x => x.id === "fixture/transitive"), false);
    assert.equal(fs.existsSync(path.join(tarInstalled, "SCRIPT_RAN")), false);
    let live;
    if (process.argv.includes("--live")) {
      live = await application.evaluate(async () => {
        const manager = global.extensionTestManager;
        const result = await manager.request("catalog", { search: "dsh-media-dock" });
        const entry = result.entries.find(x => x.repository === "lemonhall/dsh-media-dock");
        if (!entry) throw new Error("dsh-media-dock is absent from the official catalog");
        const snapshot = await manager.request("installPlugin", { id: entry.id });
        return snapshot.plugins.find(x => x.id === entry.id);
      });
      assert.equal(live.name, "dsh-media-dock");
      assert.ok(["ready", "requires_host"].includes(live.status), live.error);
      if (live.status === "requires_host") assert.match(live.error, /toolRegistry|webServer|browser host/);
    }
    console.log(JSON.stringify({ passed: true, gitInstall: true, remoteTarballInstall: true,
      installScriptsSuppressed: true, transitiveGitBlocked: true, live }));
  } finally {
    await application?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("daisy-extension-install-"));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
