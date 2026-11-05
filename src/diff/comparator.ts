import DiffMatchPatch from "diff-match-patch";

export interface DiffSegment {
  type: "equal" | "insert" | "delete";
  text: string;
  // 当前文档中的字符位置（对于 insert 和 equal 存在）
  from?: number;
  to?: number;
}

export interface DocumentDiffResult {
  segments: DiffSegment[];
  addedCount: number;
  deletedCount: number;
  unchangedCount: number;
  refactorRatio: number; // 重构率 0~100%
}

/**
 * 文案比对核心引擎
 * 比较 baselineText（参照底稿，如 V1）与 currentText（当前编辑稿，如 V3）
 */
export class CopywritingComparator {
  private dmp: DiffMatchPatch;

  constructor() {
    this.dmp = new DiffMatchPatch();
    // 针对中文文案优化：调整差异阈值与清理无意义字符跳跃
    this.dmp.Diff_EditCost = 4;
  }

  /**
   * 执行精细词句级 Diff 比对
   */
  public compare(baselineText: string, currentText: string): DocumentDiffResult {
    const rawDiffs = this.dmp.diff_main(baselineText, currentText);
    this.dmp.diff_cleanupSemantic(rawDiffs);

    const segments: DiffSegment[] = [];
    let currentOffset = 0;
    let addedCount = 0;
    let deletedCount = 0;
    let unchangedCount = 0;

    for (const [op, text] of rawDiffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        const from = currentOffset;
        currentOffset += text.length;
        segments.push({
          type: "equal",
          text,
          from,
          to: currentOffset,
        });
        unchangedCount += text.length;
      } else if (op === DiffMatchPatch.DIFF_INSERT) {
        // 当前文档新增的内容
        const from = currentOffset;
        currentOffset += text.length;
        segments.push({
          type: "insert",
          text,
          from,
          to: currentOffset,
        });
        addedCount += text.length;
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        // 参照底稿中存在、但在当前文档已被删除的内容
        // 在当前文档中没有实体 offset，它的锚定点位于当前的 currentOffset 处
        segments.push({
          type: "delete",
          text,
          from: currentOffset,
          to: currentOffset,
        });
        deletedCount += text.length;
      }
    }

    const totalChanges = addedCount + deletedCount;
    const baseLength = baselineText.length || 1;
    const refactorRatio = Math.min(100, Math.round((totalChanges / (baseLength + addedCount)) * 100));

    return {
      segments,
      addedCount,
      deletedCount,
      unchangedCount,
      refactorRatio,
    };
  }
}
