import { App, Modal, Editor, Notice, MarkdownView } from "obsidian";
import { CodexCliEngine } from "./codex-cli";
import { ScratchpadManager } from "../scratchpad/scratchpad-manager";

export interface CopilotModalProps {
  app: App;
  editor: Editor;
  codexEngine: CodexCliEngine;
  scratchpadManager: ScratchpadManager;
  styleContext?: string;
  onCloseCallback?: () => void;
}

export class InPlaceCopilotModal extends Modal {
  private editor: Editor;
  private codexEngine: CodexCliEngine;
  private scratchpadManager: ScratchpadManager;
  private styleContext?: string;
  private onCloseCallback?: () => void;

  private selectedText: string;
  private fromPos: { line: number; ch: number };
  private toPos: { line: number; ch: number };

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
    this.scratchpadManager = props.scratchpadManager;
    this.styleContext = props.styleContext;
    this.onCloseCallback = props.onCloseCallback;

    this.selectedText = this.editor.getSelection().trim();
    this.fromPos = this.editor.getCursor("from");
    this.toPos = this.editor.getCursor("to");
  }

  onOpen() {
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

      // 彻底清洗所有候选版本的垃圾前缀
      this.candidates = rawCandidates.map((c) => this.codexEngine.cleanOutput(c));
      this.currentCandidateIndex = 0;
      this.statusEl.setText(model);
      this.statusEl.removeClass("refactor-copilot-loading");
      this.renderCurrentCandidate();
    } catch (err) {
      this.statusEl.setText(err instanceof Error ? err.message : "改写异常，请检查本地环境。");
      this.statusEl.removeClass("refactor-copilot-loading");
    } finally {
      this.isGenerating = false;
    }
  }

  private renderCurrentCandidate() {
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

    // 快捷分句胶囊栏：直接将改写句切分为逻辑半句，点一下直接采纳该半句，无需手动费力划选！
    const clauses = this.splitIntoClauses(currentText);
    if (clauses.length > 1) {
      const chipsBar = this.resultContainer.createDiv({ cls: "refactor-clause-chips-bar" });
      chipsBar.createSpan({ text: "⚡ 点选半句直接拼接：", cls: "refactor-chips-label" });

      for (const clause of clauses) {
        const chip = chipsBar.createEl("button", {
          text: clause,
          cls: "refactor-clause-chip",
          type: "button",
        });
        chip.title = `点击直接采纳此半句：“${clause}”`;
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          currentMergedText = this.computeHalfSentenceMerge(this.selectedText, currentText, clause);
          partialTitle.setText(`✨ 已捕获所选分句：“${clause.length > 15 ? clause.slice(0, 15) + "..." : clause}”`);
          partialBody.innerText = currentMergedText;
          partialCard.removeClass("refactor-is-hidden");
          actionRow.addClass("refactor-is-hidden");
        });
      }
    }

    // 半句采纳提示引导
    const subHint = this.resultContainer.createDiv({ cls: "refactor-copilot-selection-guide" });
    subHint.appendText("✨ ");
    subHint.createEl("strong", { text: "支持仅采纳半句" });
    subHint.appendText("：可在上方绿色改写句中直接鼠标划选，或直接点击上方胶囊，自动智能拼接！");

    // 专属的“仅采纳所选半句”智能融合卡片（平时隐藏，划选时自动浮现）
    const partialCard = this.resultContainer.createDiv({ cls: "refactor-partial-preview-card" });
    partialCard.addClass("refactor-is-hidden");

    const partialHeader = partialCard.createDiv({ cls: "refactor-partial-header" });
    const partialTitle = partialHeader.createSpan({ cls: "refactor-partial-title" });
    partialHeader.createSpan({ text: "智能精准拼接", cls: "refactor-partial-badge" });

    const partialBody = partialCard.createDiv({ cls: "refactor-partial-body" });
    partialBody.contentEditable = "true";
    partialBody.title = "可直接在此处微调拼接后的文字";

    const partialActions = partialCard.createDiv({ cls: "refactor-partial-actions" });

    const confirmPartialBtn = partialActions.createEl("button", {
      text: "✓ 仅采纳所选半句 (Enter)",
      cls: "refactor-btn-accept refactor-btn-partial-confirm",
    });

    const saveOldPartialBtn = partialActions.createEl("button", {
      text: "📦 采纳半句并备份旧句到抽屉",
      cls: "refactor-btn-secondary",
    });

    const cancelPartialBtn = partialActions.createEl("button", {
      text: "✕ 取消半句模式",
      cls: "refactor-btn-ghost",
    });

    // 默认的整句动作行
    const actionRow = this.resultContainer.createDiv({ cls: "refactor-copilot-action-row" });

    // 1. 采纳新句 (Enter)
    const acceptBtn = actionRow.createEl("button", {
      text: "✓ 替换为新句 (Enter)",
      cls: "refactor-btn-accept",
    });
    acceptBtn.title = "直接将选中的原句替换为改写后的新句";
    acceptBtn.addEventListener("click", () => {
      void this.applyRewrite(currentText, false);
    });

    // 2. 采纳并备份原句到抽屉
    const acceptAndSaveBtn = actionRow.createEl("button", {
      text: "📦 替换并把原句存入抽屉",
      cls: "refactor-btn-secondary",
    });
    acceptAndSaveBtn.title = "将新句写入正文，同时把你原来写的旧句安全备份到灵感抽屉，不怕误删，日后可随时拖回！";
    acceptAndSaveBtn.addEventListener("click", () => {
      void this.applyRewrite(currentText, true);
    });

    // 3. 放弃 (Esc)
    const rejectBtn = actionRow.createEl("button", {
      text: "✕ 放弃 (Esc)",
      cls: "refactor-btn-ghost",
    });
    rejectBtn.title = "放弃此次改写，原文纹丝不动";
    rejectBtn.addEventListener("click", () => {
      this.close();
    });

    // 提示说明卡
    const hintBox = this.resultContainer.createDiv({ cls: "refactor-copilot-hint-box" });
    hintBox.appendText("💡 ");
    hintBox.createEl("strong", { text: "提示" });
    hintBox.appendText("：『替换并把原句存入抽屉』会将你的原句安全备份到灵感抽屉，不怕误删，日后可随时拖回；按 ");
    hintBox.createEl("strong", { text: "Esc" });
    hintBox.appendText(" 键可直接退出，原文保持原样。");

    let currentMergedText: string | null = null;

    const updatePartialSelection = () => {
      const sel = window.getSelection();
      const selText = sel ? sel.toString().trim() : "";

      const cleanSel = selText.replace(/[*#_`]/g, "").trim();
      const cleanCurrent = currentText.replace(/[*#_`]/g, "").trim();

      if (cleanSel && cleanSel.length >= 2 && cleanCurrent.includes(cleanSel) && cleanSel !== cleanCurrent) {
        currentMergedText = this.computeHalfSentenceMerge(this.selectedText, currentText, cleanSel);
        partialTitle.setText(`✨ 已划选所选半句：“${cleanSel.length > 15 ? cleanSel.slice(0, 15) + "..." : cleanSel}”`);
        partialBody.innerText = currentMergedText;
        partialCard.removeClass("refactor-is-hidden");
        actionRow.addClass("refactor-is-hidden");
      }
    };

    diffPreview.addEventListener("mouseup", updatePartialSelection);
    diffPreview.addEventListener("pointerup", updatePartialSelection);
    diffPreview.addEventListener("keyup", updatePartialSelection);

    cancelPartialBtn.addEventListener("click", () => {
      currentMergedText = null;
      partialCard.addClass("refactor-is-hidden");
      actionRow.removeClass("refactor-is-hidden");
      window.getSelection()?.removeAllRanges();
    });

    confirmPartialBtn.addEventListener("click", () => {
      const finalMerged = partialBody.innerText.trim() || currentMergedText || currentText;
      void this.applyRewrite(finalMerged, false);
    });

    saveOldPartialBtn.addEventListener("click", () => {
      const finalMerged = partialBody.innerText.trim() || currentMergedText || currentText;
      void this.applyRewrite(finalMerged, true);
    });

    this.scope.register([], "Enter", () => {
      if (currentMergedText && !partialCard.hasClass("refactor-is-hidden")) {
        const finalMerged = partialBody.innerText.trim() || currentMergedText;
        void this.applyRewrite(finalMerged, false);
        return false;
      } else if (!this.resultContainer.hasClass("refactor-is-hidden")) {
        void this.applyRewrite(currentText, false);
        return false;
      }
      return true;
    });

    this.scope.register([], "Escape", () => {
      this.close();
      return false;
    });
  }

  /**
   * 将长句切分为有意义的分句（供一键点选半句采纳）
   */
  public splitIntoClauses(text: string): string[] {
    return text
      .split(/[，,：:；;！!？?\n]+/)
      .map((c) => c.replace(/[*#_`]/g, "").trim())
      .filter((c) => c.length >= 2);
  }

  /**
   * 智能半句融合拼接：
   * 将用户在 AI 候选句中划选的半句，精准替换进原句对应的位置，其余部分原样保留。
   */
  public computeHalfSentenceMerge(origText: string, candText: string, selectedPart: string): string {
    const orig = origText.trim();
    const cand = candText.trim();
    const sel = selectedPart.trim();

    if (!sel || sel === cand) return cand;

    const startIdx = cand.indexOf(sel);
    if (startIdx === -1) return cand;
    const endIdx = startIdx + sel.length;

    const isPrefix = startIdx <= 2;
    const isSuffix = endIdx >= cand.length - 2;

    const beforeInCand = cand.substring(0, startIdx).trim();
    const punctRegex = /[，,：:；;！!？?]/g;

    if (isSuffix && !isPrefix) {
      // 采纳后半句：检查 cand 中进入后半句的切分标点
      const leadPunctMatch = beforeInCand.match(/([，,：:；;])[^，,：:；;]*$/);
      const leadPunct = leadPunctMatch ? leadPunctMatch[1] : null;

      let splitPos = -1;
      if (leadPunct) {
        splitPos = orig.lastIndexOf(leadPunct);
      }
      if (splitPos === -1) {
        const matches = [...orig.matchAll(punctRegex)];
        if (matches.length > 0) {
          splitPos = matches[matches.length - 1].index;
        }
      }

      if (splitPos !== -1) {
        const origPrefix = orig.substring(0, splitPos + 1);
        const cleanSel = sel.replace(/^[，,：:；;\s]+/, "");
        return origPrefix + cleanSel;
      }
    } else if (isPrefix && !isSuffix) {
      // 采纳前半句：检查 cand 中前半句结尾的标点
      const endPunctMatch = cand.substring(startIdx).match(/^[^，,：:；;]*([，,：:；;])/);
      const endPunct = endPunctMatch ? endPunctMatch[1] : null;

      let splitPos = -1;
      if (endPunct) {
        splitPos = orig.indexOf(endPunct);
      }
      if (splitPos === -1) {
        const matches = [...orig.matchAll(punctRegex)];
        if (matches.length > 0) {
          splitPos = matches[0].index;
        }
      }

      if (splitPos !== -1) {
        const origSuffix = orig.substring(splitPos);
        const cleanSel = sel.replace(/[，,：:；;\s]+$/, "");
        return cleanSel + origSuffix;
      }
    }

    // 若原句无标点或选中的是中间片段，按字符比例位置替换
    const startRatio = startIdx / cand.length;
    const endRatio = endIdx / cand.length;
    const origCutStart = Math.round(orig.length * startRatio);
    const origCutEnd = Math.round(orig.length * endRatio);

    return orig.substring(0, origCutStart) + sel + orig.substring(origCutEnd);
  }

  private async applyRewrite(newText: string, saveOldToScratchpad: boolean) {
    const cleanNewText = this.codexEngine.cleanOutput(newText);
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const fileName = activeView?.file?.basename || "当前文稿";
    const curPath = activeView?.file?.path;

    if (saveOldToScratchpad) {
      await this.scratchpadManager.addItem(this.selectedText, `${fileName}(改写前旧句)`, curPath);
      new Notice("原句已安全备份至灵感抽屉！");
    }

    // 原子替换
    this.editor.replaceRange(cleanNewText, this.fromPos, this.toPos);
    new Notice("已成功采纳改写！");
    this.close();
  }
}
