// Bound stalled model I/O, not task duration or tool execution. Never retry side effects.
export async function waitForModelIO<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("自动化模型响应长时间无数据，已停止等待；已执行操作不会自动重试。"));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
