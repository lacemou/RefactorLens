import { execFile, spawn, type ChildProcessByStdio, type ExecFileException } from "child_process";
import type { Readable, Writable } from "stream";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { clearTimeout as clearProbeTimeout, setTimeout as setProbeTimeout } from "timers";

type CliDetection = { available: true; path: string; version: string } |
  { available: false; path: string; reason: "missing" | "directory" | "dependency" | "launch" | "wrapper" | "timeout" };
type CodexLoginStatus = "ready" | "signed-out" | "unavailable" | "timeout";

export interface CodexRewriteOptions {
  originalText: string;
  instruction: string;
  styleContext?: string;
}

export class CodexCliEngine {
  constructor(private settings: RewriteCliSettings) {}

  public configure(settings: RewriteCliSettings) {
    this.settings = settings;
  }

  public describeModel(): string {
    const { rewriteBackend, codexModel, deepseekModel, deepseekProvider } = this.settings;
    if (rewriteBackend === "deepseek") {
      return `DeepSeek Harness · ${deepseekModel.trim() ? `${deepseekProvider.trim() || "deepseek-official"}/${deepseekModel.trim()}` : "跟随 Harness 配置"}`;
    }
    return `Codex CLI · ${codexModel.trim() || "跟随 Codex 配置"}`;
  }

  public getEnhancedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const home = os.homedir();
    const isWin = os.platform() === "win32";

    if (isWin) {
      return env;
    }

    const extraPaths = [
      path.join(home, "Library/pnpm/bin"),
      path.join(home, ".local/bin"),
      path.join(home, ".npm-global/bin"),
      path.join(home, ".nvm/current/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = env.PATH || "";
    env.PATH = Array.from(new Set([...extraPaths, ...currentPath.split(":")])).join(":");
    env.LANG = "zh_CN.UTF-8";
    return env;
  }

  public async detectCli(settings = this.settings): Promise<CliDetection> {
    const isWin = os.platform() === "win32";
    const home = os.homedir();

    const deepseek = settings.rewriteBackend === "deepseek";
    const name = deepseek ? "dsh" : "codex";
    const custom = (deepseek ? settings.deepseekCliPath : settings.codexCliPath).trim().replace(/^"([^"]+)"$/, "$1");
    const wrapper = isWin && /\.(?:cmd|bat|ps1)$/i.test(custom);
    const candidates = isWin ? this.windowsCandidates(name, custom, wrapper) : custom ? [custom] : [
      path.join(home, "Library/pnpm/bin", name),
      path.join(home, ".npm-global/bin", name),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      path.join(home, ".local/bin", name),
      name,
    ];

    let failure: CliDetection = { available: false, path: custom, reason: wrapper ? "wrapper" : "missing" };
    for (const cand of candidates) {
      if (path.isAbsolute(cand)) {
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(cand, { throwIfNoEntry: false });
        } catch {
          if (custom && !wrapper) return { available: false, path: cand, reason: "launch" };
          continue;
        }
        if (!stat) continue;
        if (stat.isDirectory()) {
          if (custom && !wrapper) return { available: false, path: cand, reason: "directory" };
          continue;
        }
      }

      const result = await this.checkExecutable(cand);
      if (result.available === true) return result;
      if (result.reason === "timeout") return result;
      if (result.reason !== "missing" && failure.reason === "missing") failure = result;
    }

    return failure;
  }

  private windowsCandidates(name: string, custom: string, wrapper: boolean): string[] {
    if (custom && !wrapper) return [custom];
    if (name !== "codex" || (custom && (!path.isAbsolute(custom) || !/^codex\.(?:cmd|ps1)$/i.test(path.basename(custom))))) {
      return custom ? [] : [`${name}.exe`];
    }

    const appData = process.env.APPDATA;
    const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    const prefixes = custom ? [path.dirname(custom)] : [
      ...pathValue.split(";").map((entry) => entry.trim().replace(/^"([^"]+)"$/, "$1")),
      ...(appData ? [path.join(appData, "npm")] : []),
    ];
    const arch = os.arch();
    const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const absolutePrefixes = [...new Set(prefixes.filter((entry) => path.isAbsolute(entry)))];
    const candidates: string[] = [];
    for (const prefix of absolutePrefixes) {
      const packages = path.join(prefix, "node_modules", "@openai");
      const platformPackage = `codex-win32-${arch}`;
      const roots = [
        path.join(packages, platformPackage),
        path.join(packages, "codex", "node_modules", "@openai", platformPackage),
        path.join(packages, "codex"),
      ];
      for (const root of roots) {
        candidates.push(path.join(root, "vendor", triple, "bin", "codex.exe"));
        candidates.push(path.join(root, "vendor", triple, "codex", "codex.exe"));
      }
    }
    if (!custom) candidates.push(...absolutePrefixes.map((prefix) => path.join(prefix, "codex.exe")));
    return candidates;
  }

  public describeCliFailure(result: Extract<CliDetection, { available: false }>): string {
    switch (result.reason) {
      case "wrapper": return "无法直接运行 Windows 命令脚本。请填写 CLI 原生 .exe 文件的绝对路径。";
      case "timeout": return "CLI 版本检查超时。请在系统终端运行 --version 检查。";
      case "directory": return "这里需要 CLI 可执行文件的绝对路径，不能填写安装目录。";
      case "dependency": return "已找到 CLI，但启动时缺少依赖。请先修复安装，并在终端运行 --version 确认。";
      case "launch": return "已找到 CLI，但无法启动。请在终端运行 --version 检查程序和 Node.js。";
      case "missing": return "找不到 CLI 可执行文件，请检查安装或填写程序的绝对路径。";
    }
  }

  public async checkLoginStatus(bin: string): Promise<CodexLoginStatus> {
    // 只通过 CLI 查询状态，不直接读取 Codex 的凭据文件。
    const result = await this.probeCli(bin, ["login", "status"], 4000);
    if (result === null) return "timeout";
    const out = `${result.stdout}\n${result.stderr}`.trim();
    if (/^\s*Not logged in\s*$/im.test(out)) return "signed-out";
    if (!result.error && /^\s*(?:Logged in\b|API key configured\b)/im.test(out)) return "ready";
    return "unavailable";
  }

  public async checkHarnessHeadless(bin: string): Promise<"ready" | "outdated" | "unavailable"> {
    const result = await this.probeCli(bin, ["--profile", "headless", "--help"], 8000);
    if (result === null || result.error) return "unavailable";
    return result.stdout.includes("--permission-mode") && result.stdout.includes("--approval-policy") ? "ready" : "outdated";
  }

  private async checkExecutable(bin: string): Promise<CliDetection> {
    const result = await this.probeCli(bin, ["--version"], 4000);
    if (result === null) return { available: false, path: bin, reason: "timeout" };
    const { error, stdout, stderr } = result;
    if (!error && stdout.trim()) return { available: true, path: bin, version: stdout.trim() };
    return {
      available: false,
      path: bin,
      reason: error?.code === "ENOENT" ? "missing" :
        /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module/.test(stderr) ? "dependency" : "launch",
    };
  }

  private probeCli(bin: string, args: string[], timeoutMs: number):
    Promise<{ error: ExecFileException | null; stdout: string; stderr: string } | null> {
    return new Promise((resolve) => {
      const child = execFile(bin, args, { env: this.getEnhancedEnv(), windowsHide: true }, (error, stdout, stderr) => {
        clearProbeTimeout(timer);
        resolve({ error, stdout, stderr });
      });
      // CLI probes must finish independently of the renderer window and the child's pipes.
      const timer = setProbeTimeout(() => {
        resolve(null);
        child.stdout?.destroy();
        child.stderr?.destroy();
        try { child.kill(); } catch { /* The check has already timed out. */ }
      }, timeoutMs);
      child.stdin?.on("error", () => { /* A fast exit can close the pipe first. */ });
      child.stdin?.end();
    });
  }

  public async rewrite(options: CodexRewriteOptions): Promise<string[]> {
    const settings = { ...this.settings };
    const label = this.describeModel();
    const detect = await this.detectCli(settings);
    const { originalText, instruction, styleContext } = options;

    const prompt = this.buildPrompt(originalText, instruction, styleContext);

    if (detect.available === false) throw new Error(`${label}：${this.describeCliFailure(detect)}`);
    return this.callCli(detect.path, prompt, settings);
  }

  private buildPrompt(originalText: string, instruction: string, styleContext?: string): string {
    return `你是一位顶级中文文案重构专家。
写作原则：第一人称、真诚克制、绝不端着。用行动、细节和真切判断支撑，拒绝模板化AI套话、空洞排比与营销口号。

【原始句子】：
"${originalText}"

【改写指令】：
${instruction}

${styleContext ? `【参考标杆风味】：\n${styleContext}` : ""}

请提供 3 个不同语气的优质改写版本（按清晰度、口语化和痛点递进），版本之间用 "===OPTION===" 分隔。
直接输出改写后的成稿句子，严禁输出任何多余的序号、标签（如不要带“建议版本”字样）或解释。`;
  }

  private callCli(binPath: string, prompt: string, settings: RewriteCliSettings): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-lens-"));
      const tmpOut = path.join(tmpDir, "output.txt");
      const maxOutputBytes = 4 * 1024 * 1024;
      let stdout = "";
      let finished = false;
      const deepseek = settings.rewriteBackend === "deepseek";
      const label = deepseek ? "DeepSeek Harness" : "Codex CLI";

      const cleanup = () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Cleanup is best effort; the operating system will eventually remove temporary files.
        }
      };

      const finishWithError = (message: string) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(message));
      };

      let child: ChildProcessByStdio<Writable, Readable, null>;
      try {
        const args = deepseek
          ? this.deepseekArguments(tmpDir, settings)
          : ["exec", "--skip-git-repo-check", "--sandbox", "read-only",
            ...(settings.codexModel.trim() ? ["--model", settings.codexModel.trim()] : []),
            "-o", tmpOut, "-"];
        child = spawn(binPath, args, {
          ...(deepseek ? { cwd: tmpDir } : {}),
          env: this.getEnhancedEnv(),
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        finishWithError(`无法准备 ${label} 改写。`);
        return;
      }

      const timeout = window.setTimeout(() => {
        child.kill();
        finishWithError(`${label} 执行超时。`);
      }, deepseek ? 90000 : 30000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < maxOutputBytes) stdout += chunk;
      });
      child.stdin.on("error", () => { /* The close handler reports an early exit. */ });
      child.on("error", () => {
        window.clearTimeout(timeout);
        finishWithError(`无法启动 ${label}。`);
      });
      child.on("close", (code) => {
        window.clearTimeout(timeout);
        if (finished) return;

        if (code !== 0) {
          finishWithError(`${label} 改写失败，请检查终端中的认证、模型和服务配置。`);
          return;
        }
        let raw = deepseek ? stdout.trim() : "";
        try {
          if (!deepseek && fs.existsSync(tmpOut)) raw = fs.readFileSync(tmpOut, "utf-8").trim();
        } catch {
          // A missing or unreadable output file is handled as an empty CLI response below.
        }

        if (!deepseek && !raw && stdout) {
          const match = stdout.match(/codex\s*\n([\s\S]+?)(?=\ntokens used|$)/i);
          if (match && match[1]) raw = match[1].trim();
        }

        if (!raw) {
          finishWithError(`${label} 返回空结果。`);
          return;
        }

        finished = true;
        cleanup();
        const parts = raw
          .split("===OPTION===")
          .map((p) => this.cleanOutput(p))
          .filter((p) => p.length > 0);
        resolve(parts.length > 0 ? parts : [this.cleanOutput(raw)]);
      });

      // 提示词仅经由子进程标准输入传递，不写入磁盘。
      child.stdin.end(prompt, "utf-8");
    });
  }

  private deepseekArguments(tmpDir: string, settings: RewriteCliSettings): string[] {
    const patch = path.join(tmpDir, "refactor-lens.patch.yml");
    const model = settings.deepseekModel.trim();
    // JSON is valid YAML. The overlay contains no prompt or credentials.
    fs.writeFileSync(patch, JSON.stringify([
      { id: "session-log-deepseek", disabled: true },
      ...(model ? [{
        id: "agent-default-model",
        config: { provider: settings.deepseekProvider.trim() || "deepseek-official", model },
      }] : []),
    ]), { mode: 0o600 });
    return ["--profile", "headless", "--patch", patch, "--permission-mode", "read-only", "--approval-policy", "never", "-"];
  }

  /**
   * 彻底剥离任何“【建议版本 1】”等前缀污染，保证纯净成稿
   */
  public cleanOutput(text: string): string {
    let s = text.trim();
    // 1. 括号包裹型：如 【建议版本 1】、【建议 1】、[Option 1]、(建议版本 1)
    s = s.replace(/^(?:【|\[|\(|（)\s*(?:建议|改写)?\s*(?:版本|选项|候选|Option)?\s*[一二三四五六七八九十0-9]*\s*(?:】|\]|\)|）)?[:：\s]*/gi, "");
    // 2. 无括号但带关键词型：如 建议版本1：、版本一：、改写方案 1：
    s = s.replace(/^(?:建议|改写)?\s*(?:版本|选项|候选|方案)\s*[一二三四五六七八九十0-9]*[:：\s]*/gi, "");
    // 3. 数字序号型：如 1. 、1、 、(1) 、①
    s = s.replace(/^(?:[0-9]+[.、:：\s]+|[①②③④⑤⑥⑦⑧⑨⑩]|\([0-9]+\)\s*)/g, "");
    return s.trim();
  }
}

export interface RewriteCliSettings {
  rewriteBackend: "codex" | "deepseek";
  codexCliPath: string;
  codexModel: string;
  deepseekCliPath: string;
  deepseekProvider: string;
  deepseekModel: string;
}
