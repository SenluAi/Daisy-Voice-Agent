export type ErrorSource = "model" | "tool" | "capture" | "validation" | "runtime";
export type ErrorKind = "invalid_output" | "execution_failed" | "permission_required" | "no_progress" | "cancelled";

export interface ErrorEnvelope {
  ok: false;
  error: {
    source: ErrorSource;
    kind: ErrorKind;
    code: string;
    message: string;
    retryable: boolean;
    correction?: string;
    details?: Record<string, unknown>;
  };
}

export function createErrorEnvelope(
  source: ErrorSource,
  kind: ErrorKind,
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    correction?: string;
    details?: Record<string, unknown>;
  } = {},
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      source,
      kind,
      code,
      message,
      retryable: options.retryable ?? false,
      correction: options.correction,
      details: options.details,
    },
  };
}

export function serializeErrorEnvelope(envelope: ErrorEnvelope): string {
  return JSON.stringify(envelope);
}

export function isErrorEnvelopeText(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Partial<ErrorEnvelope>;
    return parsed.ok === false && Boolean(parsed.error?.code) && Boolean(parsed.error?.message);
  } catch {
    return false;
  }
}

export function buildModelCorrectionPrompt(envelope: ErrorEnvelope): string {
  const correction = envelope.error.correction || "修正输出后重试。";
  return [
    "【模型输出格式修正】上一轮输出没有执行。",
    `错误代码：${envelope.error.code}`,
    `原因：${envelope.error.message}`,
    `修正要求：${correction}`,
    "请保留原任务目标，只输出普通最终答复，或调用一个参数完整且 arguments 为 JSON 对象的工具。每轮最多一个具体动作。",
  ].join("\n");
}
