import crypto from "node:crypto";

export interface PluginPrompt { pluginId: string; text: string }

// Plugin prompts wait their turn; they never cancel microphone capture or the current task.
export class PluginConversationQueue {
  private pending: (PluginPrompt & { id: string })[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private canRun: () => boolean, private run: (prompt: PluginPrompt) => void,
    private onError: (error: unknown) => void = () => {}) {}

  enqueue(prompt: PluginPrompt): { ok: true; id: string; queued: true } {
    if (this.closed) throw new Error("插件对话队列已关闭。");
    if (!prompt.text.trim() || prompt.text.length > 64000) throw new Error("插件对话内容为空或超过长度限制。");
    if (this.pending.length >= 10) throw new Error("插件对话队列已满，请等待当前请求完成。");
    const id = crypto.randomUUID();
    this.pending.push({ ...prompt, id });
    this.schedule();
    return { ok: true, id, queued: true };
  }

  cancel(pluginId?: string): void {
    this.pending = pluginId ? this.pending.filter(x => x.pluginId !== pluginId) : [];
    if (!this.pending.length && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  close(): void { this.closed = true; this.cancel(); }

  private schedule(): void {
    if (this.timer || this.closed || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed && this.canRun()) {
        const prompt = this.pending.shift();
        if (prompt) { try { this.run(prompt); } catch (error) { this.onError(error); } }
      }
      this.schedule();
    }, 250);
    this.timer.unref();
  }
}
