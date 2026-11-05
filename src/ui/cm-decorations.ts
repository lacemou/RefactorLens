import { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { DocumentDiffResult } from "../diff/comparator";
import { MovedPair } from "../diff/moved-detector";
import { isScratchpadCandidate } from "./deleted-text-policy";

type SaveTextCallback = (text: string) => void;
let globalSaveCallback: SaveTextCallback | null = null;

export function registerDeletedTextSaveHandler(handler: SaveTextCallback) {
  globalSaveCallback = handler;
}

/**
 * 轻量行内删除痕迹。长段落也不再提升成块级卡片，以免打断正文。
 */
class DeletedInlineWidget extends WidgetType {
  private deletedText: string;
  private isLive: boolean;
  private fallbackPosition: number;

  constructor(deletedText: string, fallbackPosition: number, isLive: boolean = false) {
    super();
    this.deletedText = deletedText;
    this.fallbackPosition = fallbackPosition;
    this.isLive = isLive;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createSpan({ cls: "refactor-deleted-widget" });
    const span = wrapper.createSpan({
      cls: `refactor-diff-deleted ${this.isLive ? "refactor-live-deleted" : ""}`,
      text: this.deletedText,
    });
    span.title = this.isLive ? "本次编辑中删除的内容" : "相对底稿已删除的内容";

    const actions = wrapper.createSpan({ cls: "refactor-deleted-inline-actions" });
    const restoreButton = actions.createEl("button", {
      cls: "refactor-deleted-inline-btn refactor-deleted-restore-btn",
      text: "↩ 恢复",
      type: "button",
    });
    restoreButton.title = "将这段删除内容直接恢复到原位置";
    restoreButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      let insertPosition = this.fallbackPosition;
      try {
        insertPosition = view.posAtDOM(wrapper, 0);
      } catch {
        // DOM 在差异刷新瞬间可能不可用，使用创建构件时的锚点兜底。
      }
      insertPosition = Math.min(view.state.doc.length, Math.max(0, insertPosition));
      view.dispatch({
        changes: { from: insertPosition, insert: this.deletedText },
        selection: { anchor: insertPosition + this.deletedText.length },
        scrollIntoView: true,
      });
      view.focus();
    });

    const textToSave = this.deletedText.trim();
    if (isScratchpadCandidate(textToSave)) {
      const saveButton = actions.createEl("button", {
        cls: "refactor-deleted-inline-btn refactor-deleted-save-inline-btn",
        text: "📦 存灵感",
        type: "button",
      });
      saveButton.title = "将这句删除内容保存到灵感抽屉";
      saveButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (globalSaveCallback) globalSaveCallback(textToSave);
      });
    }

    return wrapper;
  }

  eq(other: DeletedInlineWidget): boolean {
    return (
      other.deletedText === this.deletedText &&
      other.isLive === this.isLive &&
      other.fallbackPosition === this.fallbackPosition
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 搬迁段落段首交互式徽标 (MovedTargetWidget)
 */
class MovedTargetWidget extends WidgetType {
  private pair: MovedPair;
  private isExpanded: boolean = false;

  constructor(pair: MovedPair) {
    super();
    this.pair = pair;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = createDiv({ cls: "refactor-moved-badge-container" });

    const badge = container.createSpan({ cls: "refactor-moved-badge" });
    const simPercent = Math.round(this.pair.similarity * 100);
    badge.appendText(`📦 搬迁段落 · 来自原第 ${this.pair.originalSectionIndex} 节 (${simPercent}% 相似) `);
    const arrow = badge.createSpan({ cls: "refactor-toggle-arrow", text: "▾" });
    badge.title = "点击原地展开/收起底稿原文对照";

    const drawer = container.createDiv({ cls: "refactor-moved-drawer refactor-is-hidden" });
    const drawerHeader = drawer.createDiv({ cls: "refactor-drawer-header" });
    drawerHeader.createSpan({
      cls: "refactor-drawer-title",
      text: `【底稿原第 ${this.pair.originalSectionIndex} 节 原文对照】`,
    });
    const closeBtn = drawerHeader.createSpan({ cls: "refactor-drawer-close", text: "收起 ▴" });
    drawer.createDiv({ cls: "refactor-drawer-body", text: this.pair.originalText });

    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.isExpanded = !this.isExpanded;
      drawer.toggleClass("refactor-is-hidden", !this.isExpanded);
      arrow.setText(this.isExpanded ? "▴" : "▾");
    });

    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.isExpanded = false;
      drawer.addClass("refactor-is-hidden");
      arrow.setText("▾");
    });
    return container;
  }

  eq(other: MovedTargetWidget): boolean {
    return other.pair.id === this.pair.id;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export interface RefactorDiffPayload {
  diffResult: DocumentDiffResult | null;
  movedPairs: MovedPair[];
  sessionLiveDeletes?: Array<{ text: string; pos: number }>;
  sessionLiveInserts?: Array<{ from: number; to: number }>;
}

export const setRefactorDiffEffect = StateEffect.define<RefactorDiffPayload>();

interface DecorationItem {
  from: number;
  to: number;
  deco: Decoration;
}

export const refactorLensField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRefactorDiffEffect)) {
        const { diffResult, movedPairs, sessionLiveDeletes, sessionLiveInserts } = effect.value;
        if (!diffResult) {
          return Decoration.none;
        }

        const docLength = tr.newDoc.length;
        const items: DecorationItem[] = [];

        // 1. 挂载段落搬家徽标
        for (const pair of movedPairs) {
          const targetPos = Math.min(docLength, Math.max(0, pair.targetFrom));
          items.push({
            from: targetPos,
            to: targetPos,
            deco: Decoration.widget({
              widget: new MovedTargetWidget(pair),
              side: -1,
              block: true,
            }),
          });
        }

        // 2. 挂载基准差异（新增文字与删除文字）
        for (const seg of diffResult.segments) {
          if (seg.type === "insert") {
            const from = Math.min(docLength, Math.max(0, seg.from || 0));
            const to = Math.min(docLength, Math.max(0, seg.to || 0));
            if (from < to) {
              items.push({
                from,
                to,
                deco: Decoration.mark({
                  class: "refactor-diff-added",
                }),
              });
            }
          } else if (seg.type === "delete") {
            const pos = Math.min(docLength, Math.max(0, seg.from || 0));
            const cleanText = seg.text.trim();
            if (cleanText.length === 0) continue;

            items.push({
              from: pos,
              to: pos,
              deco: Decoration.widget({
                widget: new DeletedInlineWidget(seg.text, pos, false),
                side: 1,
              }),
            });
          }
        }

        // 3. 挂载现场编辑的删除标记
        if (sessionLiveDeletes && sessionLiveDeletes.length > 0) {
          for (const item of sessionLiveDeletes) {
            const pos = Math.min(docLength, Math.max(0, item.pos));
            const cleanText = item.text.trim();
            if (cleanText.length === 0) continue;

            items.push({
              from: pos,
              to: pos,
              deco: Decoration.widget({
                widget: new DeletedInlineWidget(item.text, pos, true),
                side: 1,
              }),
            });
          }
        }

        // 4. 挂载现场编辑的新增高亮
        if (sessionLiveInserts && sessionLiveInserts.length > 0) {
          for (const item of sessionLiveInserts) {
            const from = Math.min(docLength, Math.max(0, item.from));
            const to = Math.min(docLength, Math.max(0, item.to));
            if (from < to) {
              items.push({
                from,
                to,
                deco: Decoration.mark({
                  class: "refactor-live-added",
                }),
              });
            }
          }
        }

        // 5. 严格升序排序
        items.sort((a, b) => {
          if (a.from !== b.from) return a.from - b.from;
          return a.to - b.to;
        });

        // 6. 装配进 RangeSetBuilder
        const builder = new RangeSetBuilder<Decoration>();
        for (const item of items) {
          try {
            builder.add(item.from, item.to, item.deco);
          } catch (e) {
            console.warn("RefactorLens RangeSetBuilder 跳过:", item, e);
          }
        }

        return builder.finish();
      }
    }

    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
