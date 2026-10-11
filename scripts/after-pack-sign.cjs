const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The paid build is distributed without an Apple Developer certificate.
 * Sign every bundled executable ad-hoc so macOS can verify that the bundle
 * was not modified after packing. Developer ID notarization is deliberately
 * not claimed here: it requires the vendor's paid Apple Developer membership.
 */
exports.default = async function afterPack(context) {
  // Preserve npm's bundled dependency tree: the normal packer prunes nested node_modules.
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const installer = path.join(resources, "plugin-installer", "npm");
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  fs.cpSync(path.dirname(require.resolve("npm/package.json")), installer, { recursive: true });
  if (!fs.existsSync(path.join(installer, "node_modules", "graceful-fs", "package.json"))) {
    throw new Error("The bundled plugin installer is missing its dependencies");
  }
  // npm installs peer packages locally, but the release collector can omit them.
  const asar = require("@electron/asar");
  for (const name of ["dsh-llm", "dsh-commands", "dsh-credentials", "dsh-attachment", "dsh-scope", "dsh-session"]) {
    try { asar.extractFile(path.join(resources, "app.asar"), path.join("node_modules", "@deepseek-ai", name, "package.json")); }
    catch { throw new Error(`The plugin host release is missing its runtime dependency: @deepseek-ai/${name}`); }
  }
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`Cannot ad-hoc sign missing app bundle: ${appPath}`);
  }

  // `--deep` only signs recognised nested bundles. MacKeyServer is an
  // executable resource in app.asar.unpacked, so leaving it to `--deep`
  // produces an unsigned keyboard-event helper in the shipped app.
  const keyServerPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-global-key-listener",
    "bin",
    "MacKeyServer",
  );
  if (!fs.existsSync(keyServerPath)) {
    throw new Error(`Cannot sign missing global-shortcut helper: ${keyServerPath}`);
  }

  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", keyServerPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", keyServerPath], {
    stdio: "inherit",
  });

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
};
