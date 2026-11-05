# RefactorLens

**A source-clean revision lens and in-place AI rewriting workspace for Obsidian.**

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
- Select red text to show **Restore** and **Save inspiration**. Restore inserts only the selection where it is shown, keeping neighboring deletions available. Right-click a deletion to restore its entire unit.
- If the original context can be located uniquely in the current note, the context menu also offers **Restore to original location**. It leaves the page in place and adds session-only links between the two locations.
- Keep all comparison marks in CodeMirror decorations; the baseline lens does not write diff syntax into the note.
- Continue editing while the comparison refreshes.

### Paragraph move detection

- Pair likely moved paragraphs or standalone sentences, including lightly rewritten ones. Short fragments are excluded.
- Jump between the estimated old position and the new position using the two move buttons. The original-text preview opens separately.
- Restoring a red deletion inserts only that unit where it is displayed. Undo brings back the restore action.

Move detection is heuristic. Always review its result before treating a paragraph as definitively moved.

### In-place AI rewriting

- Select text and open the rewrite assistant from Obsidian.
- Use a custom instruction or quick actions for a more natural, conversational, concise, or pain-point-focused rewrite.
- Review multiple candidates before changing the note.
- Accept a complete rewrite, merge a selected clause, discard it, or save the old sentence to the scratchpad.
- Optionally include a short excerpt from a configured style benchmark.

Choose a locally installed [OpenAI Codex CLI](https://github.com/openai/codex) or [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness) in the plugin settings. Enter a model ID supported by your account or route, or leave it blank to use the CLI's configuration. For Harness, a model override can also specify a configured provider ID; the default route for an override is `deepseek-official`. The plugin does not ask for API keys. Configure authentication in your chosen CLI; the standard Harness headless profile does not reuse GUI sign-in.

### Inspiration scratchpad

- Save selected text, including explicitly selected deletions, without losing it.
- Store scratchpad content beside the current note or in one vault-level `_scratchpad.md` file.
- Browse saved passages in a sidebar and insert them back into a note.

## Privacy and data handling

RefactorLens has no telemetry or analytics.

- The plugin does not read or store CLI credential files.
- The plugin does not access the system clipboard.
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

**RefactorLens（文案透镜）是一款保持 Markdown 源文件纯净的 Obsidian 文案修订与 AI 行内改写插件。**

它面向保留多版 Markdown 稿件的写作者：无需打开程序员式 Diff，也无需向正文写入 CriticMarkup，就能在当前编辑器里查看新增、删除和疑似搬迁的段落。

> RefactorLens 已进入 Obsidian Community Plugins，目前仅支持桌面端。

## 功能

### 修订透镜

- 可选择 Vault 中任意 Markdown 文件作为比对基准。
- 通过文档顶部的小药丸快速切换底稿。
- 在当前编辑器内查看新增、删除文字和整体重构率。
- 删除内容保持为轻量行内痕迹，不再用块级卡片或复选框切断正文。
- 红字旁没有常驻按钮。划选任意红字后出现「恢复」和「存灵感」；恢复只写回所选部分，相邻红字继续显示。右键可恢复整个句子或片段。
- 只有能在当前稿唯一定位原上下文时，右键才提供「恢复到原出处」。页面留在操作处，两端显示仅本次会话有效的跳转标签。
- 差异标记只存在于 CodeMirror 显示层，不向源文件写入 Diff 语法。
- 编辑正文时实时刷新比对结果。

### 段落搬家识别

- 识别疑似搬迁的段落或独立句子，允许轻度改写，排除零碎文字。
- 在推定的原位置和新位置各显示一个徽标，可以双向跳转；原文对照单独展开。
- 原地恢复与搬迁跳转独立；撤销后可以再次恢复。

段落搬家采用启发式算法，结果应由用户复核，不能视为绝对判断。

### AI 行内改写

- 选中文字后在 Obsidian 内呼出改写顾问。
- 输入自定义要求，或使用自然化、口语化、精炼、加深现实痛点等快捷指令。
- 修改正文前先查看多个候选结果。
- 支持整句采纳、融合所选半句、放弃修改，或把旧句存入灵感抽屉。
- 可选择读取文风标杆文件的一小段内容作为参考。

可在设置中选择本机已安装的 [OpenAI Codex CLI](https://github.com/openai/codex) 或 [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness)，并填写账号或网关支持的模型 ID。留空时沿用 CLI 配置。为 Harness 指定模型时可同时填写提供方 ID，留空使用 `deepseek-official`。认证在对应 CLI 中配置；标准 Harness headless 配置不会复用图形界面登录。

### 灵感暂存抽屉

- 暂存主动选中的正文或删除文字。
- 可跟随当前文稿保存，也可集中存入 Vault 根目录下的 `_scratchpad.md`。
- 在侧边栏浏览素材并重新插回正文。

## 隐私与数据处理

RefactorLens 不包含遥测或数据分析。

- 插件不读取、不保存 CLI 凭据文件。
- 插件不访问系统剪贴板。
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
