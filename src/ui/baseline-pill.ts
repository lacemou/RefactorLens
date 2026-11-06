import { App, FuzzySuggestModal, Menu, TFile } from "obsidian";

export interface BaselineSelectionHandler {
  onSelectBaseline: (file: TFile | null) => void;
  getCurrentBaseline: () => TFile | null;
  getCurrentFile: () => TFile | null;
  onOpenScratchpad?: () => void;
  getScratchpadCount?: () => Promise<number>;
  onOpenCopilot?: () => void;
  getCliStatus?: () => Promise<string>;
  onOpenSettings?: () => void;
}

export class BaselineFilePickerModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("在全库中搜索任意文档作为参照基准...");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item: TFile): string {
    return `${item.basename} (${item.path})`;
  }

  onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(item);
  }
}

/**
 * 极简紧凑型“单药丸”顶部控制器 (Single Compact Capsule)
 * 绝不横向堆砌、绝不遮挡窗口右上角原生按钮：
 * 1. 宽度仅约 110px，贴合在标签页右侧安全区域；
 * 2. 点击展开多功能整合面板（切换底稿、打开抽屉、呼出改写、快速设置）。
 */
export class BaselinePillView {
  private containerEl: HTMLElement;
  private pillEl: HTMLElement;
  private app: App;
  private handler: BaselineSelectionHandler;
  private menuRequest = 0;

  constructor(containerEl: HTMLElement, app: App, handler: BaselineSelectionHandler) {
    this.containerEl = containerEl;
    this.app = app;
    this.handler = handler;
    this.createPill();
  }

  private createPill(): void {
    this.pillEl = this.containerEl.createDiv({ cls: "refactor-lens-pill" });
    this.updatePillText(null);
    this.pillEl.addEventListener("click", (evt: MouseEvent) => {
      void this.showPillMenu(evt);
    });
  }

  public updatePillText(baselineFile: TFile | null, refactorRatio?: number): void {
    this.pillEl.empty();

    const iconSpan = this.pillEl.createSpan({ cls: "refactor-lens-pill-icon" });
    iconSpan.innerText = "👁";

    const textSpan = this.pillEl.createSpan({ cls: "refactor-lens-pill-text" });
    if (baselineFile) {
      this.pillEl.addClass("active");
      textSpan.innerText = `对比: ${baselineFile.basename}`;
      if (refactorRatio !== undefined) {
        const badge = this.pillEl.createSpan({ cls: "refactor-lens-pill-badge" });
        badge.innerText = `${refactorRatio}%`;
      }
    } else {
      this.pillEl.removeClass("active");
      textSpan.innerText = "修订透镜";
    }

    const arrowSpan = this.pillEl.createSpan({ cls: "refactor-lens-pill-arrow" });
    arrowSpan.innerText = "▾";
  }

  public destroy(): void {
    this.menuRequest++;
    this.pillEl.remove();
  }

  /**
   * 点击弹出整合式全能创作控制面板
   */
  private async showPillMenu(evt: MouseEvent): Promise<void> {
    const request = ++this.menuRequest;
    const menu = new Menu();
    const currentBaseline = this.handler.getCurrentBaseline();
    const currentFile = this.handler.getCurrentFile();

    // 1. 如果已开启比对，首项提供“关闭透镜”
    if (currentBaseline) {
      menu.addItem((item) => {
        item
          .setTitle("关闭对比透镜 (恢复纯净编辑)")
          .setIcon("eye-off")
          .onClick(() => {
            this.handler.onSelectBaseline(null);
          });
      });
      menu.addSeparator();
    }

    // 2. 优先展示同目录下的其他版本
    if (currentFile && currentFile.parent) {
      const siblingFiles = this.getSiblingMarkdownFiles(currentFile);
      if (siblingFiles.length > 0) {
        menu.addItem((item) => {
          item.setTitle(`📁 同目录稿件 (${currentFile.parent?.name || "当前文件夹"})`).setDisabled(true);
        });

        for (const file of siblingFiles) {
          const isSelected = currentBaseline?.path === file.path;
          menu.addItem((item) => {
            item
              .setTitle(`${isSelected ? "✓ " : "  "}${file.name}`)
              .setIcon(isSelected ? "check" : "file-text")
              .onClick(() => {
                this.handler.onSelectBaseline(file);
              });
          });
        }
        menu.addSeparator();
      }
    }

    // 3. 跨文件夹浏览
    menu.addItem((item) => {
      item
        .setTitle("📂 挑选其他文件夹中的底稿...")
        .setIcon("folder-search")
        .onClick(() => {
          new BaselineFilePickerModal(this.app, (file) => {
            this.handler.onSelectBaseline(file);
          }).open();
        });
    });

    menu.addSeparator();

    // 4. 灵感抽屉入口
    const [count, status] = await Promise.allSettled([
      this.handler.getScratchpadCount?.(),
      this.handler.getCliStatus?.(),
    ]);
    if (request !== this.menuRequest || this.handler.getCurrentFile() !== currentFile) return;
    const scratchpadCount = count.status === "fulfilled" ? count.value ?? 0 : 0;
    menu.addItem((item) => {
      item
        .setTitle(`📦 打开灵感暂存抽屉 (已存 ${scratchpadCount} 条)`)
        .setIcon("archive")
        .onClick(() => {
          if (this.handler.onOpenScratchpad) this.handler.onOpenScratchpad();
        });
    });

    // 5. 改写顾问入口
    menu.addItem((item) => {
      item
        .setTitle("✨ 呼出改写顾问")
        .setIcon("wand")
        .onClick(() => {
          if (this.handler.onOpenCopilot) this.handler.onOpenCopilot();
        });
    });
    if (this.handler.getCliStatus) {
      const label = status.status === "fulfilled" ? status.value : undefined;
      menu.addItem((item) => item.setTitle(label ?? "CLI：暂无法检测").setDisabled(true));
    }

    // 6. 插件设置中心
    menu.addItem((item) => {
      item
        .setTitle("⚙️ 插件设置与快捷键...")
        .setIcon("settings")
        .onClick(() => {
          if (this.handler.onOpenSettings) this.handler.onOpenSettings();
        });
    });

    menu.showAtMouseEvent(evt);
  }

  private getSiblingMarkdownFiles(currentFile: TFile): TFile[] {
    const parent = currentFile.parent;
    if (!parent) return [];

    const siblings: TFile[] = [];
    for (const child of parent.children) {
      if (child instanceof TFile && child.extension === "md" && child.path !== currentFile.path) {
        siblings.push(child);
      }
    }

    siblings.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    return siblings;
  }
}
