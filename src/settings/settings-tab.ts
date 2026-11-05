import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type RefactorLensPlugin from "../main";
import { StorageLocationMode } from "../scratchpad/scratchpad-manager";

export interface RefactorLensSettings {
  benchmarkVaultPath: string;
  contextVaultPath: string;
  codexCliPath: string;
  scratchpadMode: StorageLocationMode;
  scratchpadCustomPath: string;
}

export const DEFAULT_SETTINGS: RefactorLensSettings = {
  benchmarkVaultPath: "",
  contextVaultPath: "",
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

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "文风与内容",
        items: [
          {
            name: "文风标杆库路径 (Style benchmarks)",
            desc: "改写时作为语感参考。支持 Vault 相对路径或系统绝对路径。",
            control: {
              type: "text",
              key: "benchmarkVaultPath",
              placeholder: "如：写作素材/范文库.md",
            },
          },
          {
            name: "个人内容资产库主目录 (Context vault)",
            desc: "存放历史稿件和过程稿的目录。支持 Vault 相对路径或系统绝对路径。",
            control: {
              type: "text",
              key: "contextVaultPath",
              placeholder: "如：文章",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "📦 灵感暂存抽屉",
        items: [
          {
            name: "物理存储模式",
            desc: "选择就近存放在当前文稿目录，或集中保存在 Vault 根目录。",
            control: {
              type: "dropdown",
              key: "scratchpadMode",
              options: {
                same_folder: "跟随当前文稿同级目录 (推荐)",
                vault_root: "全库统一集中存放 (Vault 根目录)",
              },
            },
          },
          {
            name: "全库集中存放时的文件名",
            desc: "仅在全库统一存放模式下生效。",
            control: {
              type: "text",
              key: "scratchpadCustomPath",
              defaultValue: "_scratchpad.md",
              placeholder: "_scratchpad.md",
              validate: (value) => (value.trim() ? undefined : "文件名不能为空。"),
            },
          },
        ],
      },
      {
        type: "group",
        heading: "⚡ Codex CLI 与 AI 改写",
        items: [
          {
            name: "Codex CLI 程序路径",
            desc: "可留空自动探测；若探测失败，可填写 Codex CLI 的系统绝对路径。",
            control: {
              type: "text",
              key: "codexCliPath",
              placeholder: "留空自动探测，或输入绝对路径",
            },
          },
          {
            name: "Codex CLI 运行与登录状态",
            desc: "检查本机是否能够调用 Codex CLI。",
            render: (setting) => {
              setting
                .addButton((button) =>
                  button
                    .setButtonText("测试连接")
                    .setCta()
                    .onClick(() => void this.testCodexConnection(setting))
                )
                .addButton((button) =>
                  button.setButtonText("查看登录命令").onClick(() => {
                    new Notice("请打开系统终端并运行 Codex CLI 登录命令。", 8000);
                  })
                );
              void this.testCodexConnection(setting);
            },
          },
        ],
      },
      {
        type: "group",
        heading: "📖 操作说明",
        items: [
          {
            name: "修订透镜",
            desc: "点击文档顶部胶囊选择基准底稿，实时显示新增、删除与段落搬迁。",
          },
          {
            name: "灵感暂存",
            desc: "将删除段落或正文选区保存到当前文稿附近的灵感抽屉。",
          },
          {
            name: "行内改写",
            desc: "划选文字后呼出 Codex 顾问，可整句或分句采纳，并可备份旧句。",
          },
          {
            name: "快捷键",
            desc: "插件不预设全局快捷键。请前往 Obsidian 设置 → 快捷键，搜索 Refactor Lens 后自行绑定。改写面板内可用 Enter 确认、Esc 退出。",
          },
        ],
      },
    ];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);

    if (key === "codexCliPath" && typeof value === "string") {
      this.plugin.codexEngine.setCustomBinaryPath(value.trim());
    } else if (key === "scratchpadMode" && (value === "same_folder" || value === "vault_root")) {
      this.plugin.scratchpadManager.setMode(value);
      new Notice(`灵感抽屉模式已切换为：${value === "same_folder" ? "跟随文稿同级目录" : "全库统一存放"}`);
    } else if (key === "scratchpadCustomPath" && typeof value === "string") {
      this.plugin.scratchpadManager.setCustomRootPath(value.trim() || "_scratchpad.md");
    }
  }

  private async testCodexConnection(setting: Setting): Promise<void> {
    setting.setDesc("🔍 正在探测本地环境与 Codex CLI 状态...");
    const detect = await this.plugin.codexEngine.detectCodexPath();

    if (!detect.available) {
      setting.setDesc("⚠️ 未在系统默认路径找到 codex 命令。可在上方填写 `which codex` 返回的绝对路径。");
      return;
    }

    const loginStatus = await this.plugin.codexEngine.checkLoginStatus(detect.path);
    const isLoggedIn = /chatgpt|logged in/i.test(loginStatus);
    if (isLoggedIn) {
      setting.setDesc(`✅ 已连接 Codex CLI (${detect.version || "就绪"})，登录状态：${loginStatus}。`);
    } else {
      setting.setDesc(
        `⚠️ 已检测到 Codex CLI：${detect.path} (${detect.version || "版本未知"})，但登录状态为：${loginStatus}。请在系统终端执行 \`codex login\`。`
      );
    }
  }
}
