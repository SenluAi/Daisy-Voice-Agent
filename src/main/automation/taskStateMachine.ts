import { log } from "../utils/logger";

export type TaskPhase = "idle" | "observing" | "acting" | "verifying" | "completed" | "failed" | "aborted";
export type TaskOutcome = "completed" | "needs_user" | "difficult";

export interface TaskStepVerification {
  screenChanged: boolean;
  changeRatio: number;
  settled: boolean;
  elapsedMs: number;
  screenshotPath?: string;
}

export interface TaskStepRecord {
  index: number;
  tool: string;
  arguments: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  verification?: TaskStepVerification;
}

export interface TaskStateSnapshot {
  request: string;
  phase: TaskPhase;
  startedAt: number;
  updatedAt: number;
  outcome: TaskOutcome | null;
  outcomeMessage?: string;
  steps: TaskStepRecord[];
}

export class TaskStateMachine {
  private request = "";
  private phase: TaskPhase = "idle";
  private startedAt = 0;
  private updatedAt = 0;
  private outcome: TaskOutcome | null = null;
  private outcomeMessage = "";
  private steps: TaskStepRecord[] = [];

  start(request: string): void {
    const now = Date.now();
    this.request = request.trim();
    this.phase = "observing";
    this.startedAt = now;
    this.updatedAt = now;
    this.outcome = null;
    this.outcomeMessage = "";
    this.steps = [];
    log(`[task-loop] started: ${this.request.slice(0, 160)}`);
  }

  observe(): void {
    if (this.isTerminal()) return;
    this.transition("observing");
  }

  beginAction(tool: string, args: string): TaskStepRecord {
    const step: TaskStepRecord = {
      index: this.steps.length + 1,
      tool,
      arguments: args,
      startedAt: Date.now(),
    };
    this.steps.push(step);
    this.transition("acting");
    log(`[task-loop] step ${step.index} action=${tool}`);
    return step;
  }

  beginVerification(): void {
    if (this.isTerminal()) return;
    this.transition("verifying");
  }

  completeStep(result: string, verification?: TaskStepVerification): void {
    const step = this.steps[this.steps.length - 1];
    if (!step || step.completedAt) return;
    step.completedAt = Date.now();
    step.result = result.slice(0, 1000);
    step.verification = verification;
    this.transition("observing");
    log(`[task-loop] step ${step.index} completed${verification ? ` changed=${verification.changeRatio.toFixed(4)} settled=${verification.settled}` : ""}`);
  }

  complete(): void {
    this.finish("completed");
  }

  finish(outcome: TaskOutcome, message = ""): void {
    if (this.isTerminal()) return;
    this.outcome = outcome;
    this.outcomeMessage = message;
    this.transition("completed");
    log(`[task-loop] outcome=${outcome} in ${Date.now() - this.startedAt}ms, steps=${this.steps.length}${message ? ` message=${message}` : ""}`);
  }

  fail(message: string): void {
    if (this.isTerminal()) return;
    this.transition("failed");
    log(`[task-loop] failed: ${message}`);
  }

  abort(): void {
    if (this.phase === "idle" || this.isTerminal()) return;
    this.transition("aborted");
    log(`[task-loop] aborted after ${this.steps.length} steps`);
  }

  snapshot(): TaskStateSnapshot {
    return {
      request: this.request,
      phase: this.phase,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      outcome: this.outcome,
      outcomeMessage: this.outcomeMessage || undefined,
      steps: this.steps.map((step) => ({ ...step, verification: step.verification ? { ...step.verification } : undefined })),
    };
  }

  private transition(phase: TaskPhase): void {
    this.phase = phase;
    this.updatedAt = Date.now();
  }

  private isTerminal(): boolean {
    return this.phase === "completed" || this.phase === "failed" || this.phase === "aborted";
  }
}
