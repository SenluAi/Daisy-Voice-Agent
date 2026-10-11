import { BrowserWindow, shell } from "electron";
import { createHash } from "node:crypto";
import type { PluginPanelEndpoint } from "./harnessServer";

export class PluginWindows {
  private windows = new Map<string, BrowserWindow>();

  async open(id: string, title: string, endpoint: PluginPanelEndpoint): Promise<void> {
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const win = new BrowserWindow({ title: `${title} - Daisy`, width: 1000, height: 760, minWidth: 680, minHeight: 500,
      show: false, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        webviewTag: false, partition: `daisy-plugin-${createHash("sha256").update(id).digest("hex")}` } });
    this.windows.set(id, win);
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (["https:", "http:"].includes(target.protocol) && !target.username && !target.password
          && new URL(win.webContents.getURL()).origin === endpoint.origin) void shell.openExternal(target.href).catch(() => {});
      } catch { /* Invalid or privileged links stay blocked. */ }
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== endpoint.origin) event.preventDefault();
    });
    win.on("closed", () => { if (this.windows.get(id) === win) this.windows.delete(id); });
    try {
      await win.loadURL(`${endpoint.origin}/_daisy/login?token=${endpoint.token}`);
      if (!win.isDestroyed()) { win.show(); win.focus(); }
    } catch (error) { win.destroy(); throw error; }
  }

  close(id?: string): void {
    for (const [key, win] of this.windows) {
      if (id && id !== key) continue;
      if (!win.isDestroyed()) win.destroy();
      this.windows.delete(key);
    }
  }
}
