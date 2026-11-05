import { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { DocumentDiffResult } from "../diff/comparator";
import { MovedPair } from "../diff/moved-detector";

type SaveTextCallback = (text: string) => void;
let globalSaveCallback: SaveTextCallback | null = null;

export function registerDeletedTextSaveHandler(handler: SaveTextCallback) {
  globalSaveCallback = handler;
}

/**
 * 块级宏观删除文本卡片 (DeletedBlockCardWidget)
 * 彻底解决“红色删除文字堆在一起分不清行、满屏胶囊乱飞”的视觉灾难：
 * 1. 完整还原底稿原本文档的真实换行、段落空行与结构；
 * 2. 彻底拔除文字中间密密麻麻的常驻胶囊，还创作者一个清爽连贯的排版；
 * 3. 右上角集成极简工具条 [ 📦 暂存此段落至抽屉 ] 与 [ 📋 复制 ]；
 * 4. 允许原生自由鼠标划选，划选任意半句话即弹出 [ 📦 暂存 ] 气泡。
 */
class DeletedBlockCardWidget extends WidgetType {
  private fullText: string;
  private isLive: boolean;

  constructor(fullText: string, isLive: boolean = false) {
    super();
    this.fullText = fullText;
    this.isLive = isLive;
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("div");
    card.className = `refactor-deleted-block-card ${this.isLive ? "refactor-live-deleted-card" : ""}`;

    // 解析出独立的段落列表，支持按段精细收录与多段组合勾选
    const rawParagraphs = this.fullText
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const paragraphs = rawParagraphs.length > 0 ? rawParagraphs : [this.fullText.trim()];
    const selectedIndices = new Set<number>();

    // 顶部极简工具条
    const header = document.createElement("div");
    header.className = "refactor-deleted-card-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "refactor-deleted-card-title";
    const countDesc = paragraphs.length > 1 ? ` (共 ${paragraphs.length} 个段落)` : "";
    titleSpan.innerText = this.isLive
      ? `✂️ 本次现场编辑删除的段落${countDesc}`
      : `🗑 底稿中存在，当前版本已删除的段落${countDesc}`;

    const actions = document.createElement("div");
    actions.className = "refactor-deleted-card-actions";

    // 批量选中暂存按钮
    const batchSaveBtn = document.createElement("button");
    batchSaveBtn.className = "refactor-deleted-action-btn refactor-btn-batch-save";
    batchSaveBtn.type = "button";
    batchSaveBtn.style.display = "none";
    batchSaveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const selectedParas = Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((idx) => paragraphs[idx])
        .join("\n\n");
      if (globalSaveCallback && selectedParas) {
        globalSaveCallback(selectedParas);
      }
    });

    // 取消多选按钮
    const clearSelectionBtn = document.createElement("button");
    clearSelectionBtn.className = "refactor-deleted-action-btn refactor-btn-ghost-sm";
    clearSelectionBtn.type = "button";
    clearSelectionBtn.innerText = "取消勾选";
    clearSelectionBtn.style.display = "none";
    clearSelectionBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedIndices.clear();
      card.querySelectorAll<HTMLInputElement>(".refactor-para-checkbox").forEach((cb) => (cb.checked = false));
      card.querySelectorAll(".refactor-deleted-para").forEach((el) => el.classList.remove("refactor-para-selected"));
      updateBatchUI();
    });

    const saveAllBtn = document.createElement("button");
    saveAllBtn.className = "refactor-deleted-action-btn";
    saveAllBtn.type = "button";
    saveAllBtn.innerHTML = paragraphs.length > 1 ? `📦 暂存全部段落` : `📦 暂存至灵感抽屉`;
    saveAllBtn.title = "将这段已删除的内容完整存入灵感抽屉";
    saveAllBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (globalSaveCallback && this.fullText.trim()) {
        globalSaveCallback(this.fullText.trim());
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "refactor-deleted-action-btn refactor-btn-ghost-sm";
    copyBtn.type = "button";
    copyBtn.innerHTML = `📋 复制全文`;
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.fullText.trim());
    });

    actions.appendChild(batchSaveBtn);
    actions.appendChild(clearSelectionBtn);
    actions.appendChild(saveAllBtn);
    actions.appendChild(copyBtn);
    header.appendChild(titleSpan);
    header.appendChild(actions);

    const updateBatchUI = () => {
      if (selectedIndices.size > 0) {
        batchSaveBtn.style.display = "inline-flex";
        batchSaveBtn.innerHTML = `📦 暂存选中的 ${selectedIndices.size} 个段落`;
        clearSelectionBtn.style.display = "inline-flex";
        saveAllBtn.style.display = "none";
      } else {
        batchSaveBtn.style.display = "none";
        clearSelectionBtn.style.display = "none";
        saveAllBtn.style.display = "inline-flex";
      }
    };

    // 正文内容区：按段落拆分渲染，每段具备独立 hover 工具条与勾选框
    const body = document.createElement("div");
    body.className = "refactor-deleted-card-body";

    paragraphs.forEach((para, idx) => {
      const isDivider = /^[-*_]{3,}$/.test(para);
      const paraEl = document.createElement("div");
      paraEl.className = `refactor-deleted-para ${isDivider ? "refactor-deleted-divider" : ""}`;

      if (!isDivider && paragraphs.length > 1) {
        // 多选框
        const checkWrap = document.createElement("label");
        checkWrap.className = "refactor-para-check-label";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "refactor-para-checkbox";
        chk.title = "勾选此段（可多选组合暂存）";
        chk.addEventListener("change", (e) => {
          e.stopPropagation();
          if (chk.checked) {
            selectedIndices.add(idx);
            paraEl.classList.add("refactor-para-selected");
          } else {
            selectedIndices.delete(idx);
            paraEl.classList.remove("refactor-para-selected");
          }
          updateBatchUI();
        });
        checkWrap.appendChild(chk);
        paraEl.appendChild(checkWrap);
      }

      // 段落文本内容
      const textEl = document.createElement("div");
      textEl.className = "refactor-para-text";
      textEl.innerText = para;
      paraEl.appendChild(textEl);

      // 单段 hover 快捷工具条
      if (!isDivider) {
        const hoverActions = document.createElement("div");
        hoverActions.className = "refactor-para-hover-actions";

        const saveParaBtn = document.createElement("button");
        saveParaBtn.className = "refactor-para-btn";
        saveParaBtn.type = "button";
        saveParaBtn.innerHTML = `📦 存此段`;
        saveParaBtn.title = "仅将本段内容存入灵感抽屉";
        saveParaBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (globalSaveCallback && para) {
            globalSaveCallback(para);
          }
        });

        const copyParaBtn = document.createElement("button");
        copyParaBtn.className = "refactor-para-btn refactor-para-btn-ghost";
        copyParaBtn.type = "button";
        copyParaBtn.innerHTML = `📋 复制`;
        copyParaBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard.writeText(para);
        });

        hoverActions.appendChild(saveParaBtn);
        hoverActions.appendChild(copyParaBtn);
        paraEl.appendChild(hoverActions);
      }

      paraEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const domSel = window.getSelection()?.toString().trim();
        const text = domSel && para.includes(domSel) ? domSel : para;
        showDeletedContextMenu(e.clientX, e.clientY, text);
      });

      body.appendChild(paraEl);
    });

    card.appendChild(header);
    card.appendChild(body);

    return card;
  }

  eq(other: DeletedBlockCardWidget): boolean {
    return other.fullText === this.fullText && other.isLive === this.isLive;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 行内微观短词删除微构件 (不含换行的行内细微删改)
 */
class DeletedInlineWidget extends WidgetType {
  private deletedText: string;
  private isLive: boolean;

  constructor(deletedText: string, isLive: boolean = false) {
    super();
    this.deletedText = deletedText;
    this.isLive = isLive;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = `refactor-diff-deleted ${this.isLive ? "refactor-live-deleted" : ""}`;
    span.innerText = this.deletedText;
    span.title = "【已删除文字】右键可存入灵感抽屉";

    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDeletedContextMenu(e.clientX, e.clientY, this.deletedText.trim());
    });

    return span;
  }

  eq(other: DeletedInlineWidget): boolean {
    return other.deletedText === this.deletedText && other.isLive === this.isLive;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 弹出删除文字专属的快捷右键菜单
 */
function showDeletedContextMenu(x: number, y: number, fullText: string) {
  const domSel = window.getSelection()?.toString().trim();
  const textToSave = domSel && fullText.includes(domSel) ? domSel : fullText;
  const isPartial = textToSave !== fullText;

  const oldMenu = document.querySelector(".refactor-context-menu");
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement("div");
  menu.className = "refactor-context-menu";
  menu.style.top = `${y}px`;
  menu.style.left = `${x}px`;

  menu.innerHTML = `
    <div class="refactor-menu-item" id="menu-save-scratchpad">
      <span class="refactor-menu-icon">📦</span>
      <span class="refactor-menu-text">${isPartial ? "暂存所选句子至灵感抽屉" : "暂存整段至灵感抽屉"}</span>
    </div>
    <div class="refactor-menu-item" id="menu-copy-text">
      <span class="refactor-menu-icon">📋</span>
      <span class="refactor-menu-text">复制文字</span>
    </div>
  `;

  document.body.appendChild(menu);

  menu.querySelector("#menu-save-scratchpad")?.addEventListener("click", () => {
    if (globalSaveCallback && textToSave) globalSaveCallback(textToSave);
    menu.remove();
  });

  menu.querySelector("#menu-copy-text")?.addEventListener("click", () => {
    navigator.clipboard.writeText(textToSave);
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

/**
 * 搬迁段落段首交互式徽标 (MovedTargetWidget)
 */
class MovedTargetWidget extends WidgetType {
  private pair: MovedPair;
  private isExpanded: boolean = false;

  constructor(pair: MovedPair) {
    super();
    this.pair = pair;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "refactor-moved-badge-container";
    container.style.userSelect = "none";
    // @ts-ignore
    container.style.webkitUserSelect = "none";

    const badge = document.createElement("span");
    badge.className = "refactor-moved-badge";
    const simPercent = Math.round(this.pair.similarity * 100);
    badge.innerHTML = `📦 搬迁段落 · 来自原第 ${this.pair.originalSectionIndex} 节 (${simPercent}% 相似) <span class="refactor-toggle-arrow">▾</span>`;
    badge.title = "点击原地展开/收起底稿原文对照";

    const drawer = document.createElement("div");
    drawer.className = "refactor-moved-drawer";
    drawer.style.display = "none";
    drawer.innerHTML = `
      <div class="refactor-drawer-header">
        <span class="refactor-drawer-title">【底稿原第 ${this.pair.originalSectionIndex} 节 原文对照】</span>
        <span class="refactor-drawer-close">收起 ▴</span>
      </div>
      <div class="refactor-drawer-body">${escapeHtml(this.pair.originalText)}</div>
    `;

    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.isExpanded = !this.isExpanded;
      drawer.style.display = this.isExpanded ? "block" : "none";
      const arrow = badge.querySelector(".refactor-toggle-arrow");
      if (arrow) arrow.textContent = this.isExpanded ? "▴" : "▾";
    });

    const closeBtn = drawer.querySelector(".refactor-drawer-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.isExpanded = false;
        drawer.style.display = "none";
        const arrow = badge.querySelector(".refactor-toggle-arrow");
        if (arrow) arrow.textContent = "▾";
      });
    }

    container.appendChild(badge);
    container.appendChild(drawer);
    return container;
  }

  eq(other: MovedTargetWidget): boolean {
    return other.pair.id === this.pair.id;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RefactorDiffPayload {
  diffResult: DocumentDiffResult | null;
  movedPairs: MovedPair[];
  sessionLiveDeletes?: Array<{ text: string; pos: number }>;
  sessionLiveInserts?: Array<{ from: number; to: number }>;
}

export const setRefactorDiffEffect = StateEffect.define<RefactorDiffPayload>();

interface DecorationItem {
  from: number;
  to: number;
  deco: Decoration;
}

export const refactorLensField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRefactorDiffEffect)) {
        const { diffResult, movedPairs, sessionLiveDeletes, sessionLiveInserts } = effect.value;
        if (!diffResult) {
          return Decoration.none;
        }

        const docLength = tr.newDoc.length;
        const items: DecorationItem[] = [];

        // 1. 挂载段落搬家徽标
        for (const pair of movedPairs) {
          const targetPos = Math.min(docLength, Math.max(0, pair.targetFrom));
          items.push({
            from: targetPos,
            to: targetPos,
            deco: Decoration.widget({
              widget: new MovedTargetWidget(pair),
              side: -1,
              block: true,
            }),
          });
        }

        // 2. 挂载基准差异（新增文字与删除文字）
        for (const seg of diffResult.segments) {
          if (seg.type === "insert") {
            const from = Math.min(docLength, Math.max(0, seg.from || 0));
            const to = Math.min(docLength, Math.max(0, seg.to || 0));
            if (from < to) {
              items.push({
                from,
                to,
                deco: Decoration.mark({
                  class: "refactor-diff-added",
                }),
              });
            }
          } else if (seg.type === "delete") {
            const pos = Math.min(docLength, Math.max(0, seg.from || 0));
            const cleanText = seg.text.trim();
            if (cleanText.length === 0) continue;

            const isMultiLine = seg.text.includes("\n") || cleanText.length > 50;
            if (isMultiLine) {
              // 跨行/大段删除：渲染为独立的块级卡片，还原排版结构与换行！
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedBlockCardWidget(seg.text, false),
                  side: 1,
                  block: true, // 独占整行独立卡片
                }),
              });
            } else {
              // 行内简短改删
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedInlineWidget(seg.text, false),
                  side: 1,
                }),
              });
            }
          }
        }

        // 3. 挂载现场编辑的删除标记
        if (sessionLiveDeletes && sessionLiveDeletes.length > 0) {
          for (const item of sessionLiveDeletes) {
            const pos = Math.min(docLength, Math.max(0, item.pos));
            const cleanText = item.text.trim();
            if (cleanText.length === 0) continue;

            const isMultiLine = item.text.includes("\n") || cleanText.length > 50;
            if (isMultiLine) {
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedBlockCardWidget(item.text, true),
                  side: 1,
                  block: true,
                }),
              });
            } else {
              items.push({
                from: pos,
                to: pos,
                deco: Decoration.widget({
                  widget: new DeletedInlineWidget(item.text, true),
                  side: 1,
                }),
              });
            }
          }
        }

        // 4. 挂载现场编辑的新增高亮
        if (sessionLiveInserts && sessionLiveInserts.length > 0) {
          for (const item of sessionLiveInserts) {
            const from = Math.min(docLength, Math.max(0, item.from));
            const to = Math.min(docLength, Math.max(0, item.to));
            if (from < to) {
              items.push({
                from,
                to,
                deco: Decoration.mark({
                  class: "refactor-live-added",
                }),
              });
            }
          }
        }

        // 5. 严格升序排序
        items.sort((a, b) => {
          if (a.from !== b.from) return a.from - b.from;
          return a.to - b.to;
        });

        // 6. 装配进 RangeSetBuilder
        const builder = new RangeSetBuilder<Decoration>();
        for (const item of items) {
          try {
            builder.add(item.from, item.to, item.deco);
          } catch (e) {
            console.warn("RefactorLens RangeSetBuilder 跳过:", item, e);
          }
        }

        return builder.finish();
      }
    }

    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
