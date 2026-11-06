import { EditorSelection, StateField, StateEffect, Transaction, type ChangeSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { Menu } from "obsidian";
import { DocumentDiffResult } from "../diff/comparator";
import { MovedPair } from "../diff/moved-detector";
import {
  DeletedTextUnit,
  splitDeletedTextUnits,
} from "./deleted-text-policy";

type SourceSpan = { live: boolean; from: number; to: number };
type Deletion = { unit: DeletedTextUnit; sources: SourceSpan[] };
type PlacedDeletion = Deletion & { pos: number; before: boolean; relative?: number };
type RestoreRecord = {
  id: number; spans: SourceSpan[]; from: number; to: number; text: string;
  pins: PlacedDeletion[]; origin?: number; originText?: string; status: "active" | "undone" | "missing";
};
type DiffSources = { key: string; baseline: string; live?: string };
const restoreEffect = StateEffect.define<RestoreRecord[]>();
export const resetRestores = StateEffect.define<null>();
let nextRestoreId = 1;

function uniqueOffset(doc: string, text: string): number | undefined {
  const index = text ? doc.indexOf(text) : -1;
  return index >= 0 && doc.indexOf(text, index + 1) === -1 ? index : undefined;
}

export const restoredUnitsField = StateField.define<{ sources?: DiffSources; records: RestoreRecord[] }>({
  create: () => ({ records: [] }),
  update(value, tr) {
    let { sources, records } = value;
    if (tr.docChanged && records.length) {
      records = records.flatMap<RestoreRecord>((record) => {
        const dormant = record.status === "undone";
        const from = tr.changes.mapPos(record.from, dormant ? -1 : 1);
        const to = tr.changes.mapPos(record.to, dormant ? 1 : -1);
        const mapped = {
          ...record, from, to,
          origin: record.origin === undefined ? undefined : tr.changes.mapPos(record.origin, -1),
          pins: record.pins.map((pin) => ({ ...pin, pos: tr.changes.mapPos(pin.pos, pin.before ? -1 : 1) })),
        };
        if ((!dormant || tr.isUserEvent("redo")) && to > from &&
            tr.newDoc.sliceString(from, to) === record.text) return [{
          ...mapped, status: "active",
          pins: dormant ? mapped.pins.map((pin) => pin.relative === undefined ? pin : { ...pin, pos: from + pin.relative }) : mapped.pins,
        }];
        if ((tr.isUserEvent("undo") && from === to) || (dormant && from === to)) {
          return [{ ...mapped, status: "undone" }];
        }
        if (record.origin !== undefined && !dormant) {
          // Cut/paste commonly selects the visible sentence without its surrounding line breaks.
          const text = record.text.trim();
          const found = uniqueOffset(tr.newDoc.toString(), text);
          let insertedHere = false;
          tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
            if (found !== undefined && fromB <= found && found + text.length <= toB) insertedHere = true;
          });
          if (found !== undefined && insertedHere) return [{ ...mapped, from: found, to: found + text.length, text, status: "active" }];
          return [{ ...mapped, to: from, status: "missing" }];
        }
        return [];
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(restoreEffect)) {
        records = records.filter((record) => record.status !== "undone").concat(effect.value);
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
  provide: (field) => EditorView.decorations.from(field, ({ records }) => Decoration.set(
    records.flatMap((record) => {
      if (record.origin === undefined || record.status === "undone") return [];
      const active = record.status === "active";
      const origin = Decoration.widget({ widget: new RestoredLink(record.id, true, active, record.originText), side: 0 }).range(record.origin);
      return active
        ? [origin, Decoration.widget({ widget: new RestoredLink(record.id, false, true), side: 1 }).range(record.to)]
        : [origin];
    }), true
  )),
});

const sameSpan = (a: SourceSpan, b: SourceSpan) => a.live === b.live && a.from === b.from && a.to === b.to;
const overlap = (a: SourceSpan, b: SourceSpan) => a.live === b.live && a.from < b.to && b.from < a.to;
const deletionKey = (item: Deletion) => item.sources.map((s) => `${Number(s.live)}:${s.from}:${s.to}`).join("/");
const deletedElements = new WeakMap<Element, { view: EditorView; widget: DeletedUnitWidget }>();

/**
 * 轻量行内删除痕迹。长段落也不再提升成块级卡片，以免打断正文。
 */
class DeletedUnitWidget extends WidgetType implements Deletion {
  constructor(readonly unit: DeletedTextUnit, readonly sources: SourceSpan[], readonly before = false) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createSpan({ cls: "refactor-deleted-widget" });
    const leadingWhitespace = this.unit.rawText.match(/^\s*/u)?.[0] || "";
    const trailingWhitespace = this.unit.rawText.slice(leadingWhitespace.length + this.unit.displayText.length);

    if (leadingWhitespace) wrapper.appendText(leadingWhitespace);
    const unitEl = wrapper.createSpan({ cls: "refactor-deleted-unit" });

    const deletedTextEl = unitEl.createSpan({
      cls: `refactor-diff-deleted ${this.sources[0].live ? "refactor-live-deleted" : ""}`,
      text: this.unit.displayText,
    });
    deletedTextEl.title = "划选后恢复或存灵感；右键查看恢复方式";
    deletedElements.set(deletedTextEl, { view, widget: this });
    deletedTextEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const picked = [{ widget: this, from: 0, to: this.unit.rawText.length }];
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("恢复").onClick(() => restoreDeleted(view, picked, deletedTextEl)));
      if (originalDestination(view, this) !== undefined) {
        menu.addItem((item) => item.setTitle("恢复到原出处").onClick(() => restoreDeleted(view, picked, deletedTextEl, true)));
      }
      menu.showAtMouseEvent(event);
    });

    if (trailingWhitespace) wrapper.appendText(trailingWhitespace);

    return wrapper;
  }

  eq(other: DeletedUnitWidget): boolean {
    return (
      other.unit.rawText === this.unit.rawText &&
      other.before === this.before &&
      other.sources.length === this.sources.length &&
      this.sources.every((source, index) => sameSpan(source, other.sources[index]))
    );
  }

  ignoreEvent(): boolean {
    // Let Chromium create a native text selection instead of starting a CodeMirror document selection.
    return true;
  }
}

type PickedDeletion = { widget: DeletedUnitWidget; from: number; to: number };

export function readDeletedSelection(view: EditorView, selection: Selection) {
  if (selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!view.contentDOM.contains(range.commonAncestorContainer)) return null;
  const picked: PickedDeletion[] = [];
  let first: { element: Element; node: Node; offset: number } | undefined;
  let last: { node: Node; offset: number } | undefined;
  for (const element of Array.from(view.contentDOM.querySelectorAll(".refactor-deleted-widget .refactor-diff-deleted"))) {
    const entry = deletedElements.get(element);
    const node = element.firstChild;
    if (entry?.view !== view || !node || !range.intersectsNode(element)) continue;
    const { widget } = entry;
    const raw = widget.unit.rawText;
    const length = widget.unit.displayText.length;
    const startOffset = range.startContainer === node ? range.startOffset : 0;
    const endOffset = range.endContainer === node ? range.endOffset : length;
    // A boundary can be on the wrapper, a neighboring whitespace node, or the
    // end of the preceding red span. Count characters, not intersected elements.
    if (startOffset >= endOffset || range.comparePoint(node, startOffset) !== 0 ||
        range.comparePoint(node, endOffset) !== 0) continue;
    const leading = raw.length - raw.trimStart().length;
    if (!first) first = { element, node, offset: startOffset };
    last = { node, offset: endOffset };
    picked.push({
      widget,
      from: startOffset === 0 ? 0 : leading + startOffset,
      to: endOffset === length ? raw.length : leading + endOffset,
    });
  }
  if (!first || !last) return null;
  const leadingSelection = range.cloneRange();
  leadingSelection.setEnd(first.node, first.offset);
  const trailingSelection = range.cloneRange();
  trailingSelection.setStart(last.node, last.offset);
  // Do not hijack a normal prose selection that merely crosses a deletion widget.
  if (/[^\s\u200b\ufeff]/u.test(leadingSelection.toString() + trailingSelection.toString())) return null;
  const text = picked.map(({ widget, from, to }) => widget.unit.rawText.slice(from, to)).join("").trim();
  const anchor = first.element;
  return text ? { text, restore: () => restoreDeleted(view, picked, anchor) } : null;
}

function originalDestination(view: EditorView, item: Deletion): number | undefined {
  const source = item.sources.find((span) => !span.live);
  const baseline = view.state.field(restoredUnitsField).sources?.baseline;
  if (!source || baseline === undefined) return;
  // Require exact, unique context on both sides. Never treat a baseline line number as a current offset.
  const left = baseline.slice(Math.max(0, source.from - 32), source.from);
  const right = baseline.slice(source.to, source.to + 32);
  if (left.trim().length < 6 || right.trim().length < 6) return;
  const doc = view.state.doc.toString();
  const before = uniqueOffset(doc, left);
  const after = uniqueOffset(doc, right);
  if (before !== undefined && after !== undefined && before + left.length === after) return after;
}

function sliceDeletion(widget: Deletion, from: number, to: number): Deletion {
  const rawText = widget.unit.rawText.slice(from, to);
  return {
    unit: { rawText, displayText: rawText.trim() },
    sources: widget.sources.map((span) => ({ ...span, from: span.from + from, to: span.from + to })),
  };
}

const widgetOf = (decoration: Decoration) => (decoration.spec as { widget?: unknown }).widget;

export function restoreDeleted(view: EditorView, picked: PickedDeletion[], element: Element, original = false) {
  if (!view.contentDOM.contains(element)) return;
  const wanted = new Map(picked.map((part) => [deletionKey(part.widget), part]));
  const groups = new Map<number, DeletedUnitWidget[]>();
  for (const cursor = view.state.field(refactorLensField).iter(); cursor.value; cursor.next()) {
    const widget = widgetOf(cursor.value);
    if (!(widget instanceof DeletedUnitWidget)) continue;
    const siblings = groups.get(cursor.from) ?? [];
    siblings.push(widget);
    groups.set(cursor.from, siblings);
  }
  const changes: ChangeSpec[] = [];
  const records: RestoreRecord[] = [];
  let offset = 0;
  let localAnchor = 0;
  for (const [anchor, siblings] of groups) {
    if (!siblings.some((widget) => wanted.has(deletionKey(widget)))) continue;
    const originTarget = original && picked.length === 1 ? originalDestination(view, picked[0].widget) : undefined;
    if (original && originTarget === undefined) return;
    const target = originTarget ?? anchor;
    const remote = target !== anchor;
    const pins: PlacedDeletion[] = [];
    const spans: SourceSpan[] = [];
    let text = "";
    const pin = (item: Deletion, before: boolean) => {
      if (item.unit.rawText) pins.push({
        ...item, pos: remote ? anchor + (target < anchor ? text.length : 0) : anchor + offset + text.length,
        before, relative: remote ? undefined : text.length,
      });
    };
    for (const widget of siblings) {
      const part = wanted.get(deletionKey(widget));
      if (!part) { pin(widget, !text); continue; }
      pin(sliceDeletion(widget, 0, part.from), !text);
      const restored = sliceDeletion(widget, part.from, part.to);
      text += restored.unit.rawText;
      spans.push(...restored.sources);
      pin(sliceDeletion(widget, part.to, widget.unit.rawText.length), false);
    }
    if (!text) continue;
    if (remote) for (const pin of pins) pin.pos = anchor + (target < anchor ? text.length : 0);
    const from = target + offset;
    changes.push({ from: target, insert: text });
    localAnchor = remote ? anchor + (target < anchor ? text.length : 0) : from;
    records.push({
      id: nextRestoreId++, spans, from, to: from + text.length, text, pins,
      origin: remote ? localAnchor : undefined, originText: remote ? text : undefined, status: "active",
    });
    offset += text.length;
  }
  const record = records.at(-1);
  if (!record) return;
  viewportPins.set(view, { id: records[0].id, top: element.getClientRects?.()[0]?.top ?? element.getBoundingClientRect().top });
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(record.origin ?? record.to),
    effects: restoreEffect.of(records),
    annotations: Transaction.userEvent.of("input.restore"),
  });
  view.focus();
}

const viewportPins = new WeakMap<EditorView, { id: number; top: number }>();
export const restoreViewport = ViewPlugin.define(() => ({
  update(update) {
    let pin = viewportPins.get(update.view);
    const history = update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"));
    if (!pin && history) {
      const previous = update.startState.field(restoredUnitsField).records;
      const next = update.state.field(restoredUnitsField).records;
      const changed = next.find((record) => previous.some((old) => old.id === record.id && old.status !== record.status));
      const selection = update.view.dom.ownerDocument.getSelection();
      if (changed && selection?.rangeCount && update.view.contentDOM.contains(selection.anchorNode)) {
        const top = selection.getRangeAt(0).getBoundingClientRect().top;
        const bounds = update.view.scrollDOM.getBoundingClientRect();
        if (top >= bounds.top && top < bounds.bottom) {
          pin = { id: changed.id, top };
          viewportPins.set(update.view, pin);
        }
      }
    }
    if (!pin) return;
    const restore = update.transactions.some((tr) => tr.isUserEvent("input.restore") || tr.isUserEvent("undo") || tr.isUserEvent("redo"));
    const refresh = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setRefactorDiffEffect)));
    if (update.docChanged && !restore) { viewportPins.delete(update.view); return; }
    if (!restore && !refresh) return;
    const record = update.state.field(restoredUnitsField).records.find((item) => item.id === pin.id);
    if (!record) return;
    const view = update.view;
    view.requestMeasure({
      key: pin,
      read: () => {
        const link = record.origin === undefined ? null :
          view.contentDOM.querySelector(`[data-refactor-restore-origin="${record.id}"]`);
        const red = record.status === "undone" ? Array.from(view.contentDOM.querySelectorAll(".refactor-deleted-widget .refactor-diff-deleted"))
          .find((el) => deletedElements.get(el)?.widget.sources.some((span) => record.spans.some((source) => overlap(source, span)))) : undefined;
        const leading = record.text.length - record.text.trimStart().length;
        const position = record.origin ?? (record.status === "active" ? record.from + leading : record.from);
        const y = (link ?? red)?.getClientRects()[0]?.top ?? view.coordsAtPos(position, 1)?.top;
        return y === undefined ? 0 : y - pin.top;
      },
      write: (delta) => {
        if (viewportPins.get(view) !== pin) return;
        if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta;
        if (refresh) viewportPins.delete(view);
      },
    });
  },
}));

class RestoredLink extends WidgetType {
  constructor(readonly id: number, readonly origin: boolean, readonly enabled: boolean, readonly text = "") { super(); }
  eq(other: RestoredLink) { return this.id === other.id && this.origin === other.origin && this.enabled === other.enabled && this.text === other.text; }
  toDOM(view: EditorView) {
    const root = createSpan({ cls: "refactor-restored-link" });
    if (this.origin) root.appendText(this.text.match(/^\s*/u)?.[0] ?? "");
    const button = root.createEl("button", {
      type: "button", cls: "refactor-moved-badge",
      text: this.origin ? (this.enabled ? "已恢复 ↗" : "已恢复 · 无法定位") : "↩ 返回操作处",
    });
    if (this.origin) {
      button.dataset.refactorRestoreOrigin = String(this.id);
      root.appendText(this.text.match(/\s*$/u)?.[0] ?? "");
    }
    button.disabled = !this.enabled;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const record = view.state.field(restoredUnitsField).records.find((entry) => entry.id === this.id);
      const pos = this.origin ? record?.from : record?.origin;
      if (record?.status !== "active" || pos === undefined) return;
      viewportPins.delete(view);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    });
    return root;
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

function projection(records: RestoreRecord[]) {
  const active = records.filter((record) => record.status === "active");
  const restored = active.flatMap((record) => record.spans);
  const pins: PlacedDeletion[] = [];
  for (const record of active.slice().reverse()) {
    const covered = restored.concat(pins.flatMap((pin) => pin.sources));
    pins.push(...record.pins.filter((pin) => !pin.sources.some((span) => covered.some((other) => overlap(span, other)))));
  }
  return { pins, covered: restored.concat(pins.flatMap((pin) => pin.sources)) };
}

function pinnedDecoration(pin: PlacedDeletion) {
  return Decoration.widget({ widget: new DeletedUnitWidget(pin.unit, pin.sources, pin.before), side: pin.before ? -1 : 1 });
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
        const { pins, covered } = projection(tr.state.field(restoredUnitsField, false)?.records ?? []);
        for (const pin of pins) {
          items.push({ from: pin.pos, to: pin.pos, deco: pinnedDecoration(pin) });
        }
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
          const coveredSource = covered.filter((span) => span.live === live).sort((a, b) => a.from - b.from);
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
              for (const piece of remainingDeletion(seg.text, start, coveredSource)) {
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
                      widget: new DeletedUnitWidget(unit, entry.sources), side: 1,
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
      const touched = restore.value.flatMap((record) => record.spans.concat(record.pins.flatMap((pin) => pin.sources)));
      decorations = decorations.update({ filter: (_from, _to, decoration) => {
        const widget = widgetOf(decoration);
        return !(widget instanceof DeletedUnitWidget &&
          widget.sources.some((source) => touched.some((span) => overlap(source, span))));
      } });
      return decorations.map(tr.changes).update({
        add: restore.value.flatMap((record) => record.pins.map((pin) => pinnedDecoration(pin).range(pin.pos))),
        sort: true,
      });
    }
    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
