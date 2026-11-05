const MIN_REUSABLE_CHARACTER_COUNT = 5;
const UNPUNCTUATED_SENTENCE_FALLBACK = 12;

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

  const meaningfulText = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  if (meaningfulText.length < MIN_REUSABLE_CHARACTER_COUNT) return false;

  const endsLikeSentence = /[。！？!?；;…](?:["'”’）)\]}】》]*)$/u.test(trimmed);
  return endsLikeSentence || meaningfulText.length >= UNPUNCTUATED_SENTENCE_FALLBACK;
}
