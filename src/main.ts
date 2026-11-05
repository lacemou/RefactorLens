import { Plugin, MarkdownView, TFile, Notice, WorkspaceLeaf, Editor, Menu } from "obsidian";
import { EditorView } from "@codemirror/view";
import * as fs from "fs";
import { CopywritingComparator } from "./diff/comparator";
import { MovedBlockDetector } from "./diff/moved-detector";
import { movedPairsField, refactorLensField, resetRestores, restoredUnitsField, restoreViewport, setRefactorDiffEffect } from "./ui/cm-decorations";
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
    this.codexEngine = new CodexCliEngine(this.settings);

    // 1. 注册 CodeMirror 6 修订透镜扩展
    this.registerEditorExtension([movedPairsField, restoredUnitsField, refactorLensField, restoreViewport]);

    // 3. 注册灵感暂存抽屉侧边栏视图
    this.registerView(
      VIEW_TYPE_SCRATCHPAD,
      (leaf) => new ScratchpadView(leaf, this.scratchpadManager)
    );

    // 4. 注册设置面板
    this.addSettingTab(new RefactorLensSettingTab(this.app, this));

    // 5. 注册左侧 Ribbon 图标：一键打开灵感暂存抽屉
    this.addRibbonIcon("archive", "RefactorLens: 打开灵感暂存抽屉", () => {
      void this.activateScratchpadView();
    });

    // 6. 注册选区跟随浮动小胶囊 + 右下角悬浮球
    this.floatingCopilot = new FloatingCopilotManager(this.app, {
      onTriggerCopilot: (editor, view) => {
        void this.openCopilotModal(editor, view);
      },
      onSaveToScratchpad: (editor, view) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          void this.saveSelection(selection, view);
        }
      },
      onSaveDeletedSelection: (text, view) => {
        void this.saveSelection(text, view);
      },
      onOpenScratchpad: () => {
        void this.activateScratchpadView();
      },
      isCodexReady: async () => {
        const detect = await this.codexEngine.detectCli();
        return detect.available;
      },
      onOpenSettings: () => {
        new Notice("请打开 Obsidian 设置 → 第三方插件 → Refactor Lens。");
      },
    });

    // 7. 注册命令与快捷键
    this.addCommand({
      id: "toggle-lens",
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
      name: "呼出行内改写顾问",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.openCopilotModal(editor, view);
      },
    });

    this.addCommand({
      id: "save-to-scratchpad",
      name: "将选中文本暂存至灵感抽屉",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("请先鼠标选中文本后再进行暂存！");
          return;
        }
        void this.saveSelection(selection, view);
      },
    });

    this.addCommand({
      id: "open-scratchpad-view",
      name: "打开灵感暂存抽屉侧边栏",
      callback: () => {
        void this.activateScratchpadView();
      },
    });

    // 8. 右键菜单
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          menu.addItem((item) => {
            item
              .setTitle("✨ 行内呼出改写顾问")
              .setIcon("wand")
              .onClick(() => {
                void this.openCopilotModal(editor, view);
              });
          });

          menu.addItem((item) => {
            item
              .setTitle("📦 暂存至灵感抽屉")
              .setIcon("archive")
              .onClick(() => {
                void this.saveSelection(selection, view);
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
          void this.refreshDiffForView(view);
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.handleActiveLeafChange(activeView.leaf);
      }
    });
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
  }

  async loadSettings() {
    const savedData: unknown = await this.loadData();
    const savedSettings = this.isSettingsData(savedData) ? savedData : {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async saveSelection(selection: string, view: MarkdownView): Promise<void> {
    const fileName = view.file?.basename || "当前文稿";
    await this.scratchpadManager.addItem(selection, fileName, view.file?.path);
    new Notice("📦 已成功暂存至灵感抽屉！");
  }

  private isSettingsData(value: unknown): value is Partial<RefactorLensSettings> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
      await workspace.revealLeaf(leaf);
      this.refreshScratchpadViews();
    }
  }

  public refreshScratchpadViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);
    for (const l of leaves) {
      if (l.view instanceof ScratchpadView) {
        void l.view.refresh();
      }
    }
  }

  public async openCopilotModal(editor: Editor, view: MarkdownView) {
    let styleContext = "";
    if (this.settings.benchmarkVaultPath) {
      const p = this.settings.benchmarkVaultPath;
      if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
        try {
          if (fs.existsSync(p)) {
            const raw = await fs.promises.readFile(p, "utf-8");
            styleContext = raw.slice(0, 500);
          }
        } catch (error) {
          console.warn("Refactor Lens 无法读取外部文风标杆文件:", error);
        }
      } else {
        const bFile = this.app.vault.getAbstractFileByPath(p);
        if (bFile instanceof TFile) {
          try {
            const raw = await this.app.vault.read(bFile);
            styleContext = raw.slice(0, 500);
          } catch (error) {
            console.warn("Refactor Lens 无法读取 Vault 文风标杆文件:", error);
          }
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
    const cm = (view.editor as Editor & { cm?: EditorView }).cm;
    if (cm) return cm;

    const cmElement = view.containerEl.querySelector<HTMLElement>(".cm-editor");
    return cmElement ? EditorView.findFromDOM(cmElement) : null;
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
            void this.setBaselineForView(view, baselineFile);
          },
          getCurrentBaseline: () => {
            return this.activeBaselines.get(fileKey) || null;
          },
          getCurrentFile: () => {
            return view.file;
          },
          onOpenScratchpad: () => {
            void this.activateScratchpadView();
          },
          getScratchpadCount: async () => {
            const items = await this.scratchpadManager.getItems(view.file?.path);
            return items.length;
          },
          onOpenCopilot: () => {
            void this.openCopilotModal(view.editor, view);
          },
          onOpenSettings: () => {
            new Notice("请打开 Obsidian 设置 → 第三方插件 → Refactor Lens。");
          },
        });
        this.pillViews.set(fileKey, pillView);

        const existingBaseline = this.activeBaselines.get(fileKey);
        if (existingBaseline) {
          void this.refreshDiffForView(view);
        }
      }
    }
  }

  private toggleLensForActiveView(view: MarkdownView) {
    if (!view.file) return;
    const fileKey = view.file.path;
    const current = this.activeBaselines.get(fileKey);

    if (current) {
      void this.setBaselineForView(view, null);
      new Notice("修订透镜已关闭");
    } else {
      new Notice("请在顶部小药丸选择比对参照文档 (如 V1, V2)");
    }
  }

  public async setBaselineForView(view: MarkdownView, baselineFile: TFile | null) {
    if (!view.file) return;
    const fileKey = view.file.path;
    if (this.activeBaselines.get(fileKey) !== baselineFile) {
      this.getCM6View(view)?.dispatch({ effects: resetRestores.of(null) });
    }
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
        }),
      });
      if (pill) pill.updatePillText(null);
      return;
    }

    try {
      const baselineText = (await this.app.vault.cachedRead(baselineFile)).replace(/\r\n/g, "\n");
      if (view.file?.path !== fileKey || this.activeBaselines.get(fileKey) !== baselineFile ||
          this.getCM6View(view) !== cmView) return;
      const currentText = cmView.state.doc.toString();

      const diffResult = this.comparator.compare(baselineText, currentText);
      const movedPairs = this.movedDetector.detect(baselineText, currentText, diffResult);

      const sessionSnapshot = this.sessionSnapshots.get(fileKey)?.replace(/\r\n/g, "\n");
      const liveDiff = sessionSnapshot !== undefined && sessionSnapshot !== currentText
        ? this.comparator.compare(sessionSnapshot, currentText) : undefined;

      cmView.dispatch({
        effects: setRefactorDiffEffect.of({
          diffResult,
          movedPairs,
          sources: { key: JSON.stringify([fileKey, baselineFile.path]), baseline: baselineText, live: sessionSnapshot },
          liveDiff,
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
