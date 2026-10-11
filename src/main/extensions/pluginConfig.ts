import fs from "node:fs";
import path from "node:path";
import { readBundle, resolveBundleConfig } from "./bundle";
export { validatePluginConfig } from "./pluginConfigValidation";
import type { PluginEntry } from "../../shared/extensions";
import { speechCatalog } from "./speechService";

export function pluginDefaults(directory: string): Record<string, unknown> {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const entry = readBundle(directory).find(x => x.name === pkg.name);
  return entry?.config ? resolveBundleConfig(entry.config, directory) : {};
}

export function mediaEnvironment(application: string, userData: string): {
  config: Record<string, unknown>; dependencies: NonNullable<PluginEntry["dependencies"]>;
} {
  const executable = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const bundled = path.join(application.replace(/app\.asar(?=[/\\])?$/, "app.asar.unpacked"), "assets/bin", executable);
  const directories = (process.env.PATH || process.env.Path || "").split(path.delimiter);
  const ytDlp = [bundled, ...directories.map(dir => path.join(dir.replace(/^"|"$/g, ""), executable))].find(file => fs.existsSync(file));
  let ffmpeg = "";
  try { ffmpeg = String(require("ffmpeg-static") || "").replace(/app\.asar([/\\])/, "app.asar.unpacked$1"); } catch { /* Optional dependency. */ }
  const ffmpegReady = !!ffmpeg && fs.existsSync(ffmpeg);
  return {
    config: { outputDir: path.join(userData, "extensions/media"), ytDlpPath: ytDlp || "", ffmpegPath: ffmpegReady ? ffmpeg : "",
      proxy: "", cookiesFromBrowser: "", cookiesFile: "" },
    dependencies: [{ name: "yt-dlp", available: !!ytDlp, required: true },
      { name: "ffmpeg", available: ffmpegReady, required: true },
      { name: "speechToText（无字幕转写）", available: speechCatalog().providers.length > 0, required: false }],
  };
}
