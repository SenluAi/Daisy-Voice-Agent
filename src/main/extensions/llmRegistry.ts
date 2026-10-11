import type { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, type GenerateOptions } from "@deepseek-ai/dsh-llm";

/** Official DSH runtime, exposed through Daisy's existing tool dispatcher. */
export class PluginLlmRegistry {
  constructor(private root: Context) { new LlmRuntime(root); }
  service(): LlmRuntime { return this.root.get("llm")!; }
  listProviders() { return this.service().listProviders(); }
  async listModels(provider?: string) {
    if (provider) return this.service().listModels(provider);
    const result = [];
    for (const { id } of this.listProviders()) result.push(...await this.service().listModels(id));
    return result;
  }

  async generate(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; usage?: unknown }> {
    const { provider, model, prompt } = args;
    if (typeof provider !== "string" || typeof model !== "string" || typeof prompt !== "string"
      || !prompt.trim() || prompt.length > 64000) throw new Error("Specify a provider, model and nonempty prompt");
    if (signal?.aborted) throw Object.assign(new Error("Model call cancelled"), { name: "AbortError" });
    const models = await this.listModels(provider);
    if (!models.some(x => x.id === model)) throw new Error("The selected model is not advertised by this provider");
    let text = "";
    let usage: unknown;
    let finished = false;
    const options = { provider, model, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: 4096, signal } as GenerateOptions;
    for await (const chunk of this.service().stream(options)) {
      if (signal?.aborted) throw Object.assign(new Error("Model call cancelled"), { name: "AbortError" });
      if (chunk.type === "text-delta") text += chunk.text;
      if (text.length > 256000) throw new Error("Plugin model output exceeds limit");
      if (chunk.type === "usage") usage = chunk.usage;
      if (chunk.type === "finish") {
        if (chunk.reason.kind === "error") throw new Error(chunk.reason.failure.message || "Plugin model failed");
        if (chunk.reason.kind === "aborted") throw Object.assign(new Error("Model call cancelled"), { name: "AbortError" });
        if (chunk.reason.kind === "tool-calls") throw new Error("Plugin model requested unsupported tool execution");
        finished = true;
      }
    }
    if (!finished || !text.trim()) throw new Error("Plugin model did not return a completed text response");
    return { text, ...(usage ? { usage } : {}) };
  }
}
