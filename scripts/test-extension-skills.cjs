const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadSource(relative) {
  const filename = path.resolve(__dirname, "..", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const { SkillStore } = loadSource("src/main/extensions/skills.ts");
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "daisy-extension-skills-"));
const root = path.join(temporary, "store");

function fixture(directory, name, description = "A local fixture", content = "# Body\nPRIVATE_BODY\n") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${content}`);
}

function assertOwnTemporary(target) {
  const relative = path.relative(temporary, path.resolve(target));
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function makeDirectoryLink(target, destination) {
  try {
    fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    console.log("SKIP: directory links unavailable on this host");
    return false;
  }
}

function main() {
  const store = new SkillStore(root);
  assert.deepEqual(store.list(), []);
  const saved = store.save({ name: "My skill: quoted", description: "Line one\nLine two: detail", content: "# Markdown\nBODY_ONLY\n" });
  assert.match(saved.id, /^personal:/);
  assert.equal(saved.source, "personal");
  assert.equal(saved.readonly, false);
  assert.deepEqual(store.read(saved.id), {
    id: saved.id, name: "My skill: quoted", description: "Line one\nLine two: detail", content: "# Markdown\nBODY_ONLY\n",
  });
  assert.match(store.load(saved.id), /^---\n/);
  const duplicate = store.save({ name: saved.name, description: "duplicate", content: "SECOND" });
  assert.notEqual(duplicate.id, saved.id);
  const invalid = ["../outside", "personal:../outside", "personal:..", "personal:C:\\outside", "personal:a/b", "personal:CON", "plugin:p:../outside", "personal:a%2fb", "personal:a."];
  for (const id of invalid) {
    for (const action of [() => store.read(id), () => store.load(id), () => store.delete(id), () => store.toggle(id, false),
      () => store.save({ id, name: "Bad", description: "", content: "Bad" })]) assert.throws(action);
  }
  const before = fs.readFileSync(saved.path, "utf8");
  assert.throws(() => store.save({ id: saved.id, name: "", description: "", content: "Bad" }));
  assert.throws(() => store.save({ id: saved.id, name: "Valid", description: "", content: "x".repeat(1024 * 1024 + 1) }));
  assert.equal(fs.readFileSync(saved.path, "utf8"), before);
  store.toggle(saved.id, false);
  assert.equal(new SkillStore(root).list().find((entry) => entry.id === saved.id).enabled, false);
  assert.doesNotMatch(store.prompt(), /BODY_ONLY|SECOND/);
  assert.ok(!store.prompt().trim().split("\n").map((line) => JSON.parse(line)).some((entry) => entry.id === saved.id));
  assert.throws(() => store.load(saved.id), /disabled/);
  assert.equal(store.read(saved.id).content, "# Markdown\nBODY_ONLY\n");
  store.toggle(saved.id, true);
  assert.match(store.prompt(), /My skill/);
  assert.doesNotMatch(store.prompt(), /BODY_ONLY|SECOND/);

  const imported = path.join(temporary, "sources", "resource-skill");
  fixture(imported, "Resource skill");
  fs.mkdirSync(path.join(imported, "references"));
  fs.writeFileSync(path.join(imported, "references", "guide.md"), "Resource text");
  fs.mkdirSync(path.join(imported, "assets"));
  fs.writeFileSync(path.join(imported, "assets", "binary.dat"), Buffer.from([0, 1, 255]));
  store.importDirectory(imported);
  const resource = store.list().find((entry) => entry.name === "Resource skill");
  assert.equal(fs.readFileSync(path.join(path.dirname(resource.path), "references", "guide.md"), "utf8"), "Resource text");
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(resource.path), "assets", "binary.dat")), Buffer.from([0, 1, 255]));
  store.save({ ...store.read(resource.id), content: "Changed instructions" });
  assert.equal(fs.readFileSync(path.join(path.dirname(resource.path), "references", "guide.md"), "utf8"), "Resource text");
  store.importDirectory(imported);
  assert.equal(store.list().filter((entry) => entry.name === "Resource skill").length, 2);
  assert.match(fs.readFileSync(path.join(imported, "SKILL.md"), "utf8"), /PRIVATE_BODY/);

  const batch = path.join(temporary, "batch");
  fixture(path.join(batch, "first"), "Batch first");
  fixture(path.join(batch, "second"), "Batch second");
  store.importDirectory(batch);
  assert.equal(store.list().filter((entry) => entry.name.startsWith("Batch ")).length, 2);
  fixture(path.join(batch, "bad"), "Bad batch");
  fs.writeFileSync(path.join(batch, "bad", "SKILL.md"), "---\nname: [not, text]\n---\nInvalid");
  const beforeBadImport = store.list().length;
  assert.throws(() => store.importDirectory(batch));
  assert.equal(store.list().length, beforeBadImport, "batch validation occurs before any skill is imported");

  const plugins = path.join(temporary, "plugin-skills");
  fixture(path.join(plugins, "example"), "Plugin fixture");
  store.setPluginRoots([{ id: "fixture-plugin", root: plugins }]);
  const plugin = store.list().find((entry) => entry.source === "plugin");
  assert.equal(plugin.readonly, true);
  assert.match(store.load(plugin.id), /PRIVATE_BODY/);
  assert.throws(() => store.delete(plugin.id), /personal/);
  assert.throws(() => store.save({ ...store.read(plugin.id), content: "overwrite" }), /read-only/);
  store.toggle(plugin.id, false);
  assert.equal(store.list().find((entry) => entry.id === plugin.id).enabled, false);
  const reloaded = new SkillStore(root);
  reloaded.setPluginRoots([{ id: "fixture-plugin", root: plugins }]);
  assert.equal(reloaded.list().find((entry) => entry.id === plugin.id).enabled, false);
  const singlePlugin = path.join(temporary, "single-plugin");
  fixture(singlePlugin, "Single plugin root");
  store.setPluginRoots([{ id: "single", root: singlePlugin }]);
  assert.equal(store.list().filter((entry) => entry.source === "plugin").length, 1);
  assert.throws(() => store.setPluginRoots([{ id: "../bad", root: plugins }]));
  assert.throws(() => store.setPluginRoots([{ id: "overlap", root: path.join(root, "skills") }]));
  const packageRoot = path.join(temporary, "plugin-package");
  fixture(path.join(packageRoot, "skills", "packaged"), "Packaged skill");
  store.setPluginRoots([{ id: "dshplugin/example", root: packageRoot }, { id: "@scope/fixture", root: plugins }]);
  const packaged = store.list().find((entry) => entry.name === "Packaged skill");
  assert.ok(packaged && packaged.readonly);
  assert.match(packaged.id, /^plugin:dshplugin%2Fexample:/);
  assert.match(store.load(packaged.id), /PRIVATE_BODY/);
  const scoped = store.list().find((entry) => entry.name === "Plugin fixture");
  assert.match(scoped.id, /^plugin:%40scope%2Ffixture:/);
  assert.equal(store.read(scoped.id).name, "Plugin fixture");

  const outside = path.join(temporary, "outside");
  fixture(outside, "Outside fixture");
  const resourceLink = path.join(path.dirname(resource.path), "outside-link");
  if (makeDirectoryLink(outside, resourceLink)) {
    assert.throws(() => store.delete(resource.id), /links/);
    assert.ok(fs.existsSync(resource.path));
    assert.ok(fs.existsSync(path.join(outside, "SKILL.md")));
    fs.unlinkSync(resourceLink);
  }
  const linked = path.join(root, "skills", "linked");
  if (makeDirectoryLink(outside, linked)) {
    assert.ok(!store.list().some((entry) => entry.id === "personal:linked"));
    assert.throws(() => store.read("personal:linked"));
    assert.throws(() => store.delete("personal:linked"));
    assert.throws(() => store.importDirectory(linked));
    assert.throws(() => store.setPluginRoots([{ id: "link", root: linked }]));
    assert.match(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8"), /Outside fixture/);
    fs.unlinkSync(linked);
  }
  const badResources = path.join(temporary, "bad-resources");
  fixture(badResources, "Linked resources");
  if (makeDirectoryLink(outside, path.join(badResources, "linked"))) {
    assert.throws(() => store.importDirectory(badResources), /links/);
    fs.unlinkSync(path.join(badResources, "linked"));
  }
  const hardlink = path.join(badResources, "hardlink.md");
  fs.linkSync(path.join(outside, "SKILL.md"), hardlink);
  assert.throws(() => store.importDirectory(badResources), /file/);
  fs.unlinkSync(hardlink);
  const large = path.join(badResources, "large.dat");
  const descriptor = fs.openSync(large, "w");
  fs.ftruncateSync(descriptor, 8 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
  assert.throws(() => store.importDirectory(badResources), /resource file/);
  fs.unlinkSync(large);
  const largeBatch = path.join(temporary, "large-batch");
  fixture(largeBatch, "Total limit");
  for (let index = 0; index < 5; index++) {
    const descriptor = fs.openSync(path.join(largeBatch, `resource-${index}.dat`), "w");
    fs.ftruncateSync(descriptor, 7 * 1024 * 1024);
    fs.closeSync(descriptor);
  }
  assert.throws(() => store.importDirectory(largeBatch), /32 MiB/);
  for (let index = 0; index < 1000; index++) fs.writeFileSync(path.join(badResources, `file-${index}`), "");
  assert.throws(() => store.importDirectory(badResources), /Too many/);

  const malformed = path.join(root, "skills", "malformed");
  fixture(malformed, "Malicious YAML");
  fs.writeFileSync(path.join(malformed, "SKILL.md"), "---\nname: !!js/function 'function () { return 1; }'\n---\nBad");
  assert.ok(!store.list().some((entry) => entry.id === "personal:malformed"));
  fs.writeFileSync(path.join(malformed, "SKILL.md"), "---\nname: Duplicate\nname: Again\n---\nBad");
  assert.ok(!store.list().some((entry) => entry.id === "personal:malformed"));
  fs.writeFileSync(path.join(malformed, "SKILL.md"), "---\nname: Multiline\ndescription: |\n  First line\n  Second line\n---\nMarkdown\n");
  assert.equal(store.read("personal:malformed").description, "First line\nSecond line\n");

  for (let index = 0; index < 35; index++) store.save({ name: `Prompt ${index}`, description: "D".repeat(4000), content: `DO_NOT_INJECT_${index}` });
  const prompt = store.prompt();
  assert.ok(prompt.length <= 8000);
  assert.ok(prompt.trim().split("\n").length <= 30);
  for (const line of prompt.trim().split("\n")) {
    const meta = JSON.parse(line);
    assert.deepEqual(Object.keys(meta), ["id", "name", "description"]);
    assert.equal(store.list().find((entry) => entry.id === meta.id).enabled, true);
  }
  assert.doesNotMatch(prompt, /DO_NOT_INJECT|PRIVATE_BODY|Changed instructions/);
  store.toggle(resource.id, false);
  store.delete(resource.id);
  assert.ok(!fs.existsSync(path.dirname(resource.path)));
  assertOwnTemporary(path.join(root, "skills", "disabled.json"));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(root, "skills", "disabled.json"))).includes(resource.id));

  const previousCodexRoot = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(temporary, "codex-fixture");
  try {
    assert.throws(() => new SkillStore(path.join(process.env.CODEX_HOME, "skills", "should-not-exist")), /outside Codex/);
    assert.ok(!fs.existsSync(process.env.CODEX_HOME));
  } finally {
    if (previousCodexRoot === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexRoot;
  }
  assert.equal(fs.readdirSync(path.join(root, "skills")).filter((name) => name.startsWith(".")).length, 0);
  console.log("PASS: skill CRUD, safe YAML, persistent toggles, plugin read-only isolation, bounded metadata prompt, resource/batch import and path/link/size/count guards.");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; } finally {
  assert.ok(path.dirname(temporary) === fs.realpathSync(os.tmpdir()) && path.basename(temporary).startsWith("daisy-extension-skills-"));
  fs.rmSync(temporary, { recursive: true, force: true });
}
