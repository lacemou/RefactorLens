const MIN_REUSABLE_CHARACTER_COUNT = 5;
const UNPUNCTUATED_SENTENCE_FALLBACK = 12;
const SENTENCE_ENDINGS = new Set<string>(["。", "！", "？", "!", "?", "；", ";", "…"]);
const CLOSING_PUNCTUATION = new Set<string>(["\"", "'", "”", "’", "）", ")", "]", "}", "】", "》"]);

export interface DeletedTextUnit {
  rawText: string;
  displayText: string;
}

function meaningfulCharacterCount(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

export function isTinyDeletedFragment(text: string): boolean {
  return meaningfulCharacterCount(text) <= 4;
}

/**
 * 灵感抽屉只接收具备独立表达价值的删除内容。
 *
 * 1～4 个有效字符永远不显示暂存入口；有句末标点且至少 5 个有效字符
 * 视为完整句子。没有句末标点时，至少 12 个有效字符才作为一句可复用
 * 表达的兜底。
 */
export function isScratchpadCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const meaningfulCount = meaningfulCharacterCount(trimmed);
  if (meaningfulCount < MIN_REUSABLE_CHARACTER_COUNT) return false;

  const endsLikeSentence = /[。！？!?；;…](?:["'”’）)\]}】》]*)$/u.test(trimmed);
  return endsLikeSentence || meaningfulCount >= UNPUNCTUATED_SENTENCE_FALLBACK;
}

/**
 * 把一个 Diff 删除块拆成可单独恢复的句子或行，同时保证所有 rawText
 * 顺序拼接后与原始删除内容完全一致。
 */
export function splitDeletedTextUnits(text: string): DeletedTextUnit[] {
  if (!text) return [];

  const rawUnits: string[] = [];
  let start = 0;
  let index = 0;

  const pushUntil = (end: number) => {
    if (end > start) rawUnits.push(text.slice(start, end));
    start = end;
    index = end;
  };

  while (index < text.length) {
    const char = text[index];
    let isSentenceEnd = SENTENCE_ENDINGS.has(char);

    if (char === ".") {
      const previous = text[index - 1] || "";
      const next = text[index + 1] || "";
      const isDecimalPoint = /\d/u.test(previous) && /\d/u.test(next);
      const isEllipsis = text.slice(index, index + 3) === "...";
      const endsBeforeSpace = !next || /\s/u.test(next) || CLOSING_PUNCTUATION.has(next);
      isSentenceEnd = !isDecimalPoint && (isEllipsis || endsBeforeSpace);
    }

    if (isSentenceEnd) {
      let end = index + 1;
      while (end < text.length && (text[end] === "." || text[end] === "…")) end += 1;
      while (end < text.length && CLOSING_PUNCTUATION.has(text[end])) end += 1;
      while (end < text.length && /[\t ]/u.test(text[end])) end += 1;
      pushUntil(end);
      continue;
    }

    if (char === "\n") {
      if (index > start) rawUnits.push(text.slice(start, index));
      let end = index + 1;
      while (end < text.length && (text[end] === "\n" || text[end] === "\r")) end += 1;
      rawUnits.push(text.slice(index, end));
      start = end;
      index = end;
      continue;
    }

    index += 1;
  }

  if (start < text.length) rawUnits.push(text.slice(start));

  const units: DeletedTextUnit[] = [];
  let leadingWhitespace = "";
  for (const rawText of rawUnits) {
    if (!rawText.trim()) {
      leadingWhitespace += rawText;
      continue;
    }

    const combinedRawText = leadingWhitespace + rawText;
    leadingWhitespace = "";
    units.push({
      rawText: combinedRawText,
      displayText: combinedRawText.trim(),
    });
  }

  if (leadingWhitespace && units.length > 0) {
    units[units.length - 1].rawText += leadingWhitespace;
  }

  return units;
}
