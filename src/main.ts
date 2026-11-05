import { Plugin, MarkdownView, TFile, Notice, WorkspaceLeaf, Editor, Menu } from "obsidian";
import { EditorView } from "@codemirror/view";
import { CopywritingComparator } from "./diff/comparator";
import { MovedBlockDetector } from "./diff/moved-detector";
import { refactorLensField, setRefactorDiffEffect, registerDeletedTextSaveHandler } from "./ui/cm-decorations";
import { BaselinePillView } from "./ui/baseline-pill";
import { RefactorLensSettings, DEFAULT_SETTINGS, RefactorLensSettingTab } from "./settings/settings-tab";
import { ScratchpadManager } from "./scratchpad/scratchpad-manager";
import { ScratchpadView, VIEW_TYPE_SCRATCHPAD } from "./scratchpad/scratchpad-view";
import { CodexCliEngine } from "./copilot/codex-cli";
import { InPlaceCopilotModal } from "./copilot/copilot-modal";
import { FloatingCopilotManager } from "./ui/floating-copilot";

export default class RefactorLensPlugin extends Plugin {
  settings: RefactorLensSettings;
  comparator: CopywritingComparator;
  movedDetector: MovedBlockDetector;
  scratchpadManager: ScratchpadManager;
  codexEngine: CodexCliEngine;
  floatingCopilot: FloatingCopilotManager;

  private activeBaselines: Map<string, TFile | null> = new Map();
  private sessionSnapshots: Map<string, string> = new Map();
  private pillViews: Map<string, BaselinePillView> = new Map();

  async onload() {
    await this.loadSettings();

    this.comparator = new CopywritingComparator();
    this.movedDetector = new MovedBlockDetector();
    this.scratchpadManager = new ScratchpadManager(
      this.app,
      this.settings.scratchpadCustomPath,
      this.settings.scratchpadMode
    );
    this.codexEngine = new CodexCliEngine(this.settings.codexCliPath);

    // 监听灵感抽屉变更事件，实现零延迟全局自动静默刷新（无论来自哪里的改写或暂存）
    this.scratchpadManager.onUpdate(() => {
      this.refreshAllScratchpadBadges();
      this.refreshScratchpadViews();
    });

    // 1. 注册 CodeMirror 6 修订透镜扩展
    this.registerEditorExtension([refactorLensField]);

    // 2. 注册已删除红字的一键暂存全局回调 (就近保存在当前文稿同级目录)
    registerDeletedTextSaveHandler(async (deletedText: string) => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const fileName = activeView?.file?.basename || "已删除文字";
      const curPath = activeView?.file?.path;
      await this.scratchpadManager.addItem(deletedText, fileName, curPath);
      new Notice("📦 已成功将删除文字暂存至当前文章的灵感抽屉！");
      this.refreshAllScratchpadBadges();
      this.refreshScratchpadViews();
    });

    // 3. 注册灵感暂存抽屉侧边栏视图
    this.registerView(
      VIEW_TYPE_SCRATCHPAD,
      (leaf) => new ScratchpadView(leaf, this.scratchpadManager)
    );

    // 4. 注册设置面板
    this.addSettingTab(new RefactorLensSettingTab(this.app, this));

    // 5. 注册左侧 Ribbon 图标：一键打开灵感暂存抽屉
    this.addRibbonIcon("archive", "RefactorLens: 打开灵感暂存抽屉", () => {
      this.activateScratchpadView();
    });

    // 6. 注册选区跟随浮动小胶囊 + 右下角悬浮球
    this.floatingCopilot = new FloatingCopilotManager(this.app, {
      onTriggerCopilot: (editor, view) => {
        this.openCopilotModal(editor, view);
      },
      onSaveToScratchpad: async (editor, view) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          const fileName = view.file?.basename || "当前文稿";
          const curPath = view.file?.path;
          await this.scratchpadManager.addItem(selection, fileName, curPath);
          new Notice("📦 已成功暂存至当前文稿的灵感抽屉！");
          this.refreshAllScratchpadBadges();
          this.refreshScratchpadViews();
        }
      },
      onOpenScratchpad: () => {
        this.activateScratchpadView();
      },
      isCodexReady: async () => {
        const detect = await this.codexEngine.detectCodexPath();
        return detect.available;
      },
      onOpenSettings: () => {
        // @ts-ignore
        this.app.setting.open();
        // @ts-ignore
        this.app.setting.openTabById("refactor-lens");
      },
    });

    // 7. 注册命令与快捷键
    this.addCommand({
      id: "toggle-refactor-lens",
      name: "切换/关闭当前文档的文案修订透镜",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          if (!checking) {
            this.toggleLensForActiveView(view);
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-inline-copilot",
      name: "呼出行内 Codex 改写顾问",
      hotkeys: [
        { modifiers: ["Mod", "Shift"], key: "k" },
        { modifiers: ["Mod"], key: "k" },
      ],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.openCopilotModal(editor, view);
      },
    });

    this.addCommand({
      id: "save-to-scratchpad",
      name: "将选中文本暂存至灵感抽屉",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "p" }],
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("请先鼠标选中文本后再进行暂存！");
          return;
        }
        const fileName = view.file?.basename || "当前文稿";
        const curPath = view.file?.path;
        await this.scratchpadManager.addItem(selection, fileName, curPath);
        new Notice("📦 已成功暂存至灵感抽屉！");
        this.refreshAllScratchpadBadges();
        this.refreshScratchpadViews();
      },
    });

    this.addCommand({
      id: "open-scratchpad-view",
      name: "打开灵感暂存抽屉侧边栏",
      callback: () => {
        this.activateScratchpadView();
      },
    });

    // 8. 右键菜单
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          menu.addItem((item) => {
            item
              .setTitle("✨ 行内呼出 Codex 改写顾问 (Mod+Shift+K)")
              .setIcon("wand")
              .onClick(() => {
                this.openCopilotModal(editor, view);
              });
          });

          menu.addItem((item) => {
            item
              .setTitle("📦 暂存至灵感抽屉 (Mod+Shift+P)")
              .setIcon("archive")
              .onClick(async () => {
                const fileName = view.file?.basename || "当前文稿";
                const curPath = view.file?.path;
                await this.scratchpadManager.addItem(selection, fileName, curPath);
                new Notice("📦 已成功暂存至灵感抽屉！");
                this.refreshAllScratchpadBadges();
                this.refreshScratchpadViews();
              });
          });
        }
      })
    );

    // 9. 视图切换监听
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf) => {
        this.handleActiveLeafChange(leaf);
      })
    );

    // 10. 编辑变更监听
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
        if (view instanceof MarkdownView) {
          this.refreshDiffForView(view);
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      const activeLeaf = this.app.workspace.activeLeaf;
      if (activeLeaf) {
        this.handleActiveLeafChange(activeLeaf);
      }
    });

    console.log("RefactorLens (文案透镜) 插件已就绪。");
  }

  onunload() {
    for (const pill of this.pillViews.values()) {
      pill.destroy();
    }
    this.pillViews.clear();
    this.activeBaselines.clear();
    this.sessionSnapshots.clear();
    if (this.floatingCopilot) {
      this.floatingCopilot.destroy();
    }
    console.log("RefactorLens (文案透镜) 插件已卸载。");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  public refreshAllScratchpadBadges() {
    for (const pill of this.pillViews.values()) {
      // @ts-ignore
      if (pill.updateScratchpadCount) pill.updateScratchpadCount();
    }
  }

  public async activateScratchpadView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_SCRATCHPAD, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      this.refreshScratchpadViews();
    }
  }

  public refreshScratchpadViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);
    for (const l of leaves) {
      if (l.view instanceof ScratchpadView) {
        l.view.refresh();
      }
    }
  }

  public async openCopilotModal(editor: Editor, view: MarkdownView) {
    let styleContext = "";
    if (this.settings.benchmarkVaultPath) {
      const p = this.settings.benchmarkVaultPath;
      if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
        try {
          const fs = require("fs");
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf-8");
            styleContext = raw.slice(0, 500);
          }
        } catch (_) {}
      } else {
        const bFile = this.app.vault.getAbstractFileByPath(p);
        if (bFile instanceof TFile) {
          try {
            const raw = await this.app.vault.read(bFile);
            styleContext = raw.slice(0, 500);
          } catch (_) {}
        }
      }
    }

    this.floatingCopilot?.setModalActive(true);

    new InPlaceCopilotModal({
      app: this.app,
      editor,
      codexEngine: this.codexEngine,
      scratchpadManager: this.scratchpadManager,
      styleContext,
      onCloseCallback: () => {
        this.floatingCopilot?.setModalActive(false);
      },
    }).open();
  }

  private getCM6View(view: MarkdownView): EditorView | null {
    // @ts-ignore
    if (view.editor && view.editor.cm) {
      // @ts-ignore
      return view.editor.cm as EditorView;
    }
    // @ts-ignore
    if (view.editMode && view.editMode.editor && view.editMode.editor.cm) {
      // @ts-ignore
      return view.editMode.editor.cm as EditorView;
    }
    const cmElement = view.containerEl.querySelector(".cm-editor");
    if (cmElement && (EditorView as any).findFromDOM) {
      return (EditorView as any).findFromDOM(cmElement);
    }
    return null;
  }

  private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    if (!leaf) {
      this.floatingCopilot?.attachToView(null);
      return;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) {
      this.floatingCopilot?.attachToView(null);
      return;
    }

    this.floatingCopilot?.attachToView(view);
    const fileKey = view.file.path;

    if (!this.pillViews.has(fileKey)) {
      const headerEl = view.containerEl.querySelector(".view-header");
      if (headerEl) {
        const pillView = new BaselinePillView(headerEl as HTMLElement, this.app, {
          onSelectBaseline: (baselineFile) => {
            this.setBaselineForView(view, baselineFile);
          },
          getCurrentBaseline: () => {
            return this.activeBaselines.get(fileKey) || null;
          },
          getCurrentFile: () => {
            return view.file;
          },
          onOpenScratchpad: () => {
            this.activateScratchpadView();
          },
          getScratchpadCount: async () => {
            const items = await this.scratchpadManager.getItems(view.file?.path);
            return items.length;
          },
          onOpenCopilot: () => {
            this.openCopilotModal(view.editor, view);
          },
          onOpenSettings: () => {
            // @ts-ignore
            this.app.setting.open();
            // @ts-ignore
            this.app.setting.openTabById("refactor-lens");
          },
        });
        this.pillViews.set(fileKey, pillView);

        const existingBaseline = this.activeBaselines.get(fileKey);
        if (existingBaseline) {
          this.refreshDiffForView(view);
        }
      }
    }
  }

  private toggleLensForActiveView(view: MarkdownView) {
    if (!view.file) return;
    const fileKey = view.file.path;
    const current = this.activeBaselines.get(fileKey);

    if (current) {
      this.setBaselineForView(view, null);
      new Notice("修订透镜已关闭");
    } else {
      new Notice("请在顶部小药丸选择比对参照文档 (如 V1, V2)");
    }
  }

  public async setBaselineForView(view: MarkdownView, baselineFile: TFile | null) {
    if (!view.file) return;
    const fileKey = view.file.path;
    this.activeBaselines.set(fileKey, baselineFile);

    if (baselineFile) {
      this.sessionSnapshots.set(fileKey, view.editor.getValue());
      new Notice(`已选择对比底稿: ${baselineFile.basename}`);
    } else {
      this.sessionSnapshots.delete(fileKey);
      new Notice("修订透镜已关闭 (恢复正常纯净编辑)");
    }

    const pill = this.pillViews.get(fileKey);
    if (pill) {
      pill.updatePillText(baselineFile);
    }

    await this.refreshDiffForView(view);
  }

  private async refreshDiffForView(view: MarkdownView) {
    if (!view.file) return;
    const fileKey = view.file.path;
    const baselineFile = this.activeBaselines.get(fileKey);
    const pill = this.pillViews.get(fileKey);

    const cmView = this.getCM6View(view);
    if (!cmView) return;

    if (!baselineFile) {
      cmView.dispatch({
        effects: setRefactorDiffEffect.of({
          diffResult: null,
          movedPairs: [],
          sessionLiveDeletes: [],
          sessionLiveInserts: [],
        }),
      });
      if (pill) pill.updatePillText(null);
      return;
    }

    try {
      const baselineText = await this.app.vault.read(baselineFile);
      const currentText = view.editor.getValue();

      const diffResult = this.comparator.compare(baselineText, currentText);
      const movedPairs = this.movedDetector.detect(baselineText, currentText);

      const sessionSnapshot = this.sessionSnapshots.get(fileKey);
      const sessionLiveDeletes: Array<{ text: string; pos: number }> = [];
      const sessionLiveInserts: Array<{ from: number; to: number }> = [];

      if (sessionSnapshot && sessionSnapshot !== currentText) {
        const liveDiff = this.comparator.compare(sessionSnapshot, currentText);
        for (const seg of liveDiff.segments) {
          if (seg.type === "delete" && seg.text.trim().length > 0) {
            sessionLiveDeletes.push({
              text: seg.text,
              pos: seg.from || 0,
            });
          } else if (seg.type === "insert" && seg.from !== undefined && seg.to !== undefined) {
            sessionLiveInserts.push({
              from: seg.from,
              to: seg.to,
            });
          }
        }
      }

      cmView.dispatch({
        effects: setRefactorDiffEffect.of({
          diffResult,
          movedPairs,
          sessionLiveDeletes,
          sessionLiveInserts,
        }),
      });

      if (pill) {
        pill.updatePillText(baselineFile, diffResult.refactorRatio);
      }
    } catch (err) {
      console.error("RefactorLens 比对刷新失败:", err);
    }
  }
}
