import path from "node:path";
import { isErrorEnvelopeText } from "./errorEnvelope";
import type { TaskStepRecord } from "./taskStateMachine";

export const MAX_TASK_ROUNDS = 200;
export const TASK_ROUND_LIMIT_MESSAGE = `任务执行步骤过多已达${MAX_TASK_ROUNDS}轮，已自动停止以防重复操作，如需继续任务请说继续执行。`;

function spokenResult(result: string): string {
  return result.split(/\r?\n/).map((line) => line.trim()).find((line) => (
    /^(已|成功|找到|发现|未|无法|失败|错误|正在|共|完成|检测到)/.test(line)
    && /[\u4e00-\u9fff]{2}/.test(line)
    && !/[\\/]|(?:api[_-]?key|token|password|secret)\s*[:=]/i.test(line)
    && !/已完成一项后台处理|正在继续执行任务/.test(line)
    && line.length <= 80
  ))?.replace(/[。；]+$/, "") || "";
}

export function describeToolOutcome(tool: string, argsJson: string, result: string): string {
  if (isErrorEnvelopeText(result)) {
    const error = JSON.parse(result).error;
    return spokenResult(error.message) || "当前操作未成功，任务尚未完成";
  }
  const outcome = spokenResult(result);
  if (outcome) return outcome;
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch { /* Ignore invalid tool labels. */ }
  const label = (value: unknown): string => {
    const text = String(value || "").trim();
    return text.length <= 40 && !/[\\/\r\n]|https?:|[A-Za-z]:/.test(text) ? text : "";
  };
  const fileName = label(path.posix.basename(String(args.path || args.target || args.output || "").replace(/\\/g, "/")));
  if (/失败|错误|无法|未执行|\b(error|failed|cannot|invalid)\b/i.test(result)) return "当前操作未成功，任务尚未完成";
  switch (tool) {
    case "run_shell_command": return "后台命令已执行，但未返回可直接汇报的结果";
    case "open_application": return `已切换到${label(args.name) || "目标应用"}`;
    case "open_contact_chat": return `已搜索${label(args.contact) || "目标联系人"}，尚需核对会话`;
    case "stage_file_attachment": return `已准备${fileName ? `附件“${fileName}”` : "文件附件"}，尚未确认发送`;
    case "copy_file_to_clipboard": return `已暂存${fileName ? `文件“${fileName}”` : "待发送文件"}，尚未发送`;
    case "confirm_staged_attachment": return "已执行附件发送确认，正在核对发送结果";
    case "write_file": case "create_file": return `已写入${fileName ? `“${fileName}”` : "目标文件"}`;
    case "delete_file": return `已删除${fileName ? `“${fileName}”` : "目标文件"}`;
    case "office_document": case "convert_document": case "edit_pdf": return `已执行${fileName ? `“${fileName}”的` : "当前"}文档处理`;
    case "download_media": case "trim_video": case "convert_video": return `已执行${fileName ? `“${fileName}”的` : "当前"}媒体处理`;
    case "desktop_click": case "desktop_double_click": return `已执行${label(args.target) ? `“${label(args.target)}”` : "当前界面"}操作`;
    case "open_url": return "已打开目标网页";
    case "type_text": return "已填写当前输入内容";
    case "press_keys": return "已执行当前快捷键操作";
    case "desktop_scroll": return "已滚动到新的页面内容";
    default: return "已执行当前操作，尚需核对任务目标";
  }
}

export function summarizeTaskProgress(steps: readonly TaskStepRecord[]): string {
  const summaries = steps.filter((step) => step.completedAt && step.result).slice(-3)
    .map((step) => describeToolOutcome(step.tool, step.arguments, step.result!));
  return [...new Set(summaries)].join("；");
}

// Report this action or a verified loading status; internal screen observation stays silent.
export function describeStepProgress(tool: string, argsJson: string, result: string): string | undefined {
  if (!result.trim() || isErrorEnvelopeText(result)
    || /^[^\r\n:：]{0,40}(?:失败|错误|无法|未能|未执行|暂不支持)[:：]/i.test(result)
    || /^(?:无法|失败|错误|未执行|error\b|failed\b)/i.test(result.trim())) return undefined;
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch { return undefined; }
  const label = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text || text.length > 28 || /[\\/\r\n。！？；<>]|https?:|[A-Za-z]:|api.?key|token|password|secret/i.test(text)) return "";
    const translated: Record<string, string> = { login: "登录", send: "发送", search: "搜索", save: "保存", close: "关闭", next: "下一步", cancel: "取消" };
    return translated[text.toLowerCase()] || (/[\u4e00-\u9fff]/.test(text) || /^(?:QQ|Chrome|Edge|Daisy|WPS|Word|Excel|PowerPoint)$/i.test(text) ? text : "");
  };
  const target = label(args.target);
  switch (tool) {
    case "screen_snapshot": case "get_frontmost_application": return undefined;
    case "open_url": return /加载中|正在加载/.test(result) ? "页面正在加载。" : "打开目标网站。";
    case "open_application": return `打开${label(args.name) || "目标应用"}。`;
    case "quit_application": return `关闭${label(args.name) || "当前应用"}。`;
    case "quit_all_applications": return "关闭指定应用窗口。";
    case "desktop_click": return `点击${target ? `“${target}”` : "当前按钮"}。`;
    case "desktop_double_click": return `双击${target ? `“${target}”` : "当前对象"}。`;
    case "desktop_right_click": return `右击${target ? `“${target}”` : "当前对象"}。`;
    case "desktop_drag": return `拖动${target ? `“${target}”` : "当前对象"}。`;
    case "desktop_scroll": return `向${({ up: "上", down: "下", left: "左", right: "右" } as Record<string, string>)[String(args.direction)] || "下"}滚动当前区域。`;
    case "type_text": return "在当前输入框填写文字。";
    case "press_keys": {
      const keys = String(args.keys || "").toLowerCase().replace(/\s/g, "");
      if (/^(ctrl|control|cmd|command)\+w$/.test(keys)) return "关闭当前页面。";
      if (/^(ctrl|control|cmd|command)\+s$/.test(keys)) return "保存当前内容。";
      if (/^(ctrl|control|cmd|command)\+v$/.test(keys)) return "粘贴当前内容。";
      if (keys === "alt+f4") return "关闭当前窗口。";
      return "执行当前快捷键操作。";
    }
    case "open_contact_chat": return `搜索${label(args.contact) || "目标联系人"}。`;
    case "focus_application_search": return "打开应用内搜索框。";
    case "select_application_search_result": return "选择当前搜索结果。";
    case "stage_file_attachment": return "添加文件附件。";
    case "copy_file_to_clipboard": return "暂存文件附件。";
    case "confirm_staged_attachment": return "确认发送附件。";
    case "list_directory": return "查看当前目录的文件。";
    case "read_file": return "读取目标文件。";
    case "write_file": case "create_file": return "保存目标文件。";
    case "delete_file": return "删除指定文件。";
    case "office_document": case "convert_document": case "edit_pdf": return "处理当前文档。";
    case "run_shell_command": return "执行后台命令。";
    case "get_clipboard_text": return "读取剪贴板内容。";
    case "write_clipboard_text": return "填写剪贴板内容。";
    case "read_selected_text": return "读取当前选中内容。";
    case "download_media": return "下载目标文件。";
    case "trim_video": case "convert_video": return "处理目标媒体文件。";
    case "create_note": return "保存当前笔记。";
    case "create_reminder": return "设置当前提醒。";
    case "create_calendar_event": return "保存日程安排。";
    case "send_email": return "发送指定邮件。";
    case "set_timer": case "set_alarm": return "设置当前定时任务。";
    case "switch_audio_output": return "切换音频输出。";
    case "web_search": return "搜索相关信息。";
    case "scrape_url": return "读取网页内容。";
    default: return undefined;
  }
}
