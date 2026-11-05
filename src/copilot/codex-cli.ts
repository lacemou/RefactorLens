import { execFile, spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

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

  public async detectCli(settings = this.settings): Promise<{ available: boolean; path: string; version?: string }> {
    const isWin = os.platform() === "win32";
    const home = os.homedir();

    const deepseek = settings.rewriteBackend === "deepseek";
    const name = deepseek ? "dsh" : "codex";
    const custom = (deepseek ? settings.deepseekCliPath : settings.codexCliPath).trim();
    const candidates = custom ? [custom] : [
      path.join(home, "Library/pnpm/bin", name),
      path.join(home, ".npm-global/bin", name),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      path.join(home, ".local/bin", name),
      isWin ? `${name}.exe` : name,
    ];

    for (const cand of candidates) {
      if (cand && (cand.includes("/") || cand.includes("\\"))) {
        if (!fs.existsSync(cand)) continue;
      }

      const ver = await this.checkExecutable(cand);
      if (ver) {
        return { available: true, path: cand, version: ver };
      }
    }

    return { available: false, path: "" };
  }

  public async checkLoginStatus(bin: string): Promise<string> {
    // 只通过 CLI 查询状态，不直接读取 Codex 的凭据文件。
    return new Promise((resolve) => {
      execFile(
        bin,
        ["login", "status"],
        { timeout: 4000, env: this.getEnhancedEnv(), windowsHide: true },
        (_error, stdout, stderr) => {
          const out = ((stdout || "") + "\n" + (stderr || "")).trim();
          if (out.includes("Logged in using ChatGPT")) {
            resolve("Logged in using ChatGPT");
          } else if (out.includes("Logged in")) {
            resolve(out);
          } else if (out) {
            resolve(out);
          } else {
            resolve("未检测到登录状态");
          }
        }
      );
    });
  }

  private checkExecutable(bin: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        bin,
        ["--version"],
        { timeout: 4000, env: this.getEnhancedEnv(), windowsHide: true },
        (error, stdout) => {
          if (!error && stdout) {
            resolve(stdout.trim());
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  public async rewrite(options: CodexRewriteOptions): Promise<string[]> {
    const settings = { ...this.settings };
    const label = this.describeModel();
    const detect = await this.detectCli(settings);
    const { originalText, instruction, styleContext } = options;

    const prompt = this.buildPrompt(originalText, instruction, styleContext);

    if (!detect.available) throw new Error(`无法启动 ${label}，请检查安装和程序路径。`);
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
