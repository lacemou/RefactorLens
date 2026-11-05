import { StateField, StateEffect, Transaction, type Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { DocumentDiffResult } from "../diff/comparator";
import { MovedPair } from "../diff/moved-detector";
import {
  DeletedTextUnit,
  isScratchpadCandidate,
  isTinyDeletedFragment,
  splitDeletedTextUnits,
} from "./deleted-text-policy";

type SaveTextCallback = (text: string) => Promise<void> | void;
let globalSaveCallback: SaveTextCallback | null = null;

export function registerDeletedTextSaveHandler(handler: SaveTextCallback) {
  globalSaveCallback = handler;
}

/**
 * 轻量行内删除痕迹。长段落也不再提升成块级卡片，以免打断正文。
 */
class DeletedUnitWidget extends WidgetType {
  private unit: DeletedTextUnit;
  private isLive: boolean;
  private fallbackPosition: number;

  constructor(unit: DeletedTextUnit, fallbackPosition: number, isLive: boolean = false) {
    super();
    this.unit = unit;
    this.fallbackPosition = fallbackPosition;
    this.isLive = isLive;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createSpan({ cls: "refactor-deleted-widget" });
    let restoredDoc: Text | undefined;

    const restoreText = () => {
      if (restoredDoc === view.state.doc || !view.contentDOM.contains(wrapper)) return;
      const insertPosition = view.posAtDOM(wrapper);
      const transaction = view.state.update({
        changes: { from: insertPosition, insert: this.unit.rawText },
        selection: { anchor: insertPosition },
        annotations: Transaction.userEvent.of("input.restore"),
      });
      // CodeMirror may reuse this DOM after undo; only guard the document produced by this click.
      restoredDoc = transaction.newDoc;
      view.dispatch(transaction);
      view.focus();
    };

    const leadingWhitespace = this.unit.rawText.match(/^\s*/u)?.[0] || "";
    const contentEnd = this.unit.rawText.length - (this.unit.rawText.match(/\s*$/u)?.[0].length || 0);
    const trailingWhitespace = this.unit.rawText.slice(contentEnd);

    if (leadingWhitespace) wrapper.appendText(leadingWhitespace);
    const unitEl = wrapper.createSpan({ cls: "refactor-deleted-unit" });

    const deletedTextEl = unitEl.createSpan({
      cls: `refactor-diff-deleted ${this.isLive ? "refactor-live-deleted" : ""}`,
      text: this.unit.displayText,
    });
    deletedTextEl.title = this.isLive ? "本次编辑中删除的内容" : "相对底稿已删除的内容";

    if (isTinyDeletedFragment(this.unit.displayText)) {
      unitEl.addClass("refactor-deleted-tiny");
      deletedTextEl.title += "；右键恢复";
      deletedTextEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        restoreText();
      });
    } else {
      const actions = unitEl.createSpan({ cls: "refactor-deleted-inline-actions" });
      const restoreButton = actions.createEl("button", {
        cls: "refactor-deleted-inline-btn refactor-deleted-restore-btn",
        text: "↩ 恢复",
        type: "button",
      });
      restoreButton.title = "只在这处红字的位置恢复，不跳转";
      restoreButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        restoreText();
      });

      if (isScratchpadCandidate(this.unit.displayText)) {
        const saveButton = actions.createEl("button", {
          cls: "refactor-deleted-inline-btn refactor-deleted-save-inline-btn",
          text: "📦 存灵感",
          type: "button",
        });
        saveButton.title = "只将这句删除内容保存到灵感抽屉";
        let saving = false;
        saveButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (saving || !globalSaveCallback) return;
          saving = true;
          saveButton.disabled = true;
          saveButton.setText("✓ 已存");
          void Promise.resolve(globalSaveCallback(this.unit.displayText)).catch(() => {
            saving = false;
            saveButton.disabled = false;
            saveButton.setText("📦 存灵感");
          });
        });
      }
    }

    if (trailingWhitespace) wrapper.appendText(trailingWhitespace);

    return wrapper;
  }

  eq(other: DeletedUnitWidget): boolean {
    return (
      other.unit.rawText === this.unit.rawText &&
      other.isLive === this.isLive &&
      other.fallbackPosition === this.fallbackPosition
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A move has one jump button at each end; the target also offers the original text.
 */
class MovedEndpointWidget extends WidgetType {
  constructor(private pair: MovedPair, private origin: boolean) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const container = this.origin
      ? createSpan({ cls: "refactor-moved-origin" })
      : createDiv({ cls: "refactor-moved-badge-container" });
    container.dataset.refactorMove = `${this.pair.id}:${this.origin ? "origin" : "target"}`;
    const badge = container.createEl("button", {
      cls: "refactor-moved-badge",
      type: "button",
      text: this.origin ? "↗ 跳到新位置" : "↩ 跳到搬迁前的位置",
    });
    badge.title = this.pair.cleanSnippet;
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!view.contentDOM.contains(container)) return;
      const side = this.origin ? "target" : "origin";
      const pair = view.state.field(movedPairsField).find((item) => item.id === this.pair.id);
      if (!pair) return;
      const pos = this.origin ? pair.targetFrom : pair.originAnchorPos;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      // The counterpart can be outside the viewport until the scroll is applied.
      view.requestMeasure({
        read: () => view.contentDOM.querySelector<HTMLButtonElement>(
          `[data-refactor-move="${pair.id}:${side}"] > button`
        ),
        write: (counterpart) => counterpart?.focus({ preventScroll: true }),
      });
    });
    if (this.origin) return container;

    const preview = container.createEl("button", { cls: "refactor-moved-badge", type: "button" });
    preview.setAttribute("aria-expanded", "false");
    const simPercent = Math.round(this.pair.similarity * 100);
    preview.setText(`底稿第 ${this.pair.originalSectionIndex} 段 · ${simPercent}% 相似 ▾`);

    const drawer = container.createDiv({ cls: "refactor-moved-drawer refactor-is-hidden" });
    const drawerHeader = drawer.createDiv({ cls: "refactor-drawer-header" });
    drawerHeader.createSpan({
      cls: "refactor-drawer-title",
      text: `【底稿原第 ${this.pair.originalSectionIndex} 节 原文对照】`,
    });
    const closeBtn = drawerHeader.createSpan({ cls: "refactor-drawer-close", text: "收起 ▴" });
    drawer.createDiv({ cls: "refactor-drawer-body", text: this.pair.originalText });

    preview.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const expanded = drawer.hasClass("refactor-is-hidden");
      drawer.toggleClass("refactor-is-hidden", !expanded);
      preview.setAttribute("aria-expanded", String(expanded));
    });

    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drawer.addClass("refactor-is-hidden");
      preview.setAttribute("aria-expanded", "false");
    });
    return container;
  }

  eq(other: MovedEndpointWidget): boolean {
    return this.origin === other.origin && other.pair.id === this.pair.id &&
      other.pair.originalText === this.pair.originalText && other.pair.similarity === this.pair.similarity;
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

export const movedPairsField = StateField.define<MovedPair[]>({
  create: () => [],
  update(pairs, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRefactorDiffEffect)) return effect.value.movedPairs;
    }
    return tr.docChanged ? pairs.map((pair) => ({
      ...pair,
      targetFrom: tr.changes.mapPos(pair.targetFrom, 1),
      originAnchorPos: tr.changes.mapPos(pair.originAnchorPos, -1),
    })) : pairs;
  },
});

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
        const renderedDeletionKeys = new Set<string>();

        // 1. 挂载段落搬家徽标
        for (const pair of movedPairs) {
          const targetPos = Math.min(docLength, Math.max(0, pair.targetFrom));
          items.push({
            from: targetPos,
            to: targetPos,
            deco: Decoration.widget({
              widget: new MovedEndpointWidget(pair, false),
              side: -1,
              block: true,
            }),
          });
          items.push({
            from: pair.originAnchorPos,
            to: pair.originAnchorPos,
            deco: Decoration.widget({ widget: new MovedEndpointWidget(pair, true), side: -1 }),
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

            renderedDeletionKeys.add(`${pos}\u0000${seg.text}`);
            for (const unit of splitDeletedTextUnits(seg.text)) {
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedUnitWidget(unit, pos, false),
                  side: 1,
                }),
              });
            }
          }
        }

        // 3. 挂载现场编辑的删除标记
        if (sessionLiveDeletes && sessionLiveDeletes.length > 0) {
          for (const item of sessionLiveDeletes) {
            const pos = Math.min(docLength, Math.max(0, item.pos));
            const cleanText = item.text.trim();
            if (cleanText.length === 0) continue;
            if (renderedDeletionKeys.has(`${pos}\u0000${item.text}`)) continue;

            for (const unit of splitDeletedTextUnits(item.text)) {
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedUnitWidget(unit, pos, true),
                  side: 1,
                }),
              });
            }
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

        return Decoration.set(items.map((item) => item.deco.range(item.from, item.to)), true);
      }
    }

    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
