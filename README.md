# RefactorLens

**A source-clean revision lens and in-place Codex rewriting workspace for Obsidian.**

[中文说明](#中文说明)

RefactorLens is built for writers who keep multiple Markdown drafts and want to review revisions without turning their notes into raw diff output or CriticMarkup. It overlays additions, deletions, and likely paragraph moves directly in the active Obsidian editor while keeping the underlying Markdown clean.

> RefactorLens is available in Obsidian Community Plugins and currently supports desktop only.

## Features

### Revision lens

- Choose any Markdown file in the vault as the comparison baseline.
- Switch baselines from a compact control in the note header.
- See added text, deleted text, and the overall rewrite ratio in the active editor.
- Keep deleted text inline instead of interrupting the draft with block cards or multi-select controls.
- Large deletions are split into sentence- or line-level units, so each useful unit can be restored or saved independently.
- Tiny deletions stay visually quiet: they show no action buttons and can be restored with a right-click. A scratchpad action appears only for reusable sentence-length content.
- Keep all comparison marks in CodeMirror decorations; the baseline lens does not write diff syntax into the note.
- Continue editing while the comparison refreshes.

### Paragraph move detection

- Detect likely paragraphs that were moved and lightly rewritten.
- Show their original and current section positions.
- Navigate between move indicators in the editor.

Move detection is heuristic. Always review its result before treating a paragraph as definitively moved.

### In-place Codex rewriting

- Select text and open the rewrite assistant from Obsidian.
- Use a custom instruction or quick actions for a more natural, conversational, concise, or pain-point-focused rewrite.
- Review multiple candidates before changing the note.
- Accept a complete rewrite, merge a selected clause, discard it, or save the old sentence to the scratchpad.
- Optionally include a short excerpt from a configured style benchmark.

Codex rewriting requires a locally installed and authenticated [OpenAI Codex CLI](https://github.com/openai/codex). RefactorLens reuses the CLI's existing authentication and does not ask for an API key.

### Inspiration scratchpad

- Save selected text or sentence-length removed passages without losing them. Tiny deletions are intentionally excluded.
- Store scratchpad content beside the current note or in one vault-level `_scratchpad.md` file.
- Browse saved passages in a sidebar and insert them back into a note.

## Privacy and data handling

RefactorLens has no telemetry or analytics.

- The plugin does not read or store Codex credential files.
- The plugin does not access the system clipboard.
- Without Codex rewriting, note comparison and scratchpad operations stay inside Obsidian and the local vault.
- The baseline picker enumerates Markdown file paths in the current vault only when you open it, so it can present files available for comparison.
- When you request a Codex rewrite, the selected text, your instruction, and up to 500 characters from an optional style benchmark are passed to the local Codex CLI. The CLI may then communicate with OpenAI according to its own configuration and privacy terms.
- To provide this opt-in desktop feature, the plugin launches the exact Codex CLI executable directly without a shell. That child process inherits the local user's permissions. It runs only after an explicit rewrite request or connection test.
- Node.js filesystem access is limited to locating the configured Codex executable, managing a private temporary output directory, and reading an optional style benchmark when you explicitly configure an absolute path outside the vault.
- Rewrite prompts are passed through the child process's standard input rather than saved as plaintext prompt files.
- Final CLI output uses a private temporary directory and is removed after the request finishes.
- Scratchpad entries are ordinary Markdown stored in the vault.
- Plugin settings are stored by Obsidian in the plugin's `data.json`. If you configure absolute local paths, that file can contain those paths; exclude it from untrusted sync or version control when appropriate.

## Requirements

- Obsidian desktop `1.13.0` or later.
- macOS or Windows. Linux may work but is not yet an officially tested target.
- Codex CLI is optional and only required for AI rewriting.

## Installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **Refactor Lens**, and select **Install**.

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
4. Select a sentence to open the Codex rewrite assistant, or save the selection to the scratchpad.
5. Configure hotkeys under **Settings → Hotkeys** by searching for `RefactorLens`.

## Development

```bash
npm ci
npm test
npm run build
```

The production build generates `main.js`. The test suite is self-contained and does not require private vault files or Codex credentials.

## Verifying release provenance

Release assets from `0.1.1` onward are built by GitHub Actions and receive GitHub artifact attestations. After downloading an asset, verify it with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify main.js -R lacemou/RefactorLens
gh attestation verify styles.css -R lacemou/RefactorLens
```

## Security reports

Please avoid including private note content, credentials, or personal paths in a public issue. Use a minimal reproduction and redact sensitive material.

## License

[MIT](LICENSE)

---

## 中文说明

**RefactorLens（文案透镜）是一款保持 Markdown 源文件纯净的 Obsidian 文案修订与 Codex 行内改写插件。**

它面向保留多版 Markdown 稿件的写作者：无需打开程序员式 Diff，也无需向正文写入 CriticMarkup，就能在当前编辑器里查看新增、删除和疑似搬迁的段落。

> RefactorLens 已进入 Obsidian Community Plugins，目前仅支持桌面端。

## 功能

### 修订透镜

- 可选择 Vault 中任意 Markdown 文件作为比对基准。
- 通过文档顶部的小药丸快速切换底稿。
- 在当前编辑器内查看新增、删除文字和整体重构率。
- 删除内容保持为轻量行内痕迹，不再用块级卡片或复选框切断正文。
- 大段删除内容会继续按句子或独立行拆分，每个有价值的单元都能分别恢复或存入灵感抽屉。
- 零碎删字不显示操作按钮，右键即可原位恢复；只有达到可独立复用的一句话时，才显示“存灵感”入口。
- 差异标记只存在于 CodeMirror 显示层，不向源文件写入 Diff 语法。
- 编辑正文时实时刷新比对结果。

### 段落搬家识别

- 识别疑似被移动并经过轻度改写的段落。
- 显示原段落位置和当前段落位置。
- 在编辑器中通过搬迁标记定位相关内容。

段落搬家采用启发式算法，结果应由用户复核，不能视为绝对判断。

### Codex 行内改写

- 选中文字后在 Obsidian 内呼出改写顾问。
- 输入自定义要求，或使用自然化、口语化、精炼、加深现实痛点等快捷指令。
- 修改正文前先查看多个候选结果。
- 支持整句采纳、融合所选半句、放弃修改，或把旧句存入灵感抽屉。
- 可选择读取文风标杆文件的一小段内容作为参考。

该功能需要本机已安装并登录 [OpenAI Codex CLI](https://github.com/openai/codex)。插件复用 CLI 已有的登录状态，不要求填写 API Key。

### 灵感暂存抽屉

- 暂存选中文字或达到一句话长度、仍有复用价值的删除内容；零碎删字不会进入灵感抽屉。
- 可跟随当前文稿保存，也可集中存入 Vault 根目录下的 `_scratchpad.md`。
- 在侧边栏浏览素材并重新插回正文。

## 隐私与数据处理

RefactorLens 不包含遥测或数据分析。

- 插件不读取、不保存 Codex 凭据文件。
- 插件不访问系统剪贴板。
- 不使用 Codex 改写时，文稿比对和灵感暂存只在 Obsidian 与本地 Vault 内进行。
- 仅当你打开底稿选择器时，插件会枚举当前 Vault 内的 Markdown 文件路径，用于列出可选底稿。
- 发起 Codex 改写时，选中文字、改写指令，以及可选文风标杆的前 500 个字符会传给本地 Codex CLI；CLI 可能依据自身配置和隐私条款与 OpenAI 通信。
- 为提供这项主动触发的桌面端功能，插件会直接启动指定的 Codex CLI 可执行文件，不经过 Shell。该子进程继承当前用户权限，仅在你主动发起改写或连接测试时运行。
- Node.js 文件系统访问仅用于定位 Codex 可执行文件、管理独立临时输出目录，以及在你明确配置 Vault 外绝对路径时读取可选文风标杆。
- 改写提示词通过子进程标准输入传递，不保存为明文提示词文件。
- CLI 最终输出使用独立临时目录，并在请求完成后删除。
- 灵感抽屉内容以普通 Markdown 文件保存在 Vault 中。
- 插件设置由 Obsidian 写入插件目录下的 `data.json`。若填写绝对路径，该文件可能包含本地路径；必要时请将其排除在不可信的同步或版本控制之外。

## 环境要求

- Obsidian 桌面版 `1.13.0` 或更高版本。
- 正式目标平台为 macOS 和 Windows；Linux 尚未作为正式测试平台。
- Codex CLI 仅在使用 AI 改写时需要安装。

## 安装

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 **Refactor Lens** 并点击安装。

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
4. 选中句子使用 Codex 改写，或把选区收入灵感抽屉。
5. 在 **设置 → 快捷键** 中搜索 `RefactorLens`，按个人习惯配置快捷键。

## 开发与验证

```bash
npm ci
npm test
npm run build
```

生产构建会生成 `main.js`。测试用例完全自包含，不依赖私人 Vault 文件或 Codex 凭据。

## 验证发布产物来源

从 `0.1.1` 起，发布产物由 GitHub Actions 构建，并生成 GitHub 产物证明。下载后可使用 [GitHub CLI](https://cli.github.com/) 验证：

```bash
gh attestation verify main.js -R lacemou/RefactorLens
gh attestation verify styles.css -R lacemou/RefactorLens
```

## 安全问题反馈

公开提交 Issue 时，请勿附上私人文稿、登录凭据或真实本地路径。请使用最小复现材料，并对敏感内容脱敏。

## 许可证

[MIT](LICENSE)
