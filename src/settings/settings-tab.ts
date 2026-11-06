import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type RefactorLensPlugin from "../main";
import type { RewriteCliSettings } from "../copilot/codex-cli";
import { StorageLocationMode } from "../scratchpad/scratchpad-manager";

export interface RefactorLensSettings extends RewriteCliSettings {
  benchmarkVaultPath: string;
  contextVaultPath: string;
  scratchpadMode: StorageLocationMode;
  scratchpadCustomPath: string;
}

export const DEFAULT_SETTINGS: RefactorLensSettings = {
  benchmarkVaultPath: "",
  contextVaultPath: "",
  codexCliPath: "",
  rewriteBackend: "codex",
  codexModel: "",
  deepseekCliPath: "",
  deepseekProvider: "",
  deepseekModel: "",
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
        heading: "⚡ AI 改写引擎与模型",
        items: [
          {
            name: "改写引擎",
            desc: "选择本机已安装的 CLI。只有主动发起改写才会将选区发送给所选引擎。",
            control: { type: "dropdown", key: "rewriteBackend", options: { codex: "Codex CLI", deepseek: "DeepSeek Harness (dsh)" } },
          },
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
            name: "Codex 模型 ID",
            desc: "填写当前 Codex 账号或网关支持的模型 ID。留空时沿用 Codex 自己的配置。",
            control: { type: "text", key: "codexModel", placeholder: "跟随 Codex 配置" },
          },
          {
            name: "DeepSeek Harness 程序路径",
            desc: "可留空自动探测；手动填写时请指向 dsh 可执行文件，不要填安装目录。",
            control: { type: "text", key: "deepseekCliPath", placeholder: "留空自动探测" },
          },
          {
            name: "DeepSeek Harness 提供方 ID",
            desc: "指定模型时使用的 Harness 路由 ID。留空使用 deepseek-official；自定义网关请填已配置的 ID。",
            control: { type: "text", key: "deepseekProvider", placeholder: "deepseek-official" },
          },
          {
            name: "DeepSeek Harness 模型 ID",
            desc: "官方路由的 deepseek-flash 对应 DeepSeek-V4.1-Flash。留空时沿用 Harness 的 headless 配置。",
            control: { type: "text", key: "deepseekModel", placeholder: "跟随 Harness 配置" },
          },
          {
            name: "当前引擎状态",
            desc: "检查当前选择的本地 CLI；不会发送文稿或测试模型调用。",
            render: (setting) => {
              setting
                .addButton((button) =>
                  button
                    .setButtonText("测试连接")
                    .setCta()
                    .onClick(() => {
                      button.setDisabled(true);
                      void this.testConnection(setting).catch(() => {
                        setting.setDesc("CLI 检查未能完成。请在系统终端运行 CLI 的 --version 命令，再重试。");
                      }).finally(() => button.setDisabled(false));
                    })
                );
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
            desc: "划选文字后呼出改写顾问，可采纳整句、复制所选候选文字，或放弃。",
          },
          {
            name: "快捷键",
            desc: "插件不预设全局快捷键。请前往 Obsidian 设置 → 快捷键，搜索 Refactor Lens 后自行绑定。改写面板可按 Esc 退出。",
          },
        ],
      },
    ];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);

    this.plugin.codexEngine.configure(this.plugin.settings);
    if (key === "scratchpadMode" && (value === "same_folder" || value === "vault_root")) {
      this.plugin.scratchpadManager.setMode(value);
      new Notice(`灵感抽屉模式已切换为：${value === "same_folder" ? "跟随文稿同级目录" : "全库统一存放"}`);
    } else if (key === "scratchpadCustomPath" && typeof value === "string") {
      this.plugin.scratchpadManager.setCustomRootPath(value.trim() || "_scratchpad.md");
    }
  }

  private async testConnection(setting: Setting): Promise<void> {
    const settings = { ...this.plugin.settings };
    const model = this.plugin.codexEngine.describeModel();
    setting.setDesc(`正在检查 ${model}…`);
    const detect = await this.plugin.codexEngine.detectCli(settings);

    if (detect.available === false) {
      setting.setDesc(`${model}：${this.plugin.codexEngine.describeCliFailure(detect)}`);
      return;
    }

    if (settings.rewriteBackend === "deepseek") {
      setting.setDesc("已找到 CLI，正在检查无界面模式…");
      const status = await this.plugin.codexEngine.checkHarnessHeadless(detect.path);
      if (status === "ready") {
        setting.setDesc(`已检测到 ${model}（${detect.version}），headless 模式就绪。此检查未调用模型。`);
      } else {
        setting.setDesc(status === "outdated"
          ? "Harness 版本过旧，缺少只读运行参数，请升级。"
          : "CLI 可启动，但 headless 模式未就绪。请在终端运行 dsh --profile headless --help 检查。");
      }
      return;
    }
    setting.setDesc("已找到 Codex CLI，正在检查登录状态…");
    const loginStatus = await this.plugin.codexEngine.checkLoginStatus(detect.path);
    if (loginStatus === null) {
      setting.setDesc(`已找到 Codex CLI，但登录状态检查超时。请在系统终端运行 \`codex login status\`。`);
      return;
    }
    const isLoggedIn = /chatgpt|logged in/i.test(loginStatus);
    if (isLoggedIn) {
      setting.setDesc(`✅ ${model}，登录状态：${loginStatus}。`);
    } else {
      setting.setDesc(
        `⚠️ 已检测到 Codex CLI：${detect.path} (${detect.version || "版本未知"})，但登录状态为：${loginStatus}。请在系统终端执行 \`codex login\`。`
      );
    }
  }
}
