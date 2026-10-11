import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";

/** Only the installed SandBase runtime; never inherits Daisy's model credentials. */
export class ManagedService {
  private child?: ChildProcess;
  private stopped = false;
  constructor(private root: string) {}

  async start(directory: string): Promise<{ url: string; key: string }> {
    const entry = path.join(directory, "dist/index.js");
    if (!fs.existsSync(entry)) throw new Error("SandBase 安装包缺少 dist/index.js，请安装已构建的官方包。");
    await fs.promises.mkdir(this.root, { recursive: true });
    const port = await new Promise<number>((resolve, reject) => {
      const listener = net.createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address() as net.AddressInfo;
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    if (this.stopped) throw new Error("SandBase 启动已取消。");
    const key = crypto.randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", MANAGED_AGENTS_API_KEY: key };
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = this.child = spawn(process.execPath, [entry, "start", "--host", "127.0.0.1", "--port", String(port), "--workspace", this.root],
      { cwd: this.root, env, windowsHide: true, stdio: "ignore" });
    let exited = false;
    child.once("exit", () => { exited = true; });
    child.once("error", () => { exited = true; });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 12000;
    while (!this.stopped && !exited && Date.now() < deadline) {
      try {
        // An authenticated data request proves this is our instance, not a port collision.
        const response = await fetch(`${url}/v1/agents`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1000) });
        if (response.ok && !exited && !this.stopped) return { url, key };
      } catch { /* The listener is not ready yet. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.close();
    throw new Error(exited ? "SandBase 本地服务启动失败，请检查运行依赖。" : "SandBase 本地服务启动超时。");
  }

  alive(): boolean { return !!this.child && this.child.exitCode === null && !this.stopped; }
  close(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => child.kill());
    else child.kill();
  }
}
