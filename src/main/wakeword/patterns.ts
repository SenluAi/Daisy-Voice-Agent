export type WakePatternKind = "chinese" | "mixed" | "english";

export interface WakeMatch {
  kind: WakePatternKind;
  text: string;
  pattern: string;
}

const DAISY_LATIN = "(?:daizei|daisei|daisay|daixi|daisy|daesy|dancy|dansi|desis|daysi|dayzi|deisy|deizy|daisi|deis|desy|disy|deisce|basy|daiz|dais|danc|dan)";
const DAISY_STANDALONE_LATIN = "(?:daizei|daisei|daisay|daixi|daisy|daesy|dancy|dansi|desis|daiz|dais)";
const DAISY_CHINESE = "[呆戴代带袋大达黛德得的地迪蒂帝第低底][西茜希溪喜细熙析夕锡]";
const DAISY_CHINESE_MISHEARD = "[凡反繁烦][色瑟]";
const HEY_LATIN = "(?:hey|hi|hello|he)";

const WAKE_WORD_PATTERNS: { kind: WakePatternKind; pattern: RegExp }[] = [
  { kind: "chinese", pattern: new RegExp(`[嘿嗨黑喂欸诶][,\\s]*(?:${DAISY_CHINESE}|${DAISY_CHINESE_MISHEARD})`) },
  { kind: "mixed", pattern: new RegExp(`[你您尼泥拟面][好号][,\\s]*${DAISY_LATIN}\\b`, "i") },
  { kind: "chinese", pattern: new RegExp(`[你您尼泥拟面][好号][,\\s]*(?:${DAISY_CHINESE}|${DAISY_CHINESE_MISHEARD})`) },
  { kind: "mixed", pattern: new RegExp(`(?:ni\\s*hao|nihao)[,\\s]*${DAISY_LATIN}\\b`, "i") },
  { kind: "english", pattern: new RegExp(`\\b${HEY_LATIN}[,\\s]*${DAISY_LATIN}\\b`, "i") },
  { kind: "mixed", pattern: new RegExp(`\\b${HEY_LATIN}[,\\s]*(?:${DAISY_CHINESE}|${DAISY_CHINESE_MISHEARD})`, "i") },
  { kind: "mixed", pattern: new RegExp(`[嘿嗨黑喂欸诶][,\\s]*${DAISY_LATIN}\\b`, "i") },
  { kind: "english", pattern: new RegExp(`\\b${DAISY_STANDALONE_LATIN}\\b`, "i") },
];

export function findWakeWord(text: string): WakeMatch | null {
  const normalized = text.replace(/[\s,，。！!？?、~""''']/g, "");
  for (const { pattern, kind } of WAKE_WORD_PATTERNS) {
    const match = normalized.match(pattern) || text.match(pattern);
    if (match) return { kind, text: match[0], pattern: pattern.source };
  }
  return null;
}

export function extractWakeCommand(text: string): string {
  for (const { pattern } of WAKE_WORD_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const remaining = text.slice((match.index ?? 0) + match[0].length);
      return remaining.replace(/^[,，。！!？?、\s]+/, "").trim();
    }
  }
  return "";
}
