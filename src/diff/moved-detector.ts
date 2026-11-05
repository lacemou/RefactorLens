import { CopywritingComparator } from "./comparator";
import { isScratchpadCandidate } from "../ui/deleted-text-policy";

export interface MovedPair {
  id: string; // 唯一配对 ID

  // 新位置（当前文档中的实际物理范围）
  targetFrom: number;
  targetTo: number;
  targetSectionIndex: number;

  // 原出处信息
  originalSectionIndex: number;
  originalText: string; // 底稿中的完整原始段落文本
  cleanSnippet: string; // 干净的原文摘要

  // 相似度
  similarity: number;
  // 相对位移方向
  direction: "up" | "down";
  // 原出处在当前文档中的对应参考位置（若原出处上下文仍存在）
  originAnchorPos: number;
}

/**
 * 段落级语义重定位检测器 (Paragraph-Level Relocation Detector)
 * 专为真实创作场景设计：
 * 1. 真实作者在搬迁段落时，往往会伴随改字、换格式（有序变无序）、润色语句等微调；
 * 2. 剥离 Markdown 语法标记与标点后，通过 2-gram 字符切片精确计算段落核心语义重合度；
 * 3. 只在匹配段落的相对顺序改变时推断搬迁。
 */
export class MovedBlockDetector {
  /**
   * 清理 Markdown 标记、标点与多余空白，提取纯正文语义字符
   */
  public cleanText(str: string): string {
    return str.replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  }

  /**
   * 采用 2-gram 双字切片相似度
   */
  public stringSimilarity(s1: string, s2: string): number {
    const str1 = this.cleanText(s1);
    const str2 = this.cleanText(s2);
    if (str1 === str2) return 1.0;
    if (str1.length < 2 || str2.length < 2) return 0.0;

    const bigrams1 = new Map<string, number>();
    for (let i = 0; i < str1.length - 1; i++) {
      const bg = str1.substring(i, i + 2);
      bigrams1.set(bg, (bigrams1.get(bg) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < str2.length - 1; i++) {
      const bg = str2.substring(i, i + 2);
      const count = bigrams1.get(bg) || 0;
      if (count > 0) {
        bigrams1.set(bg, count - 1);
        intersection++;
      }
    }

    return (2.0 * intersection) / (str1.length - 1 + str2.length - 1);
  }

  /**
   * 切分文本为段落块并记录真实的字符偏移区间
   */
  public splitParagraphs(text: string): Array<{ text: string; from: number; to: number; cleanLen: number }> {
    const blocks: Array<{ text: string; from: number; to: number; cleanLen: number }> = [];
    const lines = text.split("\n");
    let offset = 0;
    let buf = "";
    let start = 0;

    lines.forEach((line) => {
      if (line.trim() === "") {
        if (buf.trim().length > 0) {
          blocks.push({
            text: buf,
            from: start,
            to: start + buf.length,
            cleanLen: this.cleanText(buf).length,
          });
        }
        buf = "";
        offset += line.length + 1;
        start = offset;
      } else {
        if (buf.length === 0) start = offset;
        buf += (buf.length > 0 ? "\n" : "") + line;
        offset += line.length + 1;
      }
    });

    if (buf.trim().length > 0) {
      blocks.push({
        text: buf,
        from: start,
        to: start + buf.length,
        cleanLen: this.cleanText(buf).length,
      });
    }

    return blocks;
  }

  /**
   * 检测段落位移并返回精确搬迁对
   */
  public detect(
    baselineText: string,
    currentText: string,
    diff = new CopywritingComparator().compare(baselineText, currentText)
  ): MovedPair[] {
    const baseBlocks = this.splitParagraphs(baselineText);
    const currBlocks = this.splitParagraphs(currentText);
    type Match = { base: number; current: number; score: number };
    const bestBase = new Map<number, Match | null>();
    const bestCurrent = new Map<number, Match | null>();
    const scoresBase = new Map<number, number>();
    const scoresCurrent = new Map<number, number>();
    const pick = (matches: Map<number, Match | null>, scores: Map<number, number>, key: number, match: Match) => {
      const previous = scores.get(key) ?? 0;
      if (match.score > previous) {
        scores.set(key, match.score);
        matches.set(key, match);
      } else if (match.score === previous) {
        matches.set(key, null);
      }
    };

    currBlocks.forEach((cBlock, cIdx) => {
      if (cBlock.cleanLen <= 4) return;
      baseBlocks.forEach((bBlock, bIdx) => {
        if (bBlock.cleanLen <= 4) return;
        const score = this.stringSimilarity(cBlock.text, bBlock.text);
        if (score < 0.65) return;
        const match = { base: bIdx, current: cIdx, score };
        pick(bestBase, scoresBase, cIdx, match);
        pick(bestCurrent, scoresCurrent, bIdx, match);
      });
    });

    let baselineOffset = 0;
    const deletions = diff.segments.flatMap((segment) => {
      const start = baselineOffset;
      if (segment.type !== "insert") baselineOffset += segment.text.length;
      return segment.type === "delete" ? [{ start, end: baselineOffset, pos: segment.from ?? 0 }] : [];
    });
    const matches = [...bestBase.values()].filter((match): match is Match =>
      !!match && bestCurrent.get(match.base) === match
    );
    const anchors = matches.map(({ base }) => {
      const block = baseBlocks[base];
      let best: { length: number; pos: number } | undefined;
      for (const deletion of deletions) {
        const length = Math.min(deletion.end, block.to) - Math.max(deletion.start, block.from);
        if (length > (best?.length ?? 0)) best = { length, pos: deletion.pos };
      }
      return best && best.length * 2 >= block.text.length ? best.pos : undefined;
    });

    // Keep the largest set of matches that remain in order. Prefer matches
    // without a deletion anchor when more than one ordering explains the edit.
    const chain = matches.map((_, index) => ({ length: 1, stable: Number(anchors[index] === undefined), prev: -1 }));
    const better = (a: { length: number; stable: number }, b: { length: number; stable: number }) =>
      a.length > b.length || (a.length === b.length && a.stable > b.stable);
    let end = -1;
    for (let i = 0; i < matches.length; i++) {
      for (let j = 0; j < i; j++) {
        if (matches[j].base >= matches[i].base) continue;
        const candidate = { length: chain[j].length + 1, stable: chain[j].stable + Number(anchors[i] === undefined), prev: j };
        if (better(candidate, chain[i])) chain[i] = candidate;
      }
      if (end === -1 || better(chain[i], chain[end])) end = i;
    }
    const stable = new Set<number>();
    for (; end !== -1; end = chain[end].prev) stable.add(end);
    const neighbours = [...stable].map((i) => matches[i]).sort((a, b) => a.base - b.base);

    return matches.flatMap(({ base, current, score }, index) => {
      const source = baseBlocks[base];
      const target = currBlocks[current];
      if (stable.has(index) || !isScratchpadCandidate(source.text)) return [];
      const next = neighbours.find((match) => match.base > base);
      const previous = neighbours.filter((match) => match.base < base).pop();
      const left = previous ? currBlocks[previous.current].to : 0;
      const right = next ? currBlocks[next.current].from : currentText.length;
      const deletedAt = anchors[index];
      const origin = deletedAt !== undefined && deletedAt >= left && deletedAt <= right
        ? deletedAt : next ? right : left;
      if (origin >= target.from && origin <= target.to) return [];

      return [{
        id: `moved-${base}-${current}`,
        targetFrom: target.from,
        targetTo: target.to,
        targetSectionIndex: current + 1,
        originalSectionIndex: base + 1,
        originalText: source.text.trim(),
        cleanSnippet: source.text.trim().slice(0, 40),
        similarity: score,
        direction: target.from > origin ? "down" as const : "up" as const,
        originAnchorPos: origin,
      }];
    });
  }
}
