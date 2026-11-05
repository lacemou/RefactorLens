import { ItemView, WorkspaceLeaf, Notice, MarkdownView, TFile } from "obsidian";
import { ScratchpadManager, ScratchpadItem } from "./scratchpad-manager";

export const VIEW_TYPE_SCRATCHPAD = "refactor-lens-scratchpad-view";

export class ScratchpadView extends ItemView {
  private manager: ScratchpadManager;
  private itemsContainer: HTMLElement;
  private countBadge: HTMLElement;
  private pathHintEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private currentFilter: string = "";

  private unsubscribeUpdate: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, manager: ScratchpadManager) {
    super(leaf);
    this.manager = manager;
    // 监听全局数据变更，毫秒级自动刷新
    this.unsubscribeUpdate = this.manager.onUpdate(() => {
      this.refresh();
    });
  }

  getViewType(): string {
    return VIEW_TYPE_SCRATCHPAD;
  }

  getDisplayText(): string {
    return "📦 灵感暂存抽屉";
  }

  getIcon(): string {
    return "archive";
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("refactor-scratchpad-view-root");

    // 1. 顶部 Header
    const headerEl = container.createDiv({ cls: "refactor-scratchpad-header" });
    const titleBox = headerEl.createDiv({ cls: "refactor-scratchpad-title-box" });
    titleBox.createSpan({ text: "📦 灵感暂存", cls: "refactor-scratchpad-title" });
    this.countBadge = titleBox.createSpan({ text: "(0)", cls: "refactor-scratchpad-badge" });

    const btnBox = headerEl.createDiv({ cls: "refactor-scratchpad-actions" });
    const refreshBtn = btnBox.createEl("button", {
      text: "刷新",
      cls: "refactor-btn-sm",
    });
    refreshBtn.addEventListener("click", () => this.refresh());

    const clearBtn = btnBox.createEl("button", {
      text: "清空",
      cls: "refactor-btn-sm refactor-btn-danger",
    });
    clearBtn.addEventListener("click", async () => {
      if (confirm("确定要清空当前灵感抽屉中的所有素材吗？此操作无法撤销。")) {
        const curPath = this.getRecentMarkdownView()?.file?.path;
        await this.manager.clearAll(curPath);
        new Notice("灵感暂存抽屉已清空");
        await this.refresh();
      }
    });

    // 当前物理存储路径提示
    this.pathHintEl = container.createDiv({ cls: "refactor-scratchpad-path-hint" });

    // 2. 搜索过滤栏
    const searchBox = container.createDiv({ cls: "refactor-scratchpad-search-box" });
    this.searchInput = searchBox.createEl("input", {
      type: "text",
      placeholder: "搜索暂存灵感...",
      cls: "refactor-scratchpad-search-input",
    });
    this.searchInput.addEventListener("input", (e) => {
      this.currentFilter = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderItems();
    });

    // 3. 条目列表容器
    this.itemsContainer = container.createDiv({ cls: "refactor-scratchpad-list" });

    await this.refresh();
  }

  async onClose() {
    if (this.unsubscribeUpdate) {
      this.unsubscribeUpdate();
      this.unsubscribeUpdate = null;
    }
  }

  public async refresh() {
    await this.renderItems();
  }

  /**
   * 获取最近活跃的 Markdown 视图（彻底根治侧边栏夺走焦点导致 getActiveViewOfType 为空的 Bug）
   */
  private getRecentMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        return leaf.view;
      }
    }
    return null;
  }

  private async renderItems() {
    this.itemsContainer.empty();
    const recentView = this.getRecentMarkdownView();
    const curPath = recentView?.file?.path;
    const resolvedFilePath = this.manager.resolveFilePath(curPath);

    this.pathHintEl.setText(`📁 存储于: ${resolvedFilePath}`);

    const items = await this.manager.getItems(curPath);

    // 过滤
    const filtered = items.filter((item) => {
      if (!this.currentFilter) return true;
      return (
        item.content.toLowerCase().includes(this.currentFilter) ||
        item.sourceFile.toLowerCase().includes(this.currentFilter)
      );
    });

    this.countBadge.setText(`(${items.length})`);

    if (filtered.length === 0) {
      const emptyEl = this.itemsContainer.createDiv({ cls: "refactor-scratchpad-empty" });
      emptyEl.createDiv({ cls: "refactor-scratchpad-empty-icon", text: "📦" });
      emptyEl.createDiv({
        cls: "refactor-scratchpad-empty-text",
        text: items.length === 0
          ? "暂无暂存灵感。\n在文稿中选中文本点击【暂存】，或点击删除文字末尾的 📦 即可收录！"
          : "未找到匹配的暂存内容",
      });
      return;
    }

    // 按最新时间倒序展示
    for (let i = filtered.length - 1; i >= 0; i--) {
      const item = filtered[i];
      const card = this.itemsContainer.createDiv({ cls: "refactor-scratchpad-card" });

      const cardHeader = card.createDiv({ cls: "refactor-card-header" });
      const metaSpan = cardHeader.createSpan({ cls: "refactor-card-meta" });
      metaSpan.setText(`📄 ${item.sourceFile} · ${item.dateStr}`);

      const cardBody = card.createDiv({ cls: "refactor-card-body" });
      cardBody.setText(item.content);

      const cardActions = card.createDiv({ cls: "refactor-card-actions" });

      // 插入正文按钮
      const insertBtn = cardActions.createEl("button", {
        cls: "refactor-card-btn refactor-btn-primary",
        text: "↵ 插入光标处",
      });
      insertBtn.title = "将这段素材插入当前文稿的光标所在位置";
      insertBtn.addEventListener("click", () => {
        this.insertToActiveEditor(item.content);
      });

      // 复制按钮
      const copyBtn = cardActions.createEl("button", {
        cls: "refactor-card-btn",
        text: "📋 复制",
      });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(item.content);
        new Notice("已复制素材到剪贴板！");
      });

      // 删除按钮
      const delBtn = cardActions.createEl("button", {
        cls: "refactor-card-btn refactor-btn-danger",
        text: "🗑 删除",
      });
      delBtn.addEventListener("click", async () => {
        const ok = await this.manager.deleteItem(item.id, curPath);
        if (ok) {
          new Notice("已从灵感抽屉移除");
        } else {
          new Notice("删除未完成");
        }
        await this.refresh();
      });
    }
  }

  /**
   * 将暂存文本无缝插入主编辑区的光标位置
   */
  private insertToActiveEditor(text: string) {
    const targetView = this.getRecentMarkdownView();
    if (!targetView) {
      new Notice("请先在主窗口中打开一篇 Markdown 文稿");
      return;
    }

    const editor = targetView.editor;
    const cursor = editor.getCursor();
    editor.replaceRange(text + "\n\n", cursor);
    targetView.editor.focus(); // 主动将光标焦点移回正文编辑区
    new Notice("已成功插入正文！");
  }
}
