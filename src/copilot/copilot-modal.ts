import { App, Modal, Editor, EditorPosition, Notice } from "obsidian";
import { CodexCliEngine } from "./codex-cli";

export interface CopilotModalProps {
  app: App;
  editor: Editor;
  codexEngine: CodexCliEngine;
  source: { from: EditorPosition; to: EditorPosition; original: string; isCurrent: () => boolean };
  styleContext?: string;
  onCloseCallback?: () => void;
}

export class InPlaceCopilotModal extends Modal {
  private editor: Editor;
  private codexEngine: CodexCliEngine;
  private source: CopilotModalProps["source"];
  private styleContext?: string;
  private onCloseCallback?: () => void;

  private selectedText: string;
  private removeSelectionListener?: () => void;
  private opened = false;

  private inputEl: HTMLInputElement;
  private statusEl: HTMLElement;
  private resultContainer: HTMLElement;

  private candidates: string[] = [];
  private currentCandidateIndex: number = 0;
  private isGenerating: boolean = false;

  constructor(props: CopilotModalProps) {
    super(props.app);
    this.editor = props.editor;
    this.codexEngine = props.codexEngine;
    this.source = props.source;
    this.styleContext = props.styleContext;
    this.onCloseCallback = props.onCloseCallback;

    this.selectedText = this.source.original.trim();
  }

  onOpen() {
    this.opened = true;
    // 强制清除所有可能悬浮的选区气泡，杜绝视觉遮挡
    document.querySelectorAll(".refactor-selection-popover").forEach((el) => el.remove());

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("refactor-copilot-modal-root");

    // 1. 顶部原句预览
    const quoteBox = contentEl.createDiv({ cls: "refactor-copilot-quote-box" });
    quoteBox.createSpan({ text: "原句引用：", cls: "refactor-copilot-quote-label" });
    const quoteText = quoteBox.createSpan({ cls: "refactor-copilot-quote-text" });
    quoteText.setText(this.selectedText || "（未选中文本，可在正文中划选后呼出）");

    // 2. 指令输入框
    const inputWrapper = contentEl.createDiv({ cls: "refactor-copilot-input-wrapper" });
    this.inputEl = inputWrapper.createEl("input", {
      type: "text",
      placeholder: "告诉改写顾问怎么改…（回车或点击下方胶囊）",
      cls: "refactor-copilot-input",
    });

    const submitBtn = inputWrapper.createEl("button", {
      text: "改写 ➔",
      cls: "refactor-copilot-submit-btn",
    });
    submitBtn.addEventListener("click", () => {
      void this.executeRewrite(this.inputEl.value.trim() || "润色并使其更自然");
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.executeRewrite(this.inputEl.value.trim() || "润色并使其更自然");
      }
    });

    // 3. 高频快捷胶囊
    const pillsContainer = contentEl.createDiv({ cls: "refactor-copilot-pills" });
    const pills = [
      { label: "🎯 去AI味", instruction: "打破模板化对仗排比，去营销套话，保留真诚克制的第一人称" },
      { label: "🗣 口语化一点", instruction: "转换为口播短句，像和朋友诚恳聊天一样自然" },
      { label: "💥 加深现实痛点", instruction: "点透普通职场人真切的痛点与困境，具体清楚" },
      { label: "✂ 更加精炼", instruction: "删去副词形容词等废话，保留最干练的行动和结论" },
    ];

    for (const p of pills) {
      const pillBtn = pillsContainer.createEl("button", {
        text: p.label,
        cls: "refactor-copilot-pill-btn",
      });
      pillBtn.addEventListener("click", () => {
        this.inputEl.value = p.label;
        void this.executeRewrite(p.instruction);
      });
    }

    // 4. 状态提示
    this.statusEl = contentEl.createDiv({ cls: "refactor-copilot-status" });

    // 5. 待决对比区域
    this.resultContainer = contentEl.createDiv({ cls: "refactor-copilot-result-box" });
    this.resultContainer.addClass("refactor-is-hidden");

    window.setTimeout(() => this.inputEl.focus(), 80);
  }

  onClose() {
    this.opened = false;
    this.removeSelectionListener?.();
    const { contentEl } = this;
    contentEl.empty();
    document.querySelectorAll(".refactor-selection-popover").forEach((el) => el.remove());
    if (this.onCloseCallback) {
      this.onCloseCallback();
    }
  }

  private async executeRewrite(instruction: string) {
    if (this.isGenerating) return;
    if (!this.selectedText) {
      new Notice("请先在文稿中鼠标选中要改写的句子或段落！");
      return;
    }

    this.isGenerating = true;
    const model = this.codexEngine.describeModel();
    this.statusEl.setText(`正在改写：${model}`);
    this.statusEl.addClass("refactor-copilot-loading");
    this.resultContainer.addClass("refactor-is-hidden");

    try {
      const rawCandidates = await this.codexEngine.rewrite({
        originalText: this.selectedText,
        instruction,
        styleContext: this.styleContext,
      });
      if (!this.opened) return;

      // 彻底清洗所有候选版本的垃圾前缀
      this.candidates = rawCandidates.map((c) => this.codexEngine.cleanOutput(c));
      this.currentCandidateIndex = 0;
      this.statusEl.setText(model);
      this.statusEl.removeClass("refactor-copilot-loading");
      this.renderCurrentCandidate();
    } catch (err) {
      if (!this.opened) return;
      this.statusEl.setText(err instanceof Error ? err.message : "改写异常，请检查本地环境。");
      this.statusEl.removeClass("refactor-copilot-loading");
    } finally {
      this.isGenerating = false;
    }
  }

  private renderCurrentCandidate() {
    this.removeSelectionListener?.();
    this.resultContainer.empty();
    this.resultContainer.removeClass("refactor-is-hidden");

    if (this.candidates.length === 0) {
      this.resultContainer.createDiv({ text: "未生成有效改写建议", cls: "refactor-text-muted" });
      return;
    }

    const currentText = this.candidates[this.currentCandidateIndex];
    const totalCount = this.candidates.length;

    // 顶部轮换栏
    const metaBar = this.resultContainer.createDiv({ cls: "refactor-result-meta-bar" });
    metaBar.createSpan({
      text: `建议改写 (${this.currentCandidateIndex + 1}/${totalCount})`,
      cls: "refactor-result-version-badge",
    });

    if (totalCount > 1) {
      const switchBtn = metaBar.createEl("button", {
        text: "↻ 换一版",
        cls: "refactor-btn-sm",
      });
      switchBtn.addEventListener("click", () => {
        this.currentCandidateIndex = (this.currentCandidateIndex + 1) % totalCount;
        this.renderCurrentCandidate();
      });
    }

    // 对比区
    const diffPreview = this.resultContainer.createDiv({ cls: "refactor-copilot-diff-preview" });
    const oldSpan = diffPreview.createDiv({ cls: "refactor-preview-old" });
    oldSpan.createSpan({ cls: "refactor-diff-deleted", text: this.selectedText });

    const newSpan = diffPreview.createDiv({ cls: "refactor-preview-new" });
    newSpan.createSpan({ cls: "refactor-diff-added", text: currentText });

    const hint = this.resultContainer.createDiv({
      cls: "refactor-copilot-copy-hint",
      text: "只想用一部分？划选上方改写文字，再点击「复制所选文字」。",
    });

    const actions = this.resultContainer.createDiv({ cls: "refactor-copilot-action-row" });
    const accept = actions.createEl("button", {
      text: "采纳整句", cls: "refactor-btn-accept", type: "button",
    });
    accept.addEventListener("click", () => this.applyRewrite(currentText));

    const copy = actions.createEl("button", {
      text: "复制所选文字", cls: "refactor-btn-secondary", type: "button",
    });
    copy.disabled = true;
    const doc = newSpan.ownerDocument;
    const readSelection = () => {
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return "";
      const range = selection.getRangeAt(0);
      if (!newSpan.contains(range.startContainer) || !newSpan.contains(range.endContainer)) return "";
      const text = range.toString();
      return text.trim() ? text : "";
    };
    const updateCopy = () => { copy.disabled = !readSelection(); };
    doc.addEventListener("selectionchange", updateCopy);
    this.removeSelectionListener = () => doc.removeEventListener("selectionchange", updateCopy);
    // Keep the selection intact when clicking the copy button.
    copy.addEventListener("mousedown", (event) => event.preventDefault());
    copy.addEventListener("click", () => {
      const selected = readSelection();
      if (selected) void this.copyCandidateSelection(selected, doc, hint);
    });

    const reject = actions.createEl("button", {
      text: "放弃", cls: "refactor-btn-ghost", type: "button",
    });
    reject.addEventListener("click", () => this.close());
  }

  private async copyCandidateSelection(text: string, doc: Document, hint: HTMLElement) {
    try {
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error("Clipboard unavailable");
      await clipboard.writeText(text);
      hint.setText("已复制所选文字。正文未修改。");
    } catch {
      hint.setText("无法写入剪贴板，请使用系统复制快捷键。正文未修改。");
    }
  }

  private applyRewrite(newText: string) {
    if (!this.source.isCurrent()) {
      new Notice("原选区已变化，请重新选择后再改写。");
      return;
    }
    this.editor.replaceRange(newText, this.source.from, this.source.to);
    new Notice("已成功采纳改写！");
    this.close();
  }
}
