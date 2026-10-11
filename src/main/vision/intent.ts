export function isScreenVisionRequest(text: string): boolean {
  const normalized = text
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?]/g, "")
    .toLowerCase();

  if (!normalized) return false;

  const subjectPattern = /(当前屏幕|屏幕内容|屏幕上|屏幕里|截屏|截图|看图|图片|图里|画面|页面|网页|窗口|弹窗|报错|错误提示|提示框|代码|表格)/;
  const actionPattern = /(看|看看|看下|看一下|帮我看|识别|总结|概括|解释|分析|读|翻译|哪里|什么|为什么|怎么回事|怎么办)/;
  const directPattern = /(看下这个报错|看看这个报错|帮我看这个报错|看一下屏幕内容|看看屏幕内容|看下当前屏幕|看看当前屏幕|识别当前屏幕|分析当前屏幕|帮我看屏幕|屏幕里写了什么|图里写了什么)/;

  return directPattern.test(normalized) || (subjectPattern.test(normalized) && actionPattern.test(normalized));
}


export function buildScreenVisionPrompt(userText: string, size: { width: number; height: number }): string {
  return [
    "用户通过语音让 Daisy 查看当前屏幕。请根据随消息附带的当前主屏幕截图回答。",
    `截图尺寸：${size.width}x${size.height}。`,
    "要求：",
    "- 直接回答用户问题，不要说你看不到图片。",
    "- 如果用户问报错，先说最可能原因，再给下一步处理建议。",
    "- 如果用户问总结页面，用简洁中文概括重点。",
    "- 默认 2 到 4 句话；只有用户明确要求详细时才展开。",
    "",
    `用户原话：${userText}`,
  ].join("\n");
}
