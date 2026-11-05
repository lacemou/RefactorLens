import { App, Editor, MarkdownView, Notice } from "obsidian";
import { EditorView } from "@codemirror/view";
import { readDeletedSelection } from "./cm-decorations";

export interface FloatingCopilotHandlers {
  onTriggerCopilot: (editor: Editor, view: MarkdownView) => void;
  onSaveToScratchpad: (editor: Editor, view: MarkdownView) => void;
  onSaveDeletedSelection: (text: string, view: MarkdownView) => void;
  onOpenScratchpad: () => void;
  isCodexReady: () => Promise<boolean>;
  onOpenSettings: () => void;
}

export class FloatingCopilotManager {
  private app: App;
  private handlers: FloatingCopilotHandlers;

  private selectionPopoverEl: HTMLElement | null = null;
  private floatingBallEl: HTMLElement | null = null;
  private activeView: MarkdownView | null = null;
  private isModalActive: boolean = false;
  private selectionListener: ((event: PointerEvent) => void) | null = null;

  constructor(app: App, handlers: FloatingCopilotHandlers) {
    this.app = app;
    this.handlers = handlers;
    this.createFloatingBall();
    this.registerSelectionListener();
  }

  public setModalActive(active: boolean) {
    this.isModalActive = active;
    if (active) {
      this.hideSelectionPopover();
    }
  }

  public attachToView(view: MarkdownView | null) {
    this.activeView = view;
    if (this.floatingBallEl) {
      this.floatingBallEl.toggleClass("refactor-is-hidden", !view);
    }
    this.hideSelectionPopover();
  }

  private createFloatingBall() {
    this.floatingBallEl = createDiv({ cls: "refactor-floating-ball" });
    this.floatingBallEl.createSpan({ cls: "refactor-ball-icon", text: "✨" });
    this.floatingBallEl.createSpan({ cls: "refactor-ball-tooltip", text: "RefactorLens AI 顾问" });
    this.floatingBallEl.title = "点击呼出改写顾问（若已选中文本将直接改写）";

    this.floatingBallEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.handleFloatingBallClick();
    });

    document.body.appendChild(this.floatingBallEl);
  }

  private async handleFloatingBallClick(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("请先打开一篇 Markdown 文稿");
      return;
    }

    const editor = view.editor;
    const selection = editor.getSelection().trim();

    if (selection) {
      this.hideSelectionPopover();
      this.handlers.onTriggerCopilot(editor, view);
    } else {
      await this.showBallActionMenu();
    }
  }

  private registerSelectionListener() {
    this.selectionListener = (e: PointerEvent) => {
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
        const browserSelection = window.getSelection();
        const cm = (editor as Editor & { cm?: EditorView }).cm;
        const deleted = cm && browserSelection ? readDeletedSelection(cm, browserSelection) : null;

        if (this.selectionPopoverEl && this.selectionPopoverEl.contains(e.target as Node)) {
          return;
        }

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

  private async showBallActionMenu(): Promise<void> {
    const isReady = await this.handlers.isCodexReady();
    const oldMenu = document.querySelector(".refactor-context-menu");
    if (oldMenu) oldMenu.remove();

    const menu = createDiv({ cls: "refactor-context-menu refactor-ball-menu" });
    const header = menu.createDiv({ cls: "refactor-menu-header" });
    header.createSpan({ cls: "refactor-menu-title", text: "✨ RefactorLens AI 助手" });
    header.createSpan({
      cls: `refactor-menu-status ${isReady ? "ready" : "warning"}`,
      text: isReady ? "● CLI 就绪" : "● 待配置",
    });
    const copilotAction = this.createMenuItem(menu, "✍️", "改写当前文稿 (先划选文字)");
    const scratchpadAction = this.createMenuItem(menu, "📦", "打开灵感暂存抽屉");
    const settingsAction = this.createMenuItem(menu, "⚙️", "设置与快捷键自定义指南");

    document.body.appendChild(menu);

    copilotAction.addEventListener("click", () => {
      new Notice("💡 提示：用鼠标在文稿中划选任意 1~2 句话，即可直接呼出改写顾问！");
      menu.remove();
    });

    scratchpadAction.addEventListener("click", () => {
      this.handlers.onOpenScratchpad();
      menu.remove();
    });

    settingsAction.addEventListener("click", () => {
      this.handlers.onOpenSettings();
      menu.remove();
    });

    const closeListener = (evt: MouseEvent) => {
      if (!menu.contains(evt.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", closeListener);
      }
    };
    window.setTimeout(() => document.addEventListener("pointerdown", closeListener), 20);
  }

  private createMenuItem(parent: HTMLElement, icon: string, label: string): HTMLElement {
    const item = parent.createDiv({ cls: "refactor-menu-item" });
    item.createSpan({ cls: "refactor-menu-icon", text: icon });
    item.createSpan({ cls: "refactor-menu-text", text: label });
    return item;
  }

  public destroy() {
    this.hideSelectionPopover();
    if (this.selectionListener) {
      document.removeEventListener("pointerup", this.selectionListener);
      this.selectionListener = null;
    }
    if (this.floatingBallEl) {
      this.floatingBallEl.remove();
      this.floatingBallEl = null;
    }
  }
}
