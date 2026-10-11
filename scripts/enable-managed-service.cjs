const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.join(process.env.APPDATA, "Daisy");
const file = path.join(root, "extensions/plugins.json");
const config = path.join(root, "daisy.env");
const hash = () => crypto.createHash("sha256").update(fs.readFileSync(config)).digest("hex");
const before = hash();
const entries = JSON.parse(fs.readFileSync(file, "utf8"));
const entry = entries.find(x => x.id === "sandbaseai/sandbase-harness" && x.name === "managed-agents");
if (!entry) throw new Error("Installed SandBase plugin not found");
const relative = path.relative(fs.realpathSync(path.join(root, "extensions/plugins")), fs.realpathSync(entry.directory));
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid installed plugin path");
for (const target of ["dist/index.js", "dist/mcp/index.js"]) {
  if (!fs.existsSync(path.join(entry.directory, target))) throw new Error("SandBase build missing");
}
// The user explicitly approved automatic startup; preserve every other setting.
entry.config = { ...entry.config, autoStart: true };
fs.writeFileSync(`${file}.tmp`, JSON.stringify(entries, null, 2));
fs.renameSync(`${file}.tmp`, file);
if (hash() !== before) throw new Error("Voice/model configuration unexpectedly changed");
console.log("SandBase automatic startup enabled; Daisy voice/model configuration unchanged.");
