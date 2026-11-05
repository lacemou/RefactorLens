import { App, TFile, normalizePath } from "obsidian";
import * as path from "path";

export interface ScratchpadItem {
  id: string;
  timestamp: number;
  dateStr: string;
  sourceFile: string;
  content: string;
}

export type StorageLocationMode = "same_folder" | "vault_root";
type UpdateListener = () => void;

/**
 * 健壮的灵感抽屉底层存储管理器
 * 1. 采用严格无损的正则锚点解析，彻底根除“删了下方才能删上方”的结构性脏数据 Bug；
 * 2. 支持“就近保存在当前文稿同级目录”与“全库集中存放”双模式；
 * 3. 自带全局变更事件广播机制，任何地方写入数据，抽屉与小药丸毫秒级自动联动刷新！
 */
export class ScratchpadManager {
  private app: App;
  private mode: StorageLocationMode = "same_folder";
  private customRootPath: string = "_scratchpad.md";
  private updateListeners: Set<UpdateListener> = new Set();

  constructor(app: App, customRootPath: string = "_scratchpad.md", mode: StorageLocationMode = "same_folder") {
    this.app = app;
    this.customRootPath = customRootPath;
    this.mode = mode;
  }

  public onUpdate(listener: UpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  private notifyUpdate() {
    for (const listener of this.updateListeners) {
      try {
        listener();
      } catch (err) {
        console.error("Scratchpad 更新监听器触发异常:", err);
      }
    }
  }

  public setMode(mode: StorageLocationMode) {
    this.mode = mode;
    this.notifyUpdate();
  }

  public setCustomRootPath(p: string) {
    this.customRootPath = p;
    this.notifyUpdate();
  }

  public resolveFilePath(currentDocPath?: string): string {
    if (this.mode === "same_folder" && currentDocPath) {
      const dir = path.dirname(currentDocPath);
      if (dir && dir !== "." && dir !== "/") {
        return normalizePath(`${dir}/_scratchpad.md`);
      }
    }
    return normalizePath(this.customRootPath || "_scratchpad.md");
  }

  private async getOrCreateFile(resolvedPath: string): Promise<TFile> {
    const abstractFile = this.app.vault.getAbstractFileByPath(resolvedPath);
    if (abstractFile instanceof TFile) {
      return abstractFile;
    }

    const initialContent = `# 📦 RefactorLens 灵感暂存抽屉 (Scratchpad)\n\n> 这里存放文案改稿过程中“删之可惜，留之多余”的好段落、金句与待发酵素材。\n> 随时从右侧抽屉一键插入回正文。\n\n`;
    return await this.app.vault.create(resolvedPath, initialContent);
  }

  public async getItems(currentDocPath?: string): Promise<ScratchpadItem[]> {
    try {
      const targetPath = this.resolveFilePath(currentDocPath);
      const abstractFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(abstractFile instanceof TFile)) {
        return [];
      }
      const text = await this.app.vault.read(abstractFile);
      return this.parseMarkdown(text);
    } catch (e) {
      console.error("读取灵感暂存失败:", e);
      return [];
    }
  }

  public async addItem(
    content: string,
    sourceFile: string = "当前文档",
    currentDocPath?: string
  ): Promise<ScratchpadItem> {
    const targetPath = this.resolveFilePath(currentDocPath);
    const file = await this.getOrCreateFile(targetPath);
    const now = Date.now();
    const dateStr = new Date(now).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const item: ScratchpadItem = {
      id: `sp-${now}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now,
      dateStr,
      sourceFile,
      content: content.trim(),
    };

    const currentText = await this.app.vault.read(file);
    const itemMarkdown = this.serializeItem(item);
    const updatedText = currentText.trimEnd() + "\n\n" + itemMarkdown;

    await this.app.vault.modify(file, updatedText);
    this.notifyUpdate(); // 自动广播变更！
    return item;
  }

  public async deleteItem(id: string, currentDocPath?: string): Promise<boolean> {
    try {
      const targetPath = this.resolveFilePath(currentDocPath);
      const file = await this.getOrCreateFile(targetPath);
      const items = await this.getItems(currentDocPath);
      const filtered = items.filter((item) => item.id !== id);

      if (filtered.length === items.length) return false;

      let newContent = `# 📦 RefactorLens 灵感暂存抽屉 (Scratchpad)\n\n> 这里存放文案改稿过程中“删之可惜，留之多余”的好段落、金句与待发酵素材。\n> 随时从右侧抽屉一键插入回正文。\n\n`;
      for (const it of filtered) {
        newContent += this.serializeItem(it) + "\n\n";
      }

      await this.app.vault.modify(file, newContent.trimEnd() + "\n");
      this.notifyUpdate(); // 自动广播变更！
      return true;
    } catch (e) {
      console.error("删除灵感条目失败:", e);
      return false;
    }
  }

  public async clearAll(currentDocPath?: string): Promise<void> {
    const targetPath = this.resolveFilePath(currentDocPath);
    const file = await this.getOrCreateFile(targetPath);
    const initialContent = `# 📦 RefactorLens 灵感暂存抽屉 (Scratchpad)\n\n> 这里存放文案改稿过程中“删之可惜，留之多余”的好段落、金句与待发酵素材。\n> 随时从右侧抽屉一键插入回正文。\n\n`;
    await this.app.vault.modify(file, initialContent);
    this.notifyUpdate(); // 自动广播变更！
  }

  private serializeItem(item: ScratchpadItem): string {
    return `### [${item.id}] ${item.dateStr} · 来自: ${item.sourceFile}\n\n${item.content}\n\n<!-- end-item -->`;
  }

  public parseMarkdown(text: string): ScratchpadItem[] {
    const items: ScratchpadItem[] = [];
    const regex = /^###\s*\[(sp-[^\]]+)\]\s*(.*?)\s*·\s*来自:\s*(.*?)$/gm;
    let match: RegExpExecArray | null;
    const matches: Array<{ id: string; dateStr: string; sourceFile: string; index: number; headerLength: number }> = [];

    while ((match = regex.exec(text)) !== null) {
      matches.push({
        id: match[1],
        dateStr: match[2],
        sourceFile: match[3],
        index: match.index,
        headerLength: match[0].length,
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const nextIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
      let rawBody = text.substring(cur.index + cur.headerLength, nextIndex).trim();
      rawBody = rawBody.replace(/<!--\s*end-item\s*-->/g, "").replace(/\n---\s*$/g, "").trim();

      items.push({
        id: cur.id,
        timestamp: 0,
        dateStr: cur.dateStr,
        sourceFile: cur.sourceFile,
        content: rawBody,
      });
    }

    return items;
  }
}
