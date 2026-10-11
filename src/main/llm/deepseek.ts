import { EventEmitter } from "node:events";
import fs from "node:fs";
import { nativeImage } from "electron";
import { config } from "../config/env";
import { availableTools, ToolCall, ToolResult } from "./tools";
import { SYSTEM_PROMPT } from "./system-prompt";
import { log } from "../utils/logger";
import { recordToolMemory } from "../memory/shortTermMemory";
import { VisualTaskRuntime } from "../automation/visualTaskRuntime";
import { requestsManualAuthentication } from "../automation/authHandoff";
import { buildModelCorrectionPrompt, createErrorEnvelope, ErrorEnvelope, isErrorEnvelopeText, serializeErrorEnvelope } from "../automation/errorEnvelope";
import { StallDecision } from "../automation/stallPolicy";
import { TaskOutcome } from "../automation/taskStateMachine";
import { MAX_TASK_ROUNDS, TASK_ROUND_LIMIT_MESSAGE, describeToolOutcome, describeStepProgress, summarizeTaskProgress } from "../automation/taskReporting";
import { waitForModelIO } from "../automation/modelWait";
import { extensionPrompt, getExtensionManager } from "../extensions/manager";
import { requireLicenseAccess } from "../license/access";

const SILENT_ACTION_TOOLS = new Set([
  "screen_snapshot",
  "open_application",
  "quit_application",
  "quit_all_applications",
  "open_url",
  "type_text",
  "press_keys",
  "create_note",
  "create_reminder",
  "create_calendar_event",
  "set_timer",
  "set_alarm",
  "write_file",
  "create_file",
  "delete_file",
  "list_directory",
  "read_file",
  "read_selected_text",
  "get_frontmost_application",
  "search_notes",
  "get_calendar_events",
  "switch_audio_output",
  "trim_video",
  "convert_video",
  "convert_document",
  "office_document",
  "edit_pdf",
  "scrape_url",
  "get_clipboard_text",
  "copy_file_to_clipboard",
  "open_contact_chat",
  "stage_file_attachment",
  "focus_application_search",
  "select_application_search_result",
  "confirm_staged_attachment",
  "desktop_click"
]);

const INSPECTION_TOOLS = new Set([
  "screen_snapshot",
  "diagnose_application",
  "list_directory",
  "read_file",
  "read_selected_text",
  "get_frontmost_application",
  "search_notes",
  "get_calendar_events",
  "convert_document",
  "office_document",
  "scrape_url",
  "get_clipboard_text"
]);

const MAX_CALLS_PER_TOOL = 8;

const IMPORTANT_PROGRESS_TOOLS = new Set([
  "open_url", "open_application", "quit_application", "quit_all_applications",
  "open_contact_chat", "select_application_search_result", "type_text",
  "desktop_click", "desktop_double_click", "desktop_scroll", "desktop_drag",
  "stage_file_attachment", "confirm_staged_attachment", "write_file", "create_file", "delete_file",
  "office_document", "convert_document", "edit_pdf", "download_media", "trim_video", "convert_video",
  "create_note", "create_reminder", "create_calendar_event", "send_email",
  "set_timer", "set_alarm", "switch_audio_output", "web_search",
]);

const CONTINUE_AFTER_TOOLS = new Set([
  "office_document",
  "write_file",
  "create_file",
  "convert_document",
  "edit_pdf",
  "copy_file_to_clipboard"
]);

function maxCallsForTool(name: string): number {
  // Script debugging and the shared plugin dispatcher use the task-wide budget.
  if (name === "run_shell_command" || name === "extension_call_tool") return MAX_TASK_ROUNDS;
  return CONTINUE_AFTER_TOOLS.has(name) ? 20 : MAX_CALLS_PER_TOOL;
}

function screenshotPaths(results: ToolResult[]): string[] {
  return results.flatMap((result) => {
    let text = result.content;
    if (isErrorEnvelopeText(text)) {
      try {
        const envelope = JSON.parse(text) as ErrorEnvelope;
        text = `${envelope.error.message}\n${envelope.error.details?.automationFeedback || ""}`;
      } catch { /* Keep the original result if it cannot be decoded. */ }
    }
    return [...text.matchAll(/截图：([^\r\n]+?\.png)(?:\r?\n|$)/gi)].map((match) => match[1].trim());
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

type ImageDetail = "auto" | "low" | "high";

type ChatRequestContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: ImageDetail } }
    >;

type ChatRequestMessage = Omit<ChatMessage, "content"> & {
  content: ChatRequestContent;
};

type StreamChatOptions = {
  allowTools?: boolean;
  repairedRequest?: boolean;
  imageFallback?: boolean;
  outputRepairAttempts?: number;
};

function sanitizeModelText(text: string, normalizeBackslashes: boolean): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  return normalizeBackslashes ? cleaned.replace(/\\/g, "/") : cleaned;
}

export interface DualChannel {
  speech: string;
  display: string;
}

/**
 * 统一的 TTS 文本清洗函数。
 * 去除 Markdown 符号、emoji、特殊字符，替换为 TTS 可朗读的形式。
 * 所有进入 TTS 的文本必须经过此函数清洗。
 */
export function cleanTextForTTS(text: string): string {
  return text
    .replace(/<display>[\s\S]*?<\/display>/gi, "")
    .replace(/<\/?display>/gi, "")
    .replace(/<\/?speech>/gi, "")
    .replace(/\{"display"\s*:\s*"?/g, "")
    .replace(/"speech"\s*:\s*"?/g, "")
    .replace(/"\s*\}/g, "")
    .replace(/\\n/g, " ")
    .replace(/\\["\\/]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*#_|]/g, "") // Keep ~
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2702}\u{2705}\u{2708}-\u{270F}\u{2764}\u{2763}\u{00A9}\u{00AE}\u{2122}\u{200D}\u{FE0F}]/gu, "")
    .replace(/℃/g, "度")
    .replace(/°C/g, "度")
    .replace(/°/g, "度")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 协议解析器 —— 极速单通道模式：
 * display 为大模型输出的原始文本（可含 Markdown）
 * speech 为自动经过 cleanTextForTTS 过滤清洗后的纯文本，用于合成语音
 */
function parseDualChannel(text: string): DualChannel {
  // 兼容性清洗：防范历史遗留会话里可能带有的标签，进行剥离
  const display = text.replace(/<display>[\s\S]*?<\/display>/gi, "").replace(/<\/?display>/gi, "").replace(/<\/?speech>/gi, "").trim() || text;
  const speech = cleanTextForTTS(text);
  return { display, speech };
}

export class DeepSeekClient extends EventEmitter {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private conversation: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private aborted = false;
  private toolCallCounts = new Map<string, number>();
  private chatLoopCount = 0;
  private commandExecutionCounts = new Map<string, number>();
  private originalUserRequest = "";
  private visualTask = new VisualTaskRuntime();
  private taskConversationBase: ChatMessage[] = [];
  private pendingLoopDecision: StallDecision | null = null;
  private pendingNeedsUserMessage = "";
  private lastToolResults: ToolResult[] = [];
  private authHandoffReviewed = false;
  private progressActionCount = 0;
  private pendingImportantProgress: string | undefined;
  private screenshotCache: { path: string; mtimeMs: number; dataUrl: string; width: number; height: number } | null = null;
  private attachmentFlow = {
    staged: false,
    pasted: false,
    confirmed: false,
    correctionCount: 0,
  };

  constructor(existingMessages?: ChatMessage[]) {
    super();
    this.apiKey = config.llm.apiKey;
    const configuredBaseUrl = config.llm.baseUrl.replace(/\/+$/, "");
    this.baseUrl = /\/v1$/i.test(configuredBaseUrl) ? configuredBaseUrl : `${configuredBaseUrl}/v1`;
    this.model = config.llm.model;
    this.conversation = existingMessages && existingMessages.length > 0
      ? [...existingMessages]
      : [{ role: "system", content: SYSTEM_PROMPT }];
  }

  getConversation(): ChatMessage[] {
    return this.conversation;
  }

  abort(): void {
    this.aborted = true;
    this.progressActionCount = 0;
    this.pendingImportantProgress = undefined;
    this.visualTask.abort();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.removeAllListeners();
  }



  async sendMessage(text: string, historyText?: string): Promise<void> {
    requireLicenseAccess();
    this.aborted = false;
    this.chatLoopCount = 0;
    this.commandExecutionCounts.clear();
    this.originalUserRequest = this.resolveTaskRequest(text);
    this.pendingLoopDecision = null;
    this.pendingNeedsUserMessage = "";
    this.lastToolResults = [];
    this.progressActionCount = 0;
    this.pendingImportantProgress = undefined;
    this.screenshotCache = null;
    this.toolCallCounts.clear();
    this.authHandoffReviewed = false;
    this.resetAttachmentFlow();
    this.visualTask.start(this.originalUserRequest);
    if (!this.apiKey) {
      this.finishTask("needs_user", "缺少 DeepSeek API Key");
      this.emit("error", "缺少 DeepSeek API Key");
      return;
    }

    this.taskConversationBase = [...this.conversation];
    const userHistoryText = historyText?.trim() || text;
    this.conversation.push({ role: "user", content: userHistoryText });
    const requestMessages: ChatRequestMessage[] = [
      ...this.conversation.slice(0, -1),
      { role: "user", content: text },
    ];

    try {
      await this.streamChat(requestMessages);
    } catch (error) {
      if (this.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.finishTask("difficult", message);
      this.emit("error", message);
    }
  }

  async sendImageMessage(text: string, imageDataUrl: string, historyText?: string): Promise<void> {
    requireLicenseAccess();
    this.aborted = false;
    this.chatLoopCount = 0;
    this.commandExecutionCounts.clear();
    this.originalUserRequest = this.resolveTaskRequest(text);
    this.pendingLoopDecision = null;
    this.pendingNeedsUserMessage = "";
    this.lastToolResults = [];
    this.progressActionCount = 0;
    this.pendingImportantProgress = undefined;
    this.screenshotCache = null;
    this.toolCallCounts.clear();
    this.authHandoffReviewed = false;
    this.resetAttachmentFlow();
    this.visualTask.start(this.originalUserRequest);
    if (!this.apiKey) {
      this.finishTask("needs_user", "缺少 DeepSeek API Key");
      this.emit("error", "缺少 DeepSeek API Key");
      return;
    }

    this.taskConversationBase = [...this.conversation];
    const userHistoryText = historyText?.trim() || text;
    this.conversation.push({ role: "user", content: userHistoryText });

    const requestMessages: ChatRequestMessage[] = [
      ...this.conversation.slice(0, -1),
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      },
    ];

    try {
      log(`DeepSeekClient: sending image message (${imageDataUrl.length} data-url chars)`);
      await this.streamChat(requestMessages, { allowTools: false });
    } catch (error) {
      if (this.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.finishTask("difficult", message);
      this.emit("error", message);
    }
  }

  private resolveTaskRequest(text: string): string {
    const lastMessage = this.conversation[this.conversation.length - 1];
    const context = this.conversation[this.conversation.length - 2];
    if (!/^(?:请)?继续执行[。！!\s]*$/.test(text.trim())
      || lastMessage?.role !== "assistant" || !lastMessage.content.startsWith(TASK_ROUND_LIMIT_MESSAGE)
      || context?.role !== "user") return text;
    const match = context.content.match(/^【任务达到轮数上限，等待用户继续】原始目标：([^\r\n]+)\r?\n最近结果：/);
    if (!match) return text;
    try {
      const request = JSON.parse(match[1]);
      return typeof request === "string" && request.trim() ? request : text;
    } catch { return text; }
  }

  private async streamChat(
    messages: ChatRequestMessage[],
    options: StreamChatOptions = {},
  ): Promise<void> {
    if (this.aborted) {
      log(`DeepSeekClient: streamChat called but client is aborted. Exiting.`);
      return;
    }
    if (this.chatLoopCount >= MAX_TASK_ROUNDS) {
      log(`DeepSeekClient: Absolute safety guard triggered (count=${this.chatLoopCount}). Forcing break.`);
      const summary = summarizeTaskProgress(this.visualTask.state.snapshot().steps);
      const message = `${TASK_ROUND_LIMIT_MESSAGE}${summary ? ` 最近结果：${summary}。原任务尚未确认完成。` : "原任务尚未确认完成。"}`;
      this.finishTask("difficult", message);
      // Keep the goal near the end of history so trimming does not lose it on resume.
      this.conversation.push({
        role: "user",
        content: `【任务达到轮数上限，等待用户继续】原始目标：${JSON.stringify(this.originalUserRequest)}\n最近结果：${summary || "尚无可核实的操作结果"}。用户说继续执行后，从最新界面及已完成步骤继续，不要重复已完成操作。`,
      });
      const parsed = parseDualChannel(message);
      this.conversation.push({ role: "assistant", content: parsed.display });
      this.emit("done", parsed);
      return;
    }
    this.chatLoopCount++;
    const allowTools = options.allowTools !== false;
    const allowedTools = allowTools
      ? availableTools.filter(
          t => (this.toolCallCounts.get(t.function.name) || 0) < (
            this.visualTask.isVisualAction(t.function.name) || INSPECTION_TOOLS.has(t.function.name)
              ? MAX_TASK_ROUNDS : maxCallsForTool(t.function.name)
          )
        )
      : [];
    if (allowTools && allowedTools.length === 0) {
      log(`DeepSeekClient: all tools reached max calls, forcing final answer`);
    }
    this.abortController = new AbortController();
    const controller = this.abortController;
    const automationTurn = this.visualTask.state.snapshot().steps.length > 0 || this.toolCallCounts.size > 0 || this.lastToolResults.length > 0;
    const modelStartedAt = Date.now();
    const requestMessages = this.sanitizeRequestMessages(messages, false);
    const extensionContext = extensionPrompt();
    if (extensionContext && requestMessages[0]?.role === "system" && typeof requestMessages[0].content === "string") {
      requestMessages[0] = { ...requestMessages[0], content: requestMessages[0].content + extensionContext };
    }
    const request = () => fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: requestMessages,
        stream: true,
        max_tokens: 8192,
        tools: allowedTools.length > 0 ? allowedTools : undefined,
        tool_choice: allowedTools.length > 0 ? "auto" : "none",
        thinking: {
          type: config.llm.thinkingEnabled ? "enabled" : "disabled"
        },
        ...(config.llm.thinkingEnabled ? {
          reasoning_effort: config.llm.reasoningEffort,
          reasoningeffort: config.llm.reasoningEffort
        } : {})
      }),
      signal: controller.signal,
    });
    const response = automationTurn ? await waitForModelIO(request, controller, 60_000) : await request();

    if (!response.ok) {
      const body = automationTurn
        ? await waitForModelIO(() => response.text(), controller, 45_000)
        : await response.text();
      const malformedContext = /parse the request body|unexpected end of (?:hex|unicode) escape|invalid (?:json|escape)/i.test(body);
      if (malformedContext && !options.repairedRequest) {
        log(`DeepSeekClient: malformed context rejected (${response.status}); repairing text and retrying once`);
        await this.streamChat(this.sanitizeRequestMessages(messages, true), {
          ...options,
          repairedRequest: true,
        });
        return;
      }
      if (!options.imageFallback && [400, 415, 422].includes(response.status)
        && /image|vision|multimodal|图片|图像/i.test(body)
        && messages.some((message) => Array.isArray(message.content) && message.content.some((item) => item.type === "image_url"))) {
        log(`DeepSeekClient: vision context rejected (${response.status}); stopping GUI actions`);
        const message = "当前模型接口不支持读取截图，已暂停视觉操作；请配置支持图像的推理模型。";
        this.finishTask("needs_user", message);
        await this.streamChat([
          ...this.stripImageContent(messages),
          { role: "user", content: `${message} 不得猜测画面或声称任务成功，只简短说明当前障碍。` },
        ], { ...options, allowTools: false, imageFallback: true });
        return;
      }
      throw new Error(`DeepSeek API 错误 ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("DeepSeek 返回空响应体");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let assistantContent = "";
    let assistantReasoningContent = "";
    const toolCalls: ToolCall[] = [];
    const indexedToolCalls = new Map<number, ToolCall>();
    let streamCompleted = false;
    let finishReason = "";
    let modelProgressAt = Date.now();
    let toolAckEmitted = false;

    try {
      stream: while (true) {
        if (this.aborted) return;
        const { done, value } = automationTurn
          ? await waitForModelIO(() => reader.read(), controller, Math.max(1, 45_000 - (Date.now() - modelProgressAt)))
          : await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            streamCompleted = true;
            break stream;
          }

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
              streamCompleted = true;
            }
            const delta = choice?.delta;
            if (!delta) {
              if (streamCompleted) break stream;
              continue;
            }
            if (delta.content || delta.reasoning_content || delta.tool_calls?.length) modelProgressAt = Date.now();
            if (delta.content) assistantContent += delta.content;
            if (delta.reasoning_content) assistantReasoningContent += delta.reasoning_content;

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                // Tool argument fragments can be interleaved; never append to the wrong action.
                let existing = typeof tc.index === "number" ? indexedToolCalls.get(tc.index)
                  : tc.id ? toolCalls.find((t) => t.id === tc.id)
                  : toolCalls.length === 1 ? toolCalls[0] : undefined;
                if (!existing) {
                  existing = { id: tc.id || "", function: { name: "", arguments: "" } };
                  toolCalls.push(existing);
                  if (typeof tc.index === "number") indexedToolCalls.set(tc.index, existing);
                }
                if (tc.id) existing.id = tc.id;
                existing.function.arguments += tc.function?.arguments || "";
                if (tc.function?.name && tc.function.name !== existing.function.name) existing.function.name += tc.function.name;
              }
            }
          } catch {
            // Invalid/incomplete assembled calls are rejected before tool execution.
          }
          if (streamCompleted) break stream;
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (automationTurn) log(`[task-perf] model round=${this.chatLoopCount} elapsedMs=${Date.now() - modelStartedAt}`);

    // Check if aborted during streaming
    if (this.aborted) return;
    if (!streamCompleted) throw new Error("模型响应中途断开，未执行本轮动作；请重新执行任务。");
    if (finishReason && !["stop", "tool_calls", "function_call"].includes(finishReason)) {
      throw new Error(`模型响应未完整结束（${finishReason}），未执行本轮动作。`);
    }

    const disabledTool = toolCalls.find((tc) => !allowedTools.some((tool) => tool.function.name === tc.function.name));
    const quotaExceeded = allowTools && disabledTool && availableTools.some((tool) => tool.function.name === disabledTool.function.name);
    const outputError = disabledTool
      ? createErrorEnvelope("model", "invalid_output", quotaExceeded ? "TOOL_CALL_LIMIT_REACHED" : "TOOL_NOT_ALLOWED",
        quotaExceeded ? `工具 ${disabledTool.function.name} 已达到本任务调用次数上限，不是权限问题，用户放行不能重置额度。`
          : `工具 ${disabledTool.function.name} 不在本回合可用列表中。`,
        { retryable: true, correction: allowTools
          ? "选择当前提供的其他工具或简短说明真实障碍；不得把工具额度或格式错误说成权限拦截，不要请求用户放行命令。"
          : "本回合仅汇报任务结果或当前障碍，禁止工具调用；不要把流程停止状态误报为脚本权限问题。" })
      : this.validateModelOutput(assistantContent, toolCalls);
    if (outputError) {
      const repairAttempts = options.outputRepairAttempts ?? 0;
      if (repairAttempts < 2) {
        log(`[task-loop] model output repair ${repairAttempts + 1}/2: ${outputError.error.code}`);
        await this.streamChat([
          ...messages,
          { role: "user", content: buildModelCorrectionPrompt(outputError) },
        ], {
          ...options,
          outputRepairAttempts: repairAttempts + 1,
        });
        return;
      }
      const message = outputError.error.code === "VAGUE_TASK_RESULT"
        ? `模型仍未提供可核实的最终结果，已停止继续操作。最近结果：${summarizeTaskProgress(this.visualTask.state.snapshot().steps)}。`
        : "模型连续返回了无法执行的格式，自动修正两次后仍未恢复。";
      this.finishTask("difficult", message);
      const parsed = parseDualChannel(message);
      this.conversation.push({ role: "assistant", content: parsed.display });
      this.emit("done", parsed);
      return;
    }

    if (toolCalls.length > 0) {
      this.visualTask.beginTurn();
      const allSilent = toolCalls.every(tc => SILENT_ACTION_TOOLS.has(tc.function.name));

      if (allSilent) {
        log(`DeepSeekClient: all tool calls are silent action tools. Executing silently...`);
        this.conversation.push({
          role: "assistant",
          content: assistantContent || "",
          reasoning_content: assistantReasoningContent || undefined,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          })),
        });

        const toolResults = await this.executeToolCalls(toolCalls);
        if (this.aborted) return;
        this.conversation.push(...toolResults.map((r) => ({
          role: "tool" as const,
          content: r.content,
          tool_call_id: r.tool_call_id,
        })));

        const failed = toolResults.some(r =>
          isErrorEnvelopeText(r.content)
          || /无法|失败|错误|未能推进|未执行|需要用户|Error|Failed|not found|does not|invalid|cannot|could not/i.test(r.content)
        );

        if (failed) {
          log(`DeepSeekClient: Silent tool execution failed. Falling back to chat to report...`);
          toolAckEmitted = false;
          const next = await this.prepareNextTurn(toolResults);
          await this.streamChat(next.messages, { allowTools: next.allowTools });
          return;
        }

        const hasInspection = toolCalls.some(tc => INSPECTION_TOOLS.has(tc.function.name));
        const hasContinueAfter = toolCalls.some(tc => CONTINUE_AFTER_TOOLS.has(tc.function.name));
        const hasVisualAction = toolCalls.some(tc => this.visualTask.isVisualAction(tc.function.name));
        if (hasInspection || hasContinueAfter || hasVisualAction) {
          log(`DeepSeekClient: Silent tools need follow-up (inspection/continue-after). Continuing chat loop to let LLM verify and continue...`);
          toolAckEmitted = false;
          const next = await this.prepareNextTurn(toolResults);
          await this.streamChat(next.messages, { allowTools: next.allowTools });
          return;
        }

        this.finishTask("completed");
        const summary = summarizeTaskProgress(this.visualTask.state.snapshot().steps)
          || describeToolOutcome(toolCalls[0].function.name, toolCalls[0].function.arguments, toolResults[0].content);
        const parsed = parseDualChannel(`${summary}。`);
        this.conversation.push({ role: "assistant", content: parsed.display });
        this.emit("done", parsed);
        return;
      }

      if (!toolAckEmitted && assistantContent.trim()
        && !toolCalls.some((tc) => this.visualTask.isMutatingTool(tc.function.name)
          || INSPECTION_TOOLS.has(tc.function.name) || tc.function.name === "web_search")) {
        const parsed = parseDualChannel(assistantContent);
        log(`Tool ack raw: ${assistantContent}`);
        log(`Tool ack speech: ${parsed.speech}`);
        this.emit("tool_ack", parsed.speech);
      }

      this.conversation.push({
        role: "assistant",
        content: assistantContent || "",
        reasoning_content: assistantReasoningContent || undefined,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: tc.function,
        })),
      });

      const toolResults = await this.executeToolCalls(toolCalls);
      if (this.aborted) return;
      this.conversation.push(...toolResults.map((r) => ({
        role: "tool" as const,
        content: r.content,
        tool_call_id: r.tool_call_id,
      })));

      toolAckEmitted = false;
      const next = await this.prepareNextTurn(toolResults);
      await this.streamChat(next.messages, { allowTools: next.allowTools });
      return;
    }

    if (this.aborted) return;
    const attachmentCorrection = this.getAttachmentCompletionCorrection();
    if (attachmentCorrection) {
      if (this.attachmentFlow.correctionCount >= 3) {
        const message = "附件已放入剪贴板，但连续三次仍未完成粘贴或确认发送。";
        this.finishTask("difficult", message);
        const parsed = parseDualChannel(message);
        this.conversation.push({ role: "assistant", content: parsed.display });
        this.emit("done", parsed);
        return;
      }
      this.attachmentFlow.correctionCount++;
      log(`[task-loop] blocking premature attachment completion: ${attachmentCorrection}`);
      this.conversation.push({
        role: "user",
        content: `【附件发送尚未完成】${attachmentCorrection}\n继续调用工具完成剩余步骤，不得声称已发送。`,
      });
      await this.streamChat(this.conversation, { allowTools: true });
      return;
    }
    const manualAuthRequested = requestsManualAuthentication(assistantContent);
    if (manualAuthRequested && !this.authHandoffReviewed && this.lastToolResults.some((result) => /截图：[^\r\n]+\.png/.test(result.content))) {
      this.authHandoffReviewed = true;
      log("[task-loop] rechecking manual login handoff against the last screenshot");
      this.conversation.push({
        role: "user",
        content: "【登录页复核】上一张截图若显示已选/已保存账号和可点击的登录按钮，请直接点击并验证后继续原任务，不要要求用户代点。只有确实需要输入账号密码、验证码、扫码或手机确认时，才说明具体需要用户处理的步骤。若截图已过期，先重新截图。",
      });
      await this.streamChat(await this.withSnapshotContext(this.conversation, this.lastToolResults), { allowTools: true });
      return;
    }
    const parsed = parseDualChannel(assistantContent);
    log(`LLM raw response: ${assistantContent}`);
    log(`LLM speech text: ${parsed.speech}`);
    this.conversation.push({
      role: "assistant",
      content: parsed.display,
      reasoning_content: assistantReasoningContent || undefined
    });

    this.finishTask(manualAuthRequested ? "needs_user" : "completed", manualAuthRequested ? parsed.display : "");
    this.emit("done", parsed);
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const { executeTool } = await import("../control/platform");
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      if (this.aborted) break;
      let result: string;
      let executed = false;
      let beforeFrame = null;
      const signature = `${tc.function.name}:${tc.function.arguments.trim()}`;
      const currentCount = this.commandExecutionCounts.get(signature) || 0;
      const isWhiteListed = tc.function.name === "get_current_time" || INSPECTION_TOOLS.has(tc.function.name);

      const deferredReason = this.visualTask.reserveAction(tc.function.name);
      const coordinateError = deferredReason
        ? null
        : await this.visualTask.validateCoordinateAction(tc.function.name, tc.function.arguments);
      const unconfirmedRisk = this.getUnconfirmedRisk(tc);
      if (deferredReason) {
        result = serializeErrorEnvelope(createErrorEnvelope(
          "validation", "no_progress", "ACTION_DEFERRED", deferredReason,
          { retryable: true, correction: "下一轮只选择一个动作，并依据最新截图继续。" },
        ));
      } else if (coordinateError) {
        const decision = this.visualTask.recordRejectedCoordinate(tc.function.name, tc.function.arguments);
        if (decision.kind !== "continue") this.pendingLoopDecision = decision;
        log(`[task-loop] preflight rejected tool=${tc.function.name} code=STALE_SCREEN_COORDINATES`);
        result = serializeErrorEnvelope(createErrorEnvelope(
          "validation", "invalid_output", "STALE_SCREEN_COORDINATES", coordinateError,
          { retryable: decision.kind !== "difficult", correction: coordinateError.includes("截图：")
            ? "本次动作未执行。依据附带的新截图重新生成坐标，无需重复调用 screen_snapshot。"
            : "缺少或过期的截图先调用 screen_snapshot；若当前截图有效，只修正坐标及尺寸参数。" },
        ));
      } else if (unconfirmedRisk) {
        const message = `需要用户明确确认后才能执行：${unconfirmedRisk}。本次未执行任何操作。`;
        this.pendingNeedsUserMessage = message;
        result = serializeErrorEnvelope(createErrorEnvelope(
          "validation", "permission_required", "USER_CONFIRMATION_REQUIRED", message,
          { correction: "停止调用工具，向用户说明需要确认的具体操作。" },
        ));
      } else if (!isWhiteListed && currentCount >= 7) {
        log(`[LOOP_PREVENT] Command repeated too many times (count=${currentCount}): ${signature}. Intercepting.`);
        result = serializeErrorEnvelope(createErrorEnvelope(
          "runtime", "no_progress", "EXACT_COMMAND_LOOP",
          `同一命令及参数已经执行 ${currentCount} 次，继续重复不会推进任务。`,
          { retryable: true, correction: "更换操作方法或结束任务，不要再次提交相同命令。" },
        ));
      } else {
        if (!isWhiteListed) {
          this.commandExecutionCounts.set(signature, currentCount + 1);
        }
        this.emit("tool_start", tc.function.name);
        const toolStartedAt = Date.now();
        try {
          if (this.visualTask.isMutatingTool(tc.function.name)) {
            beforeFrame = await this.visualTask.beforeAction(tc.function.name, tc.function.arguments);
          }
          if (this.aborted) break;
          executed = true;
          result = ["extension_list_tools", "extension_call_tool", "read_skill"].includes(tc.function.name)
            ? await getExtensionManager().execute(tc.function.name, tc.function.arguments, this.abortController?.signal)
            : await executeTool(tc.function.name, tc.function.arguments);
          if (this.aborted) break;
          result = this.normalizeToolResult(tc.function.name, result);
          this.recordAttachmentProgress(tc, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = serializeErrorEnvelope(createErrorEnvelope(
            "tool", "execution_failed", "TOOL_EXECUTION_FAILED", message,
            { retryable: true, correction: "根据错误信息和最新画面选择其他方法，不要原样重复失败动作.", details: { tool: tc.function.name } },
          ));
        } finally {
          log(`[task-perf] action tool=${tc.function.name} elapsedMs=${Date.now() - toolStartedAt}`);
          this.emit("tool_end", tc.function.name);
        }
      }
      if (this.aborted) break;
      if (executed && tc.function.name === "screen_snapshot") {
        await this.visualTask.recordObservation(result);
      }
      if (executed && this.visualTask.isMutatingTool(tc.function.name)) {
        const verification = await this.visualTask.verifyAction(tc.function.name, tc.function.arguments, beforeFrame, result);
        result = this.appendAutomationFeedback(result, verification.feedback);
        this.reportImportantProgress(tc.function.name, verification.progressReport);
        if (verification.decision.kind !== "continue") this.pendingLoopDecision = verification.decision;
      } else if (executed) {
        const progressReport = describeStepProgress(tc.function.name, tc.function.arguments, result);
        this.reportImportantProgress(tc.function.name, progressReport);
      }
      if (executed) {
        if (["write_file", "create_file"].includes(tc.function.name) && !isErrorEnvelopeText(result)) {
          // A script edit changes the conditions for rerunning its debug command.
          for (const key of this.commandExecutionCounts.keys()) {
            if (key.startsWith("run_shell_command:") || key.startsWith("extension_call_tool:")) this.commandExecutionCounts.delete(key);
          }
        }
        this.toolCallCounts.set(tc.function.name, (this.toolCallCounts.get(tc.function.name) || 0) + 1);
        recordToolMemory(tc.function.name, tc.function.arguments, result);
      }
      results.push({
        tool_call_id: tc.id,
        role: "tool",
        content: result,
      });
    }

    if (screenshotPaths(results).length > 0) {
      this.lastToolResults = results;
    }
    return results;
  }

  private validateModelOutput(content: string, toolCalls: ToolCall[]): ErrorEnvelope | null {
    if (!content.trim() && toolCalls.length === 0) {
      return createErrorEnvelope(
        "model", "invalid_output", "EMPTY_MODEL_OUTPUT", "模型没有返回文字或工具调用。",
        { retryable: true, correction: "返回普通文字答复，或调用一个有效工具。" },
      );
    }

    if (toolCalls.length === 0 && this.visualTask.state.snapshot().steps.length > 0
      && /^(?:已完成一项后台处理|已完成当前步骤)[，,。\s]*(?:正在继续执行任务[。！!\s]*)?$/.test(content.trim())) {
      return createErrorEnvelope(
        "model", "invalid_output", "VAGUE_TASK_RESULT", "最终答复没有说明实际任务结果。",
        { retryable: true, correction: "根据真实工具结果，简短说明完成了什么、具体结果是什么；未完成时说明障碍和剩余事项，不要只说已完成一项后台处理或正在继续执行任务。" },
      );
    }

    const knownTools = new Set(availableTools.map((tool) => tool.function.name));
    for (const toolCall of toolCalls) {
      if (!toolCall.id || !toolCall.function.name) {
        return createErrorEnvelope(
          "model", "invalid_output", "INCOMPLETE_TOOL_CALL", "工具调用缺少 id 或工具名称。",
          { retryable: true, correction: "重新生成完整的 function tool call。" },
        );
      }
      if (!knownTools.has(toolCall.function.name)) {
        return createErrorEnvelope(
          "model", "invalid_output", "UNKNOWN_TOOL", `工具 ${toolCall.function.name} 不在可用工具列表中。`,
          { retryable: true, correction: "仅从系统提供的工具列表中选择工具。" },
        );
      }
      try {
        const parsed = JSON.parse(toolCall.function.arguments || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments is not an object");
        const definition = availableTools.find((tool) => tool.function.name === toolCall.function.name);
        const required = definition?.function.parameters.required || [];
        const missing = required.filter((key) => !(key in (parsed as Record<string, unknown>)));
        if (missing.length > 0) {
          return createErrorEnvelope(
            "model", "invalid_output", "MISSING_TOOL_ARGUMENTS",
            `工具 ${toolCall.function.name} 缺少必填参数：${missing.join(", ")}。`,
            { retryable: true, correction: "根据工具参数定义补全所有必填字段后重试。" },
          );
        }
      } catch (error) {
        return createErrorEnvelope(
          "model", "invalid_output", "INVALID_TOOL_ARGUMENTS",
          `工具 ${toolCall.function.name} 的 arguments 不是有效 JSON 对象：${error instanceof Error ? error.message : String(error)}`,
          { retryable: true, correction: "重新生成参数完整、可被 JSON.parse 解析的对象，路径中的反斜杠必须正确转义。" },
        );
      }
    }
    return null;
  }

  private normalizeToolResult(tool: string, result: string): string {
    if (isErrorEnvelopeText(result)) return result;
    const failedPrefix = /^[^\r\n:：]{0,40}(?:失败|错误|无法|未能|暂不支持)[:：]/i.test(result);
    if (!failedPrefix && !/(?:^|[：:\s])(失败|错误|无法|未能|暂不支持|not found|invalid|cannot|could not|failed|error)(?:[：:\s]|$)/i.test(result)) {
      return result;
    }
    return serializeErrorEnvelope(createErrorEnvelope(
      "tool", "execution_failed", "TOOL_REPORTED_FAILURE", result,
      { retryable: true, correction: "结合错误结果和当前画面更换方法，不要原样重复。", details: { tool } },
    ));
  }

  private appendAutomationFeedback(result: string, feedback: string): string {
    if (!feedback) return result;
    if (!isErrorEnvelopeText(result)) return `${result}\n${feedback}`;
    try {
      const envelope = JSON.parse(result) as ErrorEnvelope;
      envelope.error.details = {
        ...(envelope.error.details || {}),
        automationFeedback: feedback,
      };
      return serializeErrorEnvelope(envelope);
    } catch {
      return result;
    }
  }

  private resetAttachmentFlow(): void {
    this.attachmentFlow = {
      staged: false,
      pasted: false,
      confirmed: false,
      correctionCount: 0,
    };
  }

  private recordAttachmentProgress(toolCall: ToolCall, result: string): void {
    if (isErrorEnvelopeText(result)) return;
    const name = toolCall.function.name;
    if (name === "copy_file_to_clipboard") {
      this.attachmentFlow.staged = true;
      this.attachmentFlow.pasted = false;
      this.attachmentFlow.confirmed = false;
      return;
    }
    if (name === "stage_file_attachment") {
      this.attachmentFlow.staged = true;
      this.attachmentFlow.pasted = true;
      this.attachmentFlow.confirmed = false;
      return;
    }
    if (!this.attachmentFlow.staged) return;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return;
    }

    if (name === "press_keys") {
      const keys = String(args.keys || "").toLowerCase().replace(/\s/g, "");
      if (keys === "ctrl+v" || keys === "control+v") {
        this.attachmentFlow.pasted = true;
      } else if (this.attachmentFlow.pasted && (keys === "enter" || keys === "return")) {
        this.attachmentFlow.confirmed = true;
      }
      return;
    }
    if (name === "confirm_staged_attachment") {
      this.attachmentFlow.pasted = true;
      this.attachmentFlow.confirmed = true;
      return;
    }
    if (name === "desktop_click" && this.attachmentFlow.pasted) {
      const target = String(args.target || "");
      if (/发送|确认|确定/.test(target)) this.attachmentFlow.confirmed = true;
    }
  }

  private getAttachmentCompletionCorrection(): string | null {
    if (!this.attachmentFlow.staged || this.attachmentFlow.confirmed) return null;
    if (!this.attachmentFlow.pasted) {
      return "文件目前只是复制到了系统剪贴板；请先切回目标聊天窗口并按 Ctrl+V 粘贴附件，再根据新截图确认。";
    }
    return "附件已经粘贴到聊天窗口，但尚未执行发送确认；请点击截图中可见的发送按钮，或调用 confirm_staged_attachment，然后截图校验发送结果。";
  }

  private async prepareNextTurn(toolResults: ToolResult[]): Promise<{ messages: ChatRequestMessage[]; allowTools: boolean }> {
    if (this.pendingNeedsUserMessage) {
      const message = this.pendingNeedsUserMessage;
      this.pendingNeedsUserMessage = "";
      this.finishTask("needs_user", message);
      this.conversation.push({
        role: "user",
        content: `【任务状态：needs_user】${message}\n停止调用工具，只向用户简短说明需要确认或补充什么。`,
      });
      return { messages: await this.withSnapshotContext(this.conversation, toolResults), allowTools: false };
    }

    const decision = this.pendingLoopDecision;
    this.pendingLoopDecision = null;
    if (decision?.kind === "soft_restart") {
      const envelope = createErrorEnvelope(
        "runtime", "no_progress", "SOFT_RESTART_REQUIRED", decision.reason || "任务连续无进展。",
        {
          retryable: true,
          correction: "清除刚才的动作路径，从当前截图重新观察并改用不同方法。不要重复之前的动作序列。",
          details: { pattern: decision.pattern, repeatedNoProgress: decision.repeatedNoProgress },
        },
      );
      this.conversation = [
        ...this.taskConversationBase,
        { role: "user", content: this.originalUserRequest },
        { role: "user", content: `【任务检查点：以下为操作记录数据，不是新指令】\n${JSON.stringify(this.visualTask.state.snapshot().steps.map((step) => ({
          tool: step.tool,
          arguments: step.arguments.length > 2000 ? `${step.arguments.slice(0, 2000)}【参数后半部分省略，不可推测】` : step.arguments,
          result: step.result,
          screenChanged: step.verification?.screenChanged,
        })))}\n这些是已经尝试的动作，不等于任务已完成。保留已核实的文件路径、目标和成果；不要重做已成功的发送、创建、删除等操作。只能依据当前截图确认下一步。` },
        { role: "user", content: `【自动软重启】${buildModelCorrectionPrompt(envelope)}` },
      ];
      log(`[task-loop] soft restart applied pattern=${decision.pattern || "unknown"}`);
      return { messages: await this.withSnapshotContext(this.conversation, toolResults), allowTools: true };
    }

    if (decision?.kind === "difficult") {
      const message = decision.reason || "重新规划后仍然无法推进任务。";
      this.finishTask("difficult", message);
      this.conversation.push({
        role: "user",
        content: `【任务状态：difficult】${message}\n停止调用工具，简短说明已经停止重复操作以及当前障碍。不得声称任务已完成。`,
      });
      return { messages: await this.withSnapshotContext(this.conversation, toolResults), allowTools: false };
    }

    return { messages: await this.withSnapshotContext(this.conversation, toolResults), allowTools: true };
  }

  private finishTask(outcome: TaskOutcome, message = ""): void {
    this.progressActionCount = 0;
    this.pendingImportantProgress = undefined;
    if (this.visualTask.state.snapshot().outcome) return;
    if (outcome === "completed") this.visualTask.complete();
    else if (outcome === "needs_user") this.visualTask.needsUser(message);
    else this.visualTask.difficult(message);
    this.emit("task_outcome", { status: outcome, message });
  }

  private reportImportantProgress(tool: string, candidate: string | undefined): void {
    if (this.aborted || !candidate || (!this.visualTask.isMutatingTool(tool) && tool !== "web_search")) return;
    const important = IMPORTANT_PROGRESS_TOOLS.has(tool)
      || (tool === "press_keys" && /^(保存当前内容|关闭当前页面|关闭当前窗口)。$/.test(candidate));
    this.progressActionCount++;
    if (important) this.pendingImportantProgress = candidate;
    if (this.progressActionCount < 2 || (this.progressActionCount < 3 && !important)) return;
    // Report one important action, not a concatenation; never repeat an old loading state.
    const message = !important && this.pendingImportantProgress === "页面正在加载。"
      ? "打开目标网站。" : this.pendingImportantProgress;
    this.progressActionCount = 0;
    this.pendingImportantProgress = undefined;
    if (message) this.emit("task_progress", message);
  }

  private stripImageContent(messages: ChatRequestMessage[]): ChatRequestMessage[] {
    return messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const text = message.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return { ...message, content: text };
    });
  }

  private sanitizeRequestMessages(
    messages: ChatRequestMessage[],
    normalizeAllBackslashes: boolean,
  ): ChatRequestMessage[] {
    return messages.map((message) => {
      const normalizeBackslashes = normalizeAllBackslashes || message.role === "system";
      const content = Array.isArray(message.content)
        ? message.content.map((item) => item.type === "text"
          ? { ...item, text: sanitizeModelText(item.text, normalizeBackslashes) }
          : item)
        : sanitizeModelText(message.content, normalizeBackslashes);
      return {
        ...message,
        content,
        reasoning_content: message.reasoning_content
          ? sanitizeModelText(message.reasoning_content, normalizeBackslashes)
          : message.reasoning_content,
      };
    });
  }

  private async withSnapshotContext(
    messages: ChatMessage[],
    results: ToolResult[],
  ): Promise<ChatRequestMessage[]> {
    const paths = screenshotPaths(results);
    const screenshotPath = paths[paths.length - 1];
    if (!screenshotPath) return messages;

    try {
      const startedAt = Date.now();
      const stat = await fs.promises.stat(screenshotPath);
      if (this.screenshotCache?.path !== screenshotPath || this.screenshotCache.mtimeMs !== stat.mtimeMs) {
        const source = await fs.promises.readFile(screenshotPath);
        const image = nativeImage.createFromBuffer(source);
        if (image.isEmpty()) throw new Error("截图解码失败");
        const size = image.getSize();
        // Preserve the coordinate space advertised by the tool; compress without resizing.
        this.screenshotCache = {
          path: screenshotPath, mtimeMs: stat.mtimeMs,
          dataUrl: `data:image/jpeg;base64,${image.toJPEG(72).toString("base64")}`,
          width: size.width, height: size.height,
        };
      }
      const { dataUrl, width, height } = this.screenshotCache;
      log(`[task-perf] screenshot-context elapsedMs=${Date.now() - startedAt} chars=${dataUrl.length}`);
      log(`DeepSeekClient: attached screenshot context (${dataUrl.length} data-url chars)`);
      return [
        ...messages,
        {
          role: "user",
          content: [
            { type: "text", text: `【当前屏幕截图】尺寸：${width}x${height}。坐标是此图左上角为原点的实际像素，不是0-1或0-1000归一化坐标，也不是Windows逻辑坐标；screenshot_width/height 必须为此尺寸。点击真实可见目标的内部中心，避开边缘和相邻控件。目标太小、被遮挡或不能确认时不要猜点，优先使用明确可用的快捷键或滚动到可见位置。这是工具刚读取的当前画面，仅用于回答用户请求。请只依据真实可见内容判断。` },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ];
    } catch (error) {
      log(`DeepSeekClient: failed to attach screenshot context: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error("当前截图无法提供给模型，已暂停操作以避免误点击。请重新执行任务获取画面。");
    }
  }

  private getRiskKeyword(toolCall: ToolCall): string | null {
    if (["delete_file", "quit_all_applications", "send_email"].includes(toolCall.function.name)) {
      return toolCall.function.name === "delete_file" ? "删除" : toolCall.function.name === "send_email" ? "发送" : "关闭全部应用";
    }
    if (!["desktop_click", "desktop_double_click", "desktop_drag"].includes(toolCall.function.name)) return null;
    let target = toolCall.function.arguments;
    try {
      const parsed = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      target = String(parsed.target || "");
    } catch {
      // Use the raw arguments for conservative matching.
    }
    return target.match(/删除|清空|付款|支付|购买|下单|发布|发送|授权|覆盖|注销|退出登录|提交订单/)?.[0] || null;
  }

  private getUnconfirmedRisk(toolCall: ToolCall): string | null {
    const keyword = this.getRiskKeyword(toolCall);
    if (!keyword) return null;
    if (/^(确认|同意|允许|可以|继续|执行|是的|确定)/.test(this.originalUserRequest.trim())) return null;
    if (keyword === "发送" && /发|发送|回复|提交/.test(this.originalUserRequest)) return null;
    return this.originalUserRequest.includes(keyword) ? null : keyword;
  }
}
