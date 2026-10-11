import { log } from "../utils/logger";
import { isErrorEnvelopeText } from "./errorEnvelope";
import { measureCoordinateChange, captureAutomationFrame, loadAutomationFrame, ScreenFrame, waitForScreenStable } from "./screenSettler";
import { StallDecision, StallPolicy } from "./stallPolicy";
import { TaskStateMachine } from "./taskStateMachine";
import { describeStepProgress } from "./taskReporting";
import { saveScreenCapture } from "../vision/screenCapture";

const VISUAL_ACTION_TOOLS = new Set([
  "open_application",
  "quit_application",
  "quit_all_applications",
  "open_url",
  "type_text",
  "press_keys",
  "open_contact_chat",
  "stage_file_attachment",
  "focus_application_search",
  "select_application_search_result",
  "confirm_staged_attachment",
  "desktop_click",
  "desktop_double_click",
  "desktop_right_click",
  "desktop_scroll",
  "desktop_drag",
]);

const MUTATING_TOOLS = new Set([
  ...VISUAL_ACTION_TOOLS,
  "write_clipboard_text",
  "copy_file_to_clipboard",
  "write_file",
  "create_file",
  "delete_file",
  "run_shell_command",
  "create_note",
  "create_reminder",
  "create_calendar_event",
  "send_email",
  "set_timer",
  "set_alarm",
  "download_media",
  "trim_video",
  "convert_video",
  "convert_document",
  "office_document",
  "edit_pdf",
  "switch_audio_output",
]);

const COORDINATE_TOOLS = new Set([
  "desktop_click",
  "desktop_double_click",
  "desktop_right_click",
  "desktop_scroll",
  "desktop_drag",
]);

const SELF_FOCUSING_VISUAL_TOOLS = new Set([
  "open_contact_chat",
  "stage_file_attachment",
  "confirm_staged_attachment",
]);

const OBSERVATION_MAX_AGE_MS = 60_000;

export interface VisualVerificationResult {
  feedback: string;
  screenshotPath?: string;
  decision: StallDecision;
  progressReport?: string;
}

export class VisualTaskRuntime {
  readonly state = new TaskStateMachine();
  private lastObservation: ScreenFrame | null = null;
  private actionExecutedThisTurn = false;
  private aborted = false;
  private stallPolicy = new StallPolicy();

  start(request: string): void {
    this.aborted = false;
    this.lastObservation = null;
    this.actionExecutedThisTurn = false;
    this.stallPolicy.reset();
    this.state.start(request);
  }

  beginTurn(): void {
    this.actionExecutedThisTurn = false;
  }

  abort(): void {
    this.aborted = true;
    this.state.abort();
  }

  complete(): void {
    this.state.complete();
  }

  needsUser(message: string): void {
    this.state.finish("needs_user", message);
  }

  difficult(message: string): void {
    this.state.finish("difficult", message);
  }

  fail(message: string): void {
    this.state.fail(message);
  }

  isMutatingTool(name: string): boolean {
    return MUTATING_TOOLS.has(name);
  }

  isVisualAction(name: string): boolean {
    return VISUAL_ACTION_TOOLS.has(name);
  }

  reserveAction(name: string): string | null {
    if (!this.isMutatingTool(name)) return null;
    if (this.actionExecutedThisTurn) {
      return "本轮已经执行了一个具体动作，后续动作未执行并已延迟。请根据最新截图在下一轮只选择一个动作继续。";
    }
    this.actionExecutedThisTurn = true;
    return null;
  }

  recordRejectedCoordinate(name: string, argsJson: string): StallDecision {
    const decision = this.stallPolicy.record(name, argsJson, false);
    log(`[task-coordinate] tool=${name} executed=false decision=${decision.kind} noProgress=${decision.repeatedNoProgress}`);
    return decision;
  }

  async validateCoordinateAction(name: string, argsJson: string): Promise<string | null> {
    if (!COORDINATE_TOOLS.has(name)) return null;
    if (!this.lastObservation || Date.now() - this.lastObservation.capturedAt > OBSERVATION_MAX_AGE_MS) {
      return "坐标动作缺少当前屏幕依据，请先调用 screen_snapshot 获取实时画面后再操作。";
    }
    try {
      const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
      const width = Number(args.screenshot_width);
      const height = Number(args.screenshot_height);
      const points = name === "desktop_drag" ? [args.x, args.y, args.end_x, args.end_y] : [args.x, args.y];
      if (points.some((value, index) => typeof value !== "number" || !Number.isFinite(value)
        || value < 0 || value >= (index % 2 === 0 ? width : height))) {
        return "坐标超出截图范围或格式无效，本次未执行；请依据当前截图修正坐标。";
      }
      if (width !== this.lastObservation.width || height !== this.lastObservation.height) {
        return `坐标所依据的截图尺寸已失效（传入 ${width}x${height}，当前 ${this.lastObservation.width}x${this.lastObservation.height}），请重新截图。`;
      }
      const liveFrame = await captureAutomationFrame();
      if (this.aborted) return "任务已取消，本次未执行";
      const change = measureCoordinateChange(this.lastObservation, liveFrame, points.map(Number));
      log(`[task-coordinate] tool=${name} status=${change.reason ? "rejected" : "accepted"} reason=${change.reason || "stable_target"} global=${change.globalRatio.toFixed(4)} target=${change.targetRatio.toFixed(4)} context=${change.contextRatio.toFixed(4)}`);
      if (change.reason) {
        this.lastObservation = liveFrame;
        const saved = await saveScreenCapture(liveFrame, "coordinate-refresh");
        return `点击前目标或屏幕布局已变化（原因 ${change.reason}，目标 ${(change.targetRatio * 100).toFixed(2)}%，周边 ${(change.contextRatio * 100).toFixed(2)}%，整屏 ${(change.globalRatio * 100).toFixed(2)}%），为避免误触，本次未执行。请依据附带的新截图重新选择单步动作，无需重复截图。\n截图：${saved.path}\n尺寸：${liveFrame.width}x${liveFrame.height}`;
      }
      this.lastObservation = liveFrame;
    } catch (error) {
      log(`[task-coordinate] tool=${name} status=rejected reason=preflight_failed error=${error instanceof Error ? error.message : String(error)}`);
      return "坐标动作参数解析或实时画面校验失败，本次未执行，请重新观察并生成有效动作。";
    }
    return null;
  }

  async recordObservation(toolResult: string): Promise<void> {
    const match = toolResult.match(/截图：([^\r\n]+?\.png)(?:\r?\n|$)/i);
    try {
      this.lastObservation = match
        ? await loadAutomationFrame(match[1].trim())
        : await captureAutomationFrame();
      this.state.observe();
    } catch (error) {
      log(`[task-loop] observation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async beforeAction(name: string, argsJson: string): Promise<ScreenFrame | null> {
    this.state.beginAction(name, argsJson);
    if (!this.isVisualAction(name)) return null;
    if (COORDINATE_TOOLS.has(name) && this.lastObservation) return this.lastObservation;
    if (SELF_FOCUSING_VISUAL_TOOLS.has(name) && this.lastObservation) return this.lastObservation;
    const frame = await captureAutomationFrame();
    this.lastObservation = frame;
    return frame;
  }

  async verifyAction(name: string, argsJson: string, before: ScreenFrame | null, toolResult: string): Promise<VisualVerificationResult> {
    if (!before) {
      this.state.completeStep(toolResult);
      const progressed = !isErrorEnvelopeText(toolResult)
        && !/(无法|失败|错误|未执行|Error|Failed|invalid|cannot|could not)/i.test(toolResult);
      const decision = this.stallPolicy.record(name, argsJson, progressed);
      return {
        feedback: this.decisionFeedback(decision),
        decision,
        progressReport: describeStepProgress(name, argsJson, toolResult),
      };
    }
    this.state.beginVerification();
    try {
      const verification = await waitForScreenStable(before, { shouldStop: () => this.aborted });
      this.lastObservation = verification.frame;
      const changed = verification.changeRatio > 0.003;
      let actionChanged = changed;
      let targetFeedback = "";
      if (COORDINATE_TOOLS.has(name)) {
        const args = JSON.parse(argsJson) as Record<string, number>;
        const points = name === "desktop_drag" ? [args.x, args.y, args.end_x, args.end_y] : [args.x, args.y];
        const change = measureCoordinateChange(before, verification.frame, points);
        actionChanged = change.reason === "display_layout_changed" || change.targetRatio > 0.003 || change.contextRatio > 0.003;
        targetFeedback = `目标附近${actionChanged ? "发生变化" : "无明显变化"}（目标 ${(change.targetRatio * 100).toFixed(2)}%，周边 ${(change.contextRatio * 100).toFixed(2)}%）；按钮外的背景变化不代表该动作取得进展。`;
      }
      const feedback = `视觉校验：动作后单次采样，整屏${changed ? "发生变化" : "无明显变化"}（变化率 ${(verification.changeRatio * 100).toFixed(2)}%，等待及采集 ${verification.elapsedMs}ms）。${targetFeedback}单张截图不能证明界面稳定或任务成功；请依据可见加载状态、目标及工具结果判断。\n截图：${verification.screenshotPath}\n尺寸：${verification.frame.width}x${verification.frame.height}`;
      this.state.completeStep(toolResult, {
        screenChanged: changed,
        changeRatio: verification.changeRatio,
        settled: verification.settled,
        elapsedMs: verification.elapsedMs,
        screenshotPath: verification.screenshotPath,
      });
      const progressed = actionChanged && !isErrorEnvelopeText(toolResult);
      const decision = this.stallPolicy.record(name, argsJson, progressed);
      return {
        feedback: `${feedback}${this.decisionFeedback(decision)}`,
        screenshotPath: verification.screenshotPath,
        decision,
        progressReport: describeStepProgress(name, argsJson, toolResult),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.completeStep(toolResult);
      log(`[task-loop] visual verification failed: ${message}`);
      const decision = this.stallPolicy.record(name, argsJson, false);
      return {
        feedback: `视觉校验失败：${message}。工具可能已经执行，不能确认结果；不要重复发送、输入或创建操作，先调用 screen_snapshot 检查当前状态。${this.decisionFeedback(decision)}`,
        decision,
      };
    }
  }

  private decisionFeedback(decision: StallDecision): string {
    if (decision.kind === "continue") return "";
    return `\n任务控制：${decision.reason || decision.kind}`;
  }

}
