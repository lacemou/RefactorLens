# Refactor Lens

**Compare drafts, right in your Obsidian editor.**

[中文说明](#中文说明)

Refactor Lens shows additions, deletions, and likely paragraph moves between Markdown drafts directly in the editor. Restore a deleted passage, save it for later, or optionally rewrite selected prose with Codex CLI or DeepSeek Harness (`dsh`). Comparison marks are visual overlays; they do not add diff syntax to your Markdown.

> RefactorLens is available in Obsidian Community Plugins and currently supports desktop only.

## Features

### Revision lens

- Choose any Markdown file in the vault as the comparison baseline.
- Switch baselines or turn the comparison off from the pill in the note header. Switching to another note and back in the same Obsidian session restores that note's selected baseline and comparison.
- See added text, deleted text, and the overall rewrite ratio in the active editor.
- Keep deleted text inline instead of interrupting the draft with block cards or multi-select controls.
- Large deletions are split into sentence- or line-level units, so each useful unit can be restored or saved independently.
- Select red text to show **Restore** (恢复) and **Save inspiration** (存灵感). Restore writes back only the selection at its displayed position, leaves nearby deletions available, and puts the caret after the restored text. Right-click a deletion to restore the whole sentence or fragment. Use Obsidian's undo and redo to reverse or repeat the edit.
- When the original surrounding text can be located uniquely in the current draft, the context menu also offers **Restore to original location** (恢复到原出处). The view stays at the action site; click the restored badge to jump to the inserted text, or the return badge to jump back. Undo and redo update the text and the pair of badges together. These links are for the current editing session and are not written to Markdown.
- Keep all comparison marks in CodeMirror decorations; the baseline lens does not write diff syntax into the note.
- Continue editing while the comparison refreshes.

### Paragraph move detection

- Pair likely moved paragraphs or standalone sentences, including lightly rewritten ones. Short fragments are excluded.
- Jump between the estimated old position and the new position using the two move buttons. The original-text preview opens separately.

Move detection is heuristic. Always review its result before treating a paragraph as definitively moved.

### In-place AI rewriting

- Select prose and click **AI rewrite** (AI 改写) in the selection popover. Enter an instruction or use a preset, then cycle through the candidates if more than one is returned.
- **Accept full rewrite** (采纳整句) replaces the original selection. **Copy selected text** (复制所选文字) copies only the text selected within the candidate for manual pasting. **Discard** (放弃) closes the panel without editing the note.
- An optional style reference can be a Markdown file in the vault or a file at an absolute path. Only its first 500 characters are included.

### Configure an AI rewrite backend

AI rewriting is optional. Draft comparison, restoration, and the scratchpad work without a CLI or an API key. Configure credentials in your chosen CLI, not in the plugin. In **Settings → Refactor Lens → AI 改写引擎与模型**, choose one locally installed CLI:

| Backend | Executable and model | Authentication |
| --- | --- | --- |
| [OpenAI Codex CLI](https://github.com/openai/codex) | `codex`. Leave the model ID blank to use Codex's own configuration, or enter a model available to your setup. | Configure Codex outside Obsidian. Use `codex login status` to check sign-in. |
| [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness) | `dsh`. Leave the model ID blank to use the Harness headless configuration. When overriding the model, a blank provider ID uses `deepseek-official`; for that route, `deepseek-flash` is the [DeepSeek-V4.1-Flash model ID](https://api-docs.deepseek.com/api/list-models/). Use a provider and model ID configured in Harness for a custom route. | The standard headless profile does not reuse GUI sign-in. For the official route, make `DEEPSEEK_API_KEY` available to the process or configure it in Harness's home `.env` (normally `~/.dsh/.env`, or `$DSH_HOME/.env`). See [headless credentials](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials). |

Leave the executable path blank for auto-detection. If it fails, enter the absolute path to the executable **file**, rather than its installation folder or an entire shell command. On macOS, `command -v codex` or `command -v dsh` can help locate it. A variable exported only in a terminal shell may not be available to Obsidian when launched from the Dock. Refactor Lens starts `dsh` from a private temporary directory, so a vault-local `.env` is not used as its working-directory configuration.

Open the header pill menu to see the selected CLI's detection status beside the rewrite assistant. **Check CLI** (检测 CLI) in plugin settings confirms that Codex starts, or that Harness headless supports the required flags. It does not send note text, check sign-in, or call a model. To check Codex sign-in separately, run `codex login status` in your terminal. If Harness is detected but cannot run, check `dsh --version` and `dsh --profile headless --help`; the latter must list both `--permission-mode` and `--approval-policy`.

On Windows, run `where.exe codex` and `codex --version` in PowerShell. If automatic detection fails, enter the full path to the native `codex.exe` in plugin settings. The plugin can resolve standard npm installations to their native executable without running the `codex.cmd` script.

### Inspiration scratchpad

- Save selected text, including explicitly selected deletions, without losing it.
- Store entries in `_scratchpad.md` beside the current note by default, or use a shared vault-root file with a configurable name.
- Open the scratchpad from the header pill or the archive ribbon icon. Search saved passages, insert one at the caret, or delete entries you no longer need.

## Privacy and data handling

RefactorLens has no telemetry or analytics.

- The plugin does not read or store CLI credential files.
- The plugin writes to the system clipboard only when you click **Copy selected text** in the rewrite panel. It does not read the clipboard.
- Without AI rewriting, note comparison and scratchpad operations stay inside Obsidian and the local vault.
- The baseline picker enumerates Markdown file paths in the current vault only when you open it, so it can present files available for comparison.
- When you request a rewrite, the selected text, instruction and up to 500 characters from an optional style benchmark go to the selected CLI, which may send them to its configured provider or gateway.
- The plugin launches the selected executable directly without a shell and requests read-only mode for rewrites.
- Node.js filesystem access is used for CLI discovery, private temporary files, and an optional style benchmark you explicitly locate outside the vault.
- The plugin passes the prompt through standard input. It deletes its temporary Codex output or Harness model overlay after the request. Harness may retain sessions in its own local history; the plugin disables Harness's session-log upload extension for its invocations.
- Scratchpad entries are ordinary Markdown stored in the vault.
- Plugin settings are stored by Obsidian in the plugin's `data.json`. If you configure absolute local paths, that file can contain those paths; exclude it from untrusted sync or version control when appropriate.

## Requirements

- Obsidian desktop `1.13.0` or later.
- macOS or Windows. Linux may work but is not yet an officially tested target.
- A configured Codex CLI or DeepSeek Harness CLI is required only for AI rewriting.

## Installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **Refactor Lens**, and select **Install** and **Enable**. Use **Check for updates** in Community plugins to upgrade an existing installation.

For a manual development installation:

1. Download or clone this repository.
2. Install dependencies and build the plugin:

   ```bash
   npm ci
   npm run build
   ```

3. Create this directory inside your vault:

   ```text
   <Vault>/.obsidian/plugins/refactor-lens/
   ```

4. Copy these files into it:

   ```text
   main.js
   manifest.json
   styles.css
   ```

5. Reload Obsidian and enable **Refactor Lens** under **Settings → Community plugins**.

## Getting started

1. Open the newer draft you want to edit.
2. Use the pill in the note header to choose an earlier Markdown file as the baseline.
3. Review the inline additions, deletions, and paragraph-move indicators.
4. Select a deletion to restore it or save it to the scratchpad. For optional AI rewriting, configure Codex CLI or DeepSeek Harness first, then select prose and click **AI rewrite**.
5. Search for **Refactor Lens** in **Settings → Hotkeys** to assign your own shortcuts; the plugin does not set default hotkeys.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
```

The production build generates `main.js`. The test suite is self-contained and does not require private vault files or Codex credentials.

## Verifying release provenance

Release assets from `0.1.1` onward are built by GitHub Actions and receive GitHub artifact attestations. After downloading an asset, verify it with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify main.js -R lacemou/RefactorLens
gh attestation verify manifest.json -R lacemou/RefactorLens
gh attestation verify styles.css -R lacemou/RefactorLens
```

## Security reports

Please avoid including private note content, credentials, or personal paths in a public issue. Use a minimal reproduction and redact sensitive material.

## License

[MIT](LICENSE)

---

## 中文说明

**Refactor Lens（文案透镜）：在 Obsidian 编辑器里直接对比稿件。**

在同一个编辑器里查看两版 Markdown 稿件的新增、删除和疑似段落搬迁。删掉的文字可以恢复或存入灵感抽屉，也可以选用 Codex CLI 或 DeepSeek Harness（`dsh`）改写所选正文。比对标记只显示在编辑器里，不会写进 Markdown。

> Refactor Lens 已进入 Obsidian Community Plugins，目前仅支持桌面端。

## 功能

### 修订透镜

- 可选择 Vault 中任意 Markdown 文件作为比对基准。
- 在文档顶部的小药丸里切换底稿或关闭比对。同一次 Obsidian 会话中，切到其他笔记再回来，会恢复这篇稿件选定的底稿和修订显示。
- 在当前编辑器内查看新增、删除文字和整体重构率。
- 删除内容保持为轻量行内痕迹，不再用块级卡片或复选框切断正文。
- 红字旁没有常驻按钮。划选红字后出现「恢复」和「存灵感」；原地恢复只写回所选部分，相邻红字仍可操作，光标放在恢复文字之后。右键可恢复整个句子或片段，支持 Obsidian 的撤销和重做。
- 只有能在当前稿唯一定位原上下文时，右键才提供「恢复到原出处」。页面留在操作处；点击「已恢复」跳到写入位置，再点「返回操作处」回来。撤销或重做会同时更新正文和这对标签。标签只在当前编辑会话使用，不写入 Markdown。
- 差异标记只存在于 CodeMirror 显示层，不向源文件写入 Diff 语法。
- 编辑正文时实时刷新比对结果。

### 段落搬家识别

- 识别疑似搬迁的段落或独立句子，允许轻度改写，排除零碎文字。
- 在推定的原位置和新位置各显示一个徽标，可以双向跳转；原文对照单独展开。

段落搬家采用启发式算法，结果应由用户复核，不能视为绝对判断。

### AI 行内改写

- 划选正文，点击弹出药丸中的「AI 改写」。输入要求或选快捷指令；有多个候选时可点「换一版」。
- 「采纳整句」用整个候选替换最初选中的原文；「复制所选文字」只复制候选中划选的部分，由你自己粘贴；「放弃」关闭面板，不改正文。
- 可选配文风标杆文件，支持 Vault 相对路径或系统绝对路径，只取前 500 个字符作为参考。

### 配置 AI 改写引擎

AI 改写是可选功能。稿件比对、文字恢复和灵感抽屉都不需要 CLI 或 API Key。凭据在对应 CLI 里配置，不用填进插件。要使用改写，请到 **设置 → Refactor Lens → AI 改写引擎与模型**，选择一个本机已安装的 CLI：

| 引擎 | 程序与模型 | 认证 |
| --- | --- | --- |
| [OpenAI Codex CLI](https://github.com/openai/codex) | 程序为 `codex`。模型 ID 留空就沿用 Codex 配置，也可填写当前账号或网关支持的模型。 | 在 Obsidian 外完成 Codex 认证，可用 `codex login status` 检查。 |
| [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness) | 程序为 `dsh`。模型 ID 留空就沿用 Harness headless 配置。若指定模型，提供方 ID 留空会使用 `deepseek-official`；官方路由的 `deepseek-flash` 对应 [DeepSeek-V4.1-Flash](https://api-docs.deepseek.com/api/list-models/)。自定义网关需填在 Harness 中已配置的提供方和模型 ID。 | 标准 headless 配置不会复用图形界面的登录。官方路由可通过进程环境或 Harness 主目录的 `.env` 提供 `DEEPSEEK_API_KEY`，通常是 `~/.dsh/.env`；自定义主目录则是 `$DSH_HOME/.env`。详见 [headless 认证说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials)。 |

程序路径可留空自动探测。找不到时，填写**可执行文件的绝对路径**，不要填安装目录或整条命令。macOS 上可用 `command -v codex` 或 `command -v dsh` 查找。只在终端里导出的变量，从 Dock 启动的 Obsidian 不一定能继承。插件会从私有临时目录启动 `dsh`，所以 Vault 里的 `.env` 不会作为其工作目录配置使用。

Windows 上可在 PowerShell 运行 `where.exe codex` 和 `codex --version`。如果自动探测失败，请在设置里填写原生 `codex.exe` 的绝对路径。对于标准 npm 安装，插件可以定位原生程序，无需执行 `codex.cmd` 脚本。

顶部修订透镜药丸的「呼出改写顾问」旁显示所选 CLI 的检测状态。设置里的「检测 CLI」确认 Codex 能否启动，或检查 Harness headless 是否支持所需参数；它不会发送文稿、检查登录或调用模型。要查看 Codex 登录状态，请在终端运行 `codex login status`。如果检测到 Harness 但改写失败，先运行 `dsh --version` 和 `dsh --profile headless --help`，确认后者列出了 `--permission-mode` 和 `--approval-policy`。

### 灵感暂存抽屉

- 暂存主动选中的正文或删除文字。
- 默认保存在当前文稿同目录的 `_scratchpad.md`；也可改用 Vault 根目录下的共享文件，文件名可配置。
- 从顶部药丸或左侧归档图标打开抽屉，可以搜索条目、插入光标处或删除不再需要的素材。

## 隐私与数据处理

RefactorLens 不包含遥测或数据分析。

- 插件不读取、不保存 CLI 凭据文件。
- 只有点击改写面板的「复制所选文字」时才写入系统剪贴板；插件不读取剪贴板。
- 不使用 AI 改写时，文稿比对和灵感暂存只在 Obsidian 与本地 Vault 内进行。
- 仅当你打开底稿选择器时，插件会枚举当前 Vault 内的 Markdown 文件路径，用于列出可选底稿。
- 发起改写时，选中文字、指令和可选文风标杆的前 500 个字符会传给所选 CLI，由它按自身配置发送给模型提供方或网关。
- 插件直接启动指定的可执行文件，不经过 Shell，并为改写请求只读模式。
- Node.js 文件系统访问用于查找 CLI、管理独立临时文件，以及读取你明确配置在 Vault 外的可选文风标杆。
- 插件通过标准输入传递提示词，并在请求结束后删除自己的 Codex 临时输出或 Harness 模型配置。Harness 仍可能保留本地会话历史；插件会在自己的调用中关闭 Harness 的会话日志上传扩展。
- 灵感抽屉内容以普通 Markdown 文件保存在 Vault 中。
- 插件设置由 Obsidian 写入插件目录下的 `data.json`。若填写绝对路径，该文件可能包含本地路径；必要时请将其排除在不可信的同步或版本控制之外。

## 环境要求

- Obsidian 桌面版 `1.13.0` 或更高版本。
- 正式目标平台为 macOS 和 Windows；Linux 尚未作为正式测试平台。
- 仅 AI 改写需要安装并配置 Codex CLI 或 DeepSeek Harness CLI。

## 安装

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 **Refactor Lens**，安装后启用。已安装的用户可在第三方插件页面「检查更新」。

如需手动安装开发版本：

1. 下载或克隆本仓库。
2. 安装依赖并构建：

   ```bash
   npm ci
   npm run build
   ```

3. 在 Vault 中创建目录：

   ```text
   <Vault>/.obsidian/plugins/refactor-lens/
   ```

4. 将以下文件复制进去：

   ```text
   main.js
   manifest.json
   styles.css
   ```

5. 重新加载 Obsidian，在 **设置 → 第三方插件** 中启用 **Refactor Lens**。

## 开始使用

1. 打开需要继续修改的新版本稿件。
2. 点击文档顶部小药丸，选择较早版本作为底稿。
3. 审阅行内新增、删除与段落搬迁提示。
4. 选中红字可恢复或存入灵感抽屉。如果要改写，先配置 Codex CLI 或 DeepSeek Harness，再划选正文并点击「AI 改写」。
5. 插件不预设快捷键。可在 **设置 → 快捷键** 中搜索 **Refactor Lens** 自行绑定。

## 开发与验证

```bash
npm ci
npm test
npm run lint
npm run build
```

生产构建会生成 `main.js`。测试用例完全自包含，不依赖私人 Vault 文件或 Codex 凭据。

## 验证发布产物来源

从 `0.1.1` 起，发布产物由 GitHub Actions 构建，并生成 GitHub 产物证明。下载后可使用 [GitHub CLI](https://cli.github.com/) 验证：

```bash
gh attestation verify main.js -R lacemou/RefactorLens
gh attestation verify manifest.json -R lacemou/RefactorLens
gh attestation verify styles.css -R lacemou/RefactorLens
```

## 安全问题反馈

公开提交 Issue 时，请勿附上私人文稿、登录凭据或真实本地路径。请使用最小复现材料，并对敏感内容脱敏。

## 许可证

[MIT](LICENSE)
