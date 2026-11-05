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

type SourceSpan = { live: boolean; from: number; to: number };
type RestoreRecord = { spans: SourceSpan[]; from: number; to: number; text: string };
type DiffSources = { key: string; baseline: string; live?: string };
const restoreEffect = StateEffect.define<RestoreRecord>();
export const resetRestores = StateEffect.define<null>();

export const restoredUnitsField = StateField.define<{ sources?: DiffSources; records: RestoreRecord[] }>({
  create: () => ({ records: [] }),
  update(value, tr) {
    let { sources, records } = value;
    if (tr.docChanged && records.length) {
      records = records.flatMap((record) => {
        const dormant = record.from === record.to;
        const from = tr.changes.mapPos(record.from, dormant ? -1 : 1);
        const to = tr.changes.mapPos(record.to, dormant ? 1 : -1);
        if ((!dormant || tr.isUserEvent("redo")) && to > from &&
            tr.newDoc.sliceString(from, to) === record.text) return [{ ...record, from, to }];
        if ((tr.isUserEvent("undo") && from === to) || (dormant && from === to)) {
          return [{ ...record, from, to: from }];
        }
        return [];
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(restoreEffect)) {
        records = records.filter((record) => record.from !== record.to);
        records.push(effect.value);
      } else if (effect.is(resetRestores)) {
        records = [];
        sources = undefined;
      } else if (effect.is(setRefactorDiffEffect)) {
        const next = effect.value.sources;
        if (sources?.key !== next?.key || sources?.baseline !== next?.baseline || sources?.live !== next?.live) records = [];
        sources = next;
      }
    }
    return { sources, records };
  },
});

const sameSpan = (a: SourceSpan, b: SourceSpan) => a.live === b.live && a.from === b.from && a.to === b.to;

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

  constructor(unit: DeletedTextUnit, fallbackPosition: number, readonly sources: SourceSpan[]) {
    super();
    this.unit = unit;
    this.fallbackPosition = fallbackPosition;
    this.isLive = sources[0].live;
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
        effects: restoreEffect.of({
          spans: this.sources,
          from: insertPosition,
          to: insertPosition + this.unit.rawText.length,
          text: this.unit.rawText,
        }),
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
      other.sources.length === this.sources.length &&
      this.sources.every((source, index) => sameSpan(source, other.sources[index])) &&
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
  sources?: DiffSources;
  liveDiff?: DocumentDiffResult;
}

export const setRefactorDiffEffect = StateEffect.define<RefactorDiffPayload>();

function remainingDeletion(text: string, start: number, spans: SourceSpan[]): { text: string; start: number }[] {
  const end = start + text.length;
  let cursor = start;
  const pieces: { text: string; start: number }[] = [];
  for (const span of spans) {
    if (span.to <= cursor) continue;
    if (span.from >= end) break;
    if (span.from > cursor) pieces.push({ text: text.slice(cursor - start, span.from - start), start: cursor });
    cursor = Math.min(end, span.to);
  }
  if (cursor < end) pieces.push({ text: text.slice(cursor - start), start: cursor });
  return pieces;
}

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
        const { diffResult, movedPairs, liveDiff } = effect.value;
        if (!diffResult) {
          return Decoration.none;
        }

        const docLength = tr.newDoc.length;
        const items: DecorationItem[] = [];
        const restored = (tr.state.field(restoredUnitsField, false)?.records ?? [])
          .filter((record) => record.to > record.from).flatMap((record) => record.spans);
        const deletions = new Map<string, { unit: DeletedTextUnit; pos: number; sources: SourceSpan[] }[]>();

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

        const addDiff = (diff: DocumentDiffResult, live: boolean) => {
          const covered = restored.filter((span) => span.live === live).sort((a, b) => a.from - b.from);
          let sourceOffset = 0;
          for (const seg of diff.segments) {
            const start = sourceOffset;
            if (seg.type !== "insert") sourceOffset += seg.text.length;
            const pos = Math.min(docLength, Math.max(0, seg.from ?? 0));
            if (seg.type === "insert") {
              const to = Math.min(docLength, seg.to ?? 0);
              if (pos < to) items.push({ from: pos, to, deco: Decoration.mark({
                class: live ? "refactor-live-added" : "refactor-diff-added",
              }) });
            } else if (seg.type === "delete") {
              for (const piece of remainingDeletion(seg.text, start, covered)) {
                let offset = piece.start;
                for (const unit of splitDeletedTextUnits(piece.text)) {
                  const span = { live, from: offset, to: offset + unit.rawText.length };
                  offset = span.to;
                  const key = `${pos}\u0000${unit.rawText}`;
                  const matches = deletions.get(key) ?? [];
                  const baselineMatch = live && matches.find((item) => !item.sources.some((source) => source.live));
                  if (baselineMatch) baselineMatch.sources.push(span);
                  else {
                    const entry = { unit, pos, sources: [span] };
                    matches.push(entry);
                    deletions.set(key, matches);
                    items.push({ from: pos, to: pos, deco: Decoration.widget({
                      widget: new DeletedUnitWidget(unit, pos, entry.sources), side: 1,
                    }) });
                  }
                }
              }
            }
          }
        };
        addDiff(diffResult, false);
        if (liveDiff) addDiff(liveDiff, true);

        return Decoration.set(items.map((item) => item.deco.range(item.from, item.to)), true);
      }
    }

    const restore = tr.effects.find((effect) => effect.is(restoreEffect));
    if (restore) {
      decorations = decorations.update({ filter: (_from, _to, decoration) => {
        const widget = (decoration.spec as { widget?: unknown }).widget;
        return !(widget instanceof DeletedUnitWidget &&
          widget.sources.some((source) => restore.value.spans.some((span) => sameSpan(source, span))));
      } });
    }
    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
