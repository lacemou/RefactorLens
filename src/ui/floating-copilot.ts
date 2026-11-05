import { App, Editor, MarkdownView, Notice } from "obsidian";

export interface FloatingCopilotHandlers {
  onTriggerCopilot: (editor: Editor, view: MarkdownView) => void;
  onSaveToScratchpad: (editor: Editor, view: MarkdownView) => void;
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
      this.floatingBallEl.style.display = view ? "flex" : "none";
    }
    this.hideSelectionPopover();
  }

  private createFloatingBall() {
    this.floatingBallEl = document.createElement("div");
    this.floatingBallEl.className = "refactor-floating-ball";
    this.floatingBallEl.innerHTML = `
      <span class="refactor-ball-icon">✨</span>
      <span class="refactor-ball-tooltip">RefactorLens AI 顾问</span>
    `;
    this.floatingBallEl.title = "点击呼出 Codex 改写顾问 (若已选中文本将直接改写)";

    this.floatingBallEl.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

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
        this.showBallActionMenu(e.clientX, e.clientY, editor, view);
      }
    });

    document.body.appendChild(this.floatingBallEl);
  }

  private registerSelectionListener() {
    document.addEventListener("pointerup", (e) => {
      setTimeout(() => {
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
        const domSel = window.getSelection()?.toString().trim() || "";
        const selection = editorSel || domSel;

        if (this.selectionPopoverEl && this.selectionPopoverEl.contains(e.target as Node)) {
          return;
        }

        if (selection.length > 0) {
          const isDeletedCardSelection = !editorSel && domSel.length > 0;
          this.showSelectionPopover(editor, view, selection, isDeletedCardSelection, e.clientX, e.clientY);
        } else {
          this.hideSelectionPopover();
        }
      }, 70);
    });
  }

  private showSelectionPopover(
    editor: Editor,
    view: MarkdownView,
    selectedText: string,
    isDeletedCardSelection: boolean,
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
    if (!isDeletedCardSelection) {
      const from = editor.getCursor("from");
      // @ts-ignore
      const cm = view.editor.cm;
      if (cm && cm.coordsAtPos) {
        const fromPos = editor.posToOffset(from);
        coords = cm.coordsAtPos(fromPos);
      }
    }

    this.selectionPopoverEl = document.createElement("div");
    this.selectionPopoverEl.className = "refactor-selection-popover";

    if (isDeletedCardSelection) {
      // 在已删除红字卡片中划选任意一句话
      this.selectionPopoverEl.innerHTML = `
        <button class="refactor-popover-btn refactor-btn-save" type="button">
          <span>📦</span> 暂存所选句子至抽屉
        </button>
        <span class="refactor-popover-divider"></span>
        <button class="refactor-popover-btn refactor-btn-copy" type="button">
          <span>📋</span> 复制
        </button>
      `;

      const saveBtn = this.selectionPopoverEl.querySelector(".refactor-btn-save");
      saveBtn?.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        const fileName = view.file?.basename || "已删除文字";
        const curPath = view.file?.path;
        // @ts-ignore
        await (this.app as any).plugins?.plugins["refactor-lens"]?.scratchpadManager?.addItem(
          selectedText,
          `${fileName}(选摘)`,
          curPath
        );
        new Notice("📦 已成功将所选删除句子暂存至灵感抽屉！");
      });

      const copyBtn = this.selectionPopoverEl.querySelector(".refactor-btn-copy");
      copyBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        navigator.clipboard.writeText(selectedText);
        new Notice("📋 已复制所选文字！");
      });
    } else {
      // 正常的编辑器正文划选
      this.selectionPopoverEl.innerHTML = `
        <button class="refactor-popover-btn refactor-btn-ai" type="button">
          <span>✨</span> AI 改写
        </button>
        <span class="refactor-popover-divider"></span>
        <button class="refactor-popover-btn refactor-btn-save" type="button">
          <span>📦</span> 暂存
        </button>
      `;

      const aiBtn = this.selectionPopoverEl.querySelector(".refactor-btn-ai");
      aiBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionPopover();
        this.isModalActive = true;
        this.handlers.onTriggerCopilot(editor, view);
      });

      const saveBtn = this.selectionPopoverEl.querySelector(".refactor-btn-save");
      saveBtn?.addEventListener("click", (e) => {
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

    this.selectionPopoverEl.style.top = `${top}px`;
    this.selectionPopoverEl.style.left = `${left}px`;

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

  private async showBallActionMenu(x: number, y: number, editor: Editor, view: MarkdownView) {
    const isReady = await this.handlers.isCodexReady();
    const oldMenu = document.querySelector(".refactor-context-menu");
    if (oldMenu) oldMenu.remove();

    const menu = document.createElement("div");
    menu.className = "refactor-context-menu refactor-ball-menu";
    menu.style.bottom = "75px";
    menu.style.right = "25px";

    menu.innerHTML = `
      <div class="refactor-menu-header">
        <span class="refactor-menu-title">✨ RefactorLens AI 助手</span>
        <span class="refactor-menu-status ${isReady ? "ready" : "warning"}">
          ${isReady ? "● Codex就绪" : "● 待配置"}
        </span>
      </div>
      <div class="refactor-menu-item" id="ball-action-copilot">
        <span class="refactor-menu-icon">✍️</span>
        <span class="refactor-menu-text">改写当前文稿 (先划选文字)</span>
      </div>
      <div class="refactor-menu-item" id="ball-action-scratchpad">
        <span class="refactor-menu-icon">📦</span>
        <span class="refactor-menu-text">打开灵感暂存抽屉</span>
      </div>
      <div class="refactor-menu-item" id="ball-action-settings">
        <span class="refactor-menu-icon">⚙️</span>
        <span class="refactor-menu-text">设置与快捷键自定义指南</span>
      </div>
    `;

    document.body.appendChild(menu);

    menu.querySelector("#ball-action-copilot")?.addEventListener("click", () => {
      new Notice("💡 提示：用鼠标在文稿中划选任意 1~2 句话，即可直接呼出改写顾问！");
      menu.remove();
    });

    menu.querySelector("#ball-action-scratchpad")?.addEventListener("click", () => {
      this.handlers.onOpenScratchpad();
      menu.remove();
    });

    menu.querySelector("#ball-action-settings")?.addEventListener("click", () => {
      this.handlers.onOpenSettings();
      menu.remove();
    });

    const closeListener = (evt: MouseEvent) => {
      if (!menu.contains(evt.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", closeListener);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", closeListener), 20);
  }

  public destroy() {
    this.hideSelectionPopover();
    if (this.floatingBallEl) {
      this.floatingBallEl.remove();
      this.floatingBallEl = null;
    }
  }
}
