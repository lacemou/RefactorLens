import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type RefactorLensPlugin from "../main";
import { StorageLocationMode } from "../scratchpad/scratchpad-manager";

export interface RefactorLensSettings {
  benchmarkVaultPath: string; // 文风标杆库路径 (支持相对路径或绝对路径)
  contextVaultPath: string; // 个人内容库主目录 (支持相对路径或绝对路径)
  autoDetectPreviousVersion: boolean;
  codexCliPath: string;
  scratchpadMode: StorageLocationMode;
  scratchpadCustomPath: string;
}

export const DEFAULT_SETTINGS: RefactorLensSettings = {
  benchmarkVaultPath: "",
  contextVaultPath: "",
  autoDetectPreviousVersion: true,
  codexCliPath: "",
  scratchpadMode: "same_folder",
  scratchpadCustomPath: "_scratchpad.md",
};

export class RefactorLensSettingTab extends PluginSettingTab {
  plugin: RefactorLensPlugin;

  constructor(app: App, plugin: RefactorLensPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("refactor-settings-root");

    containerEl.createEl("h2", { text: "RefactorLens (文案透镜) 设置中心" });

    // 1. 文风标杆库设置
    new Setting(containerEl)
      .setName("文风标杆库路径 (Style Benchmarks)")
      .setDesc("改写时作为语感度量衡。支持 Vault 相对路径或系统绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("如：写作素材/范文库.md")
          .setValue(this.plugin.settings.benchmarkVaultPath)
          .onChange(async (value) => {
            this.plugin.settings.benchmarkVaultPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // 2. 个人内容资产库
    new Setting(containerEl)
      .setName("个人内容资产库主目录 (Context Vault)")
      .setDesc("存放历史稿件和过程稿的目录。支持 Vault 相对路径或系统绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("如：文章")
          .setValue(this.plugin.settings.contextVaultPath)
          .onChange(async (value) => {
            this.plugin.settings.contextVaultPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // 3. 灵感抽屉存储模式
    containerEl.createEl("h3", { text: "📦 灵感暂存抽屉设置" });

    new Setting(containerEl)
      .setName("灵感抽屉物理存储模式")
      .setDesc("选择是就近存放在当前文稿所在文件夹，还是全库集中保存在单文件。")
      .addDropdown((drop) =>
        drop
          .addOption("same_folder", "跟随当前文稿同级目录 (就近存放，推荐)")
          .addOption("vault_root", "全库统一集中存放 (Vault 根目录)")
          .setValue(this.plugin.settings.scratchpadMode)
          .onChange(async (val: StorageLocationMode) => {
            this.plugin.settings.scratchpadMode = val;
            this.plugin.scratchpadManager.setMode(val);
            await this.plugin.saveSettings();
            new Notice(`灵感抽屉模式已切换为：${val === "same_folder" ? "跟随文稿同级目录" : "全库统一存放"}`);
          })
      );

    new Setting(containerEl)
      .setName("全库集中存放时的文件名")
      .setDesc("仅在全库统一存放模式下生效（默认为 _scratchpad.md）。")
      .addText((text) =>
        text
          .setPlaceholder("_scratchpad.md")
          .setValue(this.plugin.settings.scratchpadCustomPath)
          .onChange(async (val) => {
            this.plugin.settings.scratchpadCustomPath = val.trim() || "_scratchpad.md";
            this.plugin.scratchpadManager.setCustomRootPath(this.plugin.settings.scratchpadCustomPath);
            await this.plugin.saveSettings();
          })
      );

    // 4. Codex CLI 与 ChatGPT 账号配置
    containerEl.createEl("h3", { text: "⚡ Codex CLI 与 AI 改写配置" });

    new Setting(containerEl)
      .setName("Codex CLI 程序路径")
      .setDesc("可留空自动探测；若探测失败，可填入 Codex CLI 的系统绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("留空自动探测，或输入绝对路径")
          .setValue(this.plugin.settings.codexCliPath)
          .onChange(async (val) => {
            this.plugin.settings.codexCliPath = val.trim();
            this.plugin.codexEngine.setCustomBinaryPath(this.plugin.settings.codexCliPath);
            await this.plugin.saveSettings();
          })
      );

    const statusSetting = new Setting(containerEl)
      .setName("Codex CLI 运行与登录状态检测")
      .setDesc("正在检测...")
      .addButton((btn) =>
        btn
          .setButtonText("一键测试连接")
          .setCta()
          .onClick(() => {
            this.testCodexConnection(statusSetting);
          })
      )
      .addButton((btn) =>
        btn.setButtonText("复制终端绑定命令 (`codex login`)").onClick(() => {
          navigator.clipboard.writeText("codex login");
          new Notice("📋 已复制 'codex login' 到剪贴板！打开系统终端粘贴回车即可绑定。");
        })
      );

    // 5. 操作参考与快捷键指南
    containerEl.createEl("h3", { text: "📖 操作说明与快捷键参考" });
    const guideEl = containerEl.createDiv({ cls: "refactor-settings-guide-card" });
    guideEl.innerHTML = `
      <div class="refactor-settings-doc">
        <div class="refactor-doc-section">
          <div class="refactor-doc-subtitle">一、核心交互规范</div>
          <ul class="refactor-doc-list">
            <li><b>透镜比对</b>：点击右上角胶囊选择基准底稿，实时渲染新增高亮、删除卡片与段落搬迁标记。</li>
            <li><b>灵感暂存</b>：删除卡片支持单段暂存（悬停）、多段合并（勾选）及整段收纳；正文划选支持气泡暂存与右键收录。素材就近持久化，随时拖回复用。</li>
            <li><b>行内改写</b>：划选 1~2 句话呼出 AI 顾问；支持整句采纳、点选分句采纳、鼠标划选半句精准拼接，或采纳并备份旧句。</li>
          </ul>
        </div>

        <div class="refactor-doc-section">
          <div class="refactor-doc-subtitle">二、默认快捷键一览</div>
          <table class="refactor-doc-table">
            <thead>
              <tr>
                <th>操作指令</th>
                <th>默认快捷键 (macOS / Windows)</th>
                <th>作用域与说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>呼出行内改写顾问</td>
                <td><code>Cmd + Shift + K</code> / <code>Ctrl + Shift + K</code></td>
                <td>选中文本后呼出改写面板</td>
              </tr>
              <tr>
                <td>将选中文本暂存至抽屉</td>
                <td><code>Cmd + Shift + P</code> / <code>Ctrl + Shift + P</code></td>
                <td>直接将正文选区存入抽屉</td>
              </tr>
              <tr>
                <td>切换/关闭文案修订透镜</td>
                <td>可自定义（见下方）</td>
                <td>切换当前文档的透镜图层</td>
              </tr>
              <tr>
                <td>采纳改写成稿 / 融合半句</td>
                <td><code>Enter</code></td>
                <td>在改写面板内确认替换入正文</td>
              </tr>
              <tr>
                <td>放弃改写并退出</td>
                <td><code>Esc</code></td>
                <td>关闭面板，原文保持原样</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="refactor-doc-section">
          <div class="refactor-doc-subtitle">三、快捷键自定义方式</div>
          <p class="refactor-doc-desc">
            前往 <b>Obsidian 设置 ➔ 快捷键 (Hotkeys)</b>，在搜索框输入 <code>RefactorLens</code>，即可为上述任意指令指定或修改为你偏好的快捷键组合。
          </p>
        </div>
      </div>
    `;

    this.testCodexConnection(statusSetting);
  }

  private async testCodexConnection(setting: Setting): Promise<void> {
    setting.setDesc("🔍 正在探测本地环境与 Codex CLI 状态...");
    const detect = await this.plugin.codexEngine.detectCodexPath();

    if (detect.available) {
      const loginStatus = await this.plugin.codexEngine.checkLoginStatus(detect.path);
      const isChatGPT =
        loginStatus.toLowerCase().includes("chatgpt") || loginStatus.toLowerCase().includes("logged in");
      if (isChatGPT) {
        setting.setDesc(
          `✅ 成功连接！检测到 Codex CLI (${detect.version || "就绪"})，且已成功绑定 ChatGPT 账号 (${loginStatus})。AI 改写已全面就绪，直接使用 Plus/Pro 额度！`
        );
      } else {
        setting.setDesc(
          `⚠️ 已检测到本地 Codex CLI：${detect.path} (${detect.version})，但当前状态为：${loginStatus}。请在系统终端执行 \`codex login\` 绑定 ChatGPT Plus。`
        );
      }
    } else {
      setting.setDesc(
        `⚠️ 未在系统默认路径找到 codex 命令。建议在上方输入绝对路径（如在终端运行 which codex 获取并在上方粘贴）。`
      );
    }
  }
}
