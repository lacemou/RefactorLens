import { App, Editor, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import { readDeletedSelection } from "./cm-decorations";

export interface FloatingCopilotHandlers {
  onTriggerCopilot: (editor: Editor, view: MarkdownView) => void;
  onSaveToScratchpad: (editor: Editor, view: MarkdownView) => void;
  onSaveDeletedSelection: (text: string, view: MarkdownView) => void;
}

export class FloatingCopilotManager {
  private app: App;
  private handlers: FloatingCopilotHandlers;

  private selectionPopoverEl: HTMLElement | null = null;
  private isModalActive: boolean = false;
  private selectionListener: ((event: PointerEvent) => void) | null = null;

  constructor(app: App, handlers: FloatingCopilotHandlers) {
    this.app = app;
    this.handlers = handlers;
    this.registerSelectionListener();
  }

  public setModalActive(active: boolean) {
    this.isModalActive = active;
    if (active) {
      this.hideSelectionPopover();
    }
  }

  private registerSelectionListener() {
    this.selectionListener = (e: PointerEvent) => {
      if (this.selectionPopoverEl?.contains(e.target as Node)) return;
      const startView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const initialCm = (startView?.editor as (Editor & { cm?: EditorView }) | undefined)?.cm;
      const initialSelection = initialCm?.contentDOM.ownerDocument.getSelection();
      // CodeMirror may normalize a boundary selection on its next update.
      const initialDeleted = initialCm && initialSelection ? readDeletedSelection(initialCm, initialSelection) : null;
      window.setTimeout(() => {
        // 如果当前有模态弹窗正在显示，绝对禁止浮现选区气泡！
        if (
          this.isModalActive ||
          document.querySelector(".refactor-copilot-modal-root") ||
          document.querySelector(".modal-container")
        ) {
          this.hideSelectionPopover();
          return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          this.hideSelectionPopover();
          return;
        }

        const editor = view.editor;
        const editorSel = editor.getSelection().trim();
        const cm = (editor as Editor & { cm?: EditorView }).cm;
        const browserSelection = cm?.contentDOM.ownerDocument.getSelection();
        const deleted = (cm && browserSelection ? readDeletedSelection(cm, browserSelection) : null) ??
          (view === startView && cm === initialCm ? initialDeleted : null);

        if (deleted || editorSel) {
          this.showSelectionPopover(editor, view, deleted, e.clientX, e.clientY);
        } else {
          this.hideSelectionPopover();
        }
      }, 70);
    };
    document.addEventListener("pointerup", this.selectionListener);
  }

  private showSelectionPopover(
    editor: Editor,
    view: MarkdownView,
    deleted: ReturnType<typeof readDeletedSelection>,
    mouseX?: number,
    mouseY?: number
  ) {
    // 再次确认模态框状态
    if (
      this.isModalActive ||
      document.querySelector(".refactor-copilot-modal-root") ||
      document.querySelector(".modal-container")
    ) {
      return;
    }

    this.hideSelectionPopover();

    let coords: { top: number; left: number; bottom: number } | null = null;
    if (!deleted) {
      const from = editor.getCursor("from");
      const cm = (view.editor as Editor & { cm?: EditorView }).cm;
      if (cm) {
        const fromPos = editor.posToOffset(from);
        coords = cm.coordsAtPos(fromPos);
      }
    }

    this.selectionPopoverEl = createDiv({ cls: "refactor-selection-popover" });

    if (deleted) {
      this.selectionPopoverEl.addEventListener("pointerdown", (event) => event.preventDefault());
      const restore = this.selectionPopoverEl.createEl("button", {
        cls: "refactor-popover-btn refactor-btn-ai",
        text: "↩ 恢复",
        type: "button",
      });
      restore.addEventListener("click", () => {
        this.hideSelectionPopover();
        deleted.restore();
      });
      this.selectionPopoverEl.createSpan({ cls: "refactor-popover-divider" });
      const saveBtn = this.selectionPopoverEl.createEl("button", {
        cls: "refactor-popover-btn refactor-btn-save",
        text: "📦 存灵感",
        type: "button",
      });
      saveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        this.handlers.onSaveDeletedSelection(deleted.text, view);
      });
    } else {
      // 正常的编辑器正文划选
      const aiBtn = this.selectionPopoverEl.createEl("button", {
        cls: "refactor-popover-btn refactor-btn-ai",
        text: "✨ AI 改写",
        type: "button",
      });
      this.selectionPopoverEl.createSpan({ cls: "refactor-popover-divider" });
      const saveBtn = this.selectionPopoverEl.createEl("button", {
        cls: "refactor-popover-btn refactor-btn-save",
        text: "📦 暂存",
        type: "button",
      });

      aiBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        this.isModalActive = true;
        this.handlers.onTriggerCopilot(editor, view);
      });

      saveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        this.handlers.onSaveToScratchpad(editor, view);
      });
    }

    const top = coords
      ? Math.max(10, coords.top - 38)
      : mouseY
      ? Math.max(10, mouseY - 42)
      : 80;
    const left = coords
      ? Math.max(10, coords.left)
      : mouseX
      ? Math.max(10, mouseX - 40)
      : 100;

    this.selectionPopoverEl.setCssStyles({ top: `${top}px`, left: `${left}px` });

    document.body.appendChild(this.selectionPopoverEl);
  }

  public hideSelectionPopover() {
    if (this.selectionPopoverEl) {
      this.selectionPopoverEl.remove();
      this.selectionPopoverEl = null;
    }
    // 彻底清除所有残余的选区气泡
    document.querySelectorAll(".refactor-selection-popover").forEach((el) => el.remove());
  }

  public destroy() {
    this.hideSelectionPopover();
    if (this.selectionListener) {
      document.removeEventListener("pointerup", this.selectionListener);
      this.selectionListener = null;
    }
  }
}
