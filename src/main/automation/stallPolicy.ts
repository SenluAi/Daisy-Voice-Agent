export type StallDecisionKind = "continue" | "soft_restart" | "difficult";

export interface StallDecision {
  kind: StallDecisionKind;
  reason?: string;
  repeatedNoProgress: number;
  pattern?: "same_action" | "same_zone" | "back_and_forth" | "no_progress";
}

interface ActionSample {
  exactSignature: string;
  zoneSignature: string;
  progressed: boolean;
}

const REPLAN_THRESHOLD = 4;
const STOP_THRESHOLD_AFTER_RESTART = 5;
const MAX_HISTORY = 12;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function actionSignatures(tool: string, argsJson: string): { exact: string; zone: string } {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const exactArgs = { ...args };
    const zoneArgs = { ...args };
    for (const key of ["x", "y", "end_x", "end_y"]) {
      const value = Number(args[key]);
      if (!Number.isFinite(value)) continue;
      exactArgs[key] = Math.round(value / 15) * 15;
      zoneArgs[key] = Math.round(value / 60) * 60;
    }
    delete exactArgs.screenshot_width;
    delete exactArgs.screenshot_height;
    delete zoneArgs.screenshot_width;
    delete zoneArgs.screenshot_height;
    return {
      exact: `${tool}:${JSON.stringify(stableValue(exactArgs))}`,
      zone: `${tool}:${JSON.stringify(stableValue(zoneArgs))}`,
    };
  } catch {
    const compact = argsJson.replace(/\s+/g, " ").trim();
    return { exact: `${tool}:${compact}`, zone: `${tool}:${compact}` };
  }
}

function trailingCount(samples: ActionSample[], selector: (sample: ActionSample) => string): number {
  if (samples.length === 0) return 0;
  const expected = selector(samples[samples.length - 1]);
  let count = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].progressed || selector(samples[index]) !== expected) break;
    count += 1;
  }
  return count;
}

function hasBackAndForthLoop(samples: ActionSample[]): boolean {
  const recent = samples.slice(-4);
  if (recent.length < 4 || recent.some((sample) => sample.progressed)) return false;
  return recent[0].zoneSignature === recent[2].zoneSignature
    && recent[1].zoneSignature === recent[3].zoneSignature
    && recent[0].zoneSignature !== recent[1].zoneSignature;
}

export class StallPolicy {
  private history: ActionSample[] = [];
  private repeatedNoProgress = 0;
  private softRestartCount = 0;

  reset(): void {
    this.history = [];
    this.repeatedNoProgress = 0;
    this.softRestartCount = 0;
  }

  record(tool: string, argsJson: string, progressed: boolean): StallDecision {
    const signatures = actionSignatures(tool, argsJson);
    this.history.push({
      exactSignature: signatures.exact,
      zoneSignature: signatures.zone,
      progressed,
    });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.repeatedNoProgress = progressed ? 0 : this.repeatedNoProgress + 1;

    const sameAction = trailingCount(this.history, (sample) => sample.exactSignature);
    const sameZone = trailingCount(this.history, (sample) => sample.zoneSignature);
    const backAndForth = hasBackAndForthLoop(this.history);
    const pattern = sameAction >= REPLAN_THRESHOLD
      ? "same_action"
      : sameZone >= REPLAN_THRESHOLD
        ? "same_zone"
        : backAndForth
          ? "back_and_forth"
          : this.repeatedNoProgress >= REPLAN_THRESHOLD
            ? "no_progress"
            : undefined;

    if (!pattern) {
      return { kind: "continue", repeatedNoProgress: this.repeatedNoProgress };
    }

    if (this.softRestartCount === 0) {
      this.softRestartCount = 1;
      this.history = [];
      this.repeatedNoProgress = 0;
      return {
        kind: "soft_restart",
        pattern,
        repeatedNoProgress: REPLAN_THRESHOLD,
        reason: `检测到${pattern === "back_and_forth" ? "来回循环" : pattern === "same_zone" ? "局部区域重复操作" : pattern === "same_action" ? "重复动作" : "连续无进展"}，已清理本轮工具上下文并重新规划。`,
      };
    }

    if (this.repeatedNoProgress >= STOP_THRESHOLD_AFTER_RESTART || backAndForth) {
      return {
        kind: "difficult",
        pattern,
        repeatedNoProgress: this.repeatedNoProgress,
        reason: "软重启后仍然连续无进展，为避免重复操作已停止自动执行。",
      };
    }

    return { kind: "continue", repeatedNoProgress: this.repeatedNoProgress };
  }
}
