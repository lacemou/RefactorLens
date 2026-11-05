import { execFile, spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface CodexRewriteOptions {
  originalText: string;
  instruction: string;
  styleContext?: string;
}

export class CodexCliEngine {
  private customBinaryPath: string = "";

  constructor(customBinaryPath: string = "") {
    this.customBinaryPath = customBinaryPath;
  }

  public setCustomBinaryPath(p: string) {
    this.customBinaryPath = p;
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

  public async detectCodexPath(): Promise<{ available: boolean; path: string; version?: string }> {
    const isWin = os.platform() === "win32";
    const home = os.homedir();

    const candidates = [
      this.customBinaryPath,
      path.join(home, "Library/pnpm/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(home, ".local/bin/codex"),
      isWin ? "codex.cmd" : "codex",
    ].filter(Boolean);

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
    const detect = await this.detectCodexPath();
    const { originalText, instruction, styleContext } = options;

    const prompt = this.buildPrompt(originalText, instruction, styleContext);

    if (detect.available) {
      try {
        const cliResult = await this.callCodexCli(detect.path, prompt);
        if (cliResult && cliResult.length > 0) {
          return cliResult.map((text) => this.cleanOutput(text));
        }
      } catch (e) {
        console.warn("Codex CLI 执行异常，自动启用内置启发式备选引擎:", e);
      }
    }

    const fallbacks = this.fallbackHeuristicRewrite(originalText, instruction);
    return fallbacks.map((text) => this.cleanOutput(text));
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

  private callCodexCli(binPath: string, prompt: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-lens-"));
      const tmpOut = path.join(tmpDir, "output.txt");
      const maxOutputBytes = 4 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let finished = false;

      const cleanup = () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      };

      const finishWithError = (message: string) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(message));
      };

      const child = spawn(binPath, ["exec", "--skip-git-repo-check", "-o", tmpOut, "-"], {
        env: this.getEnhancedEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        child.kill();
        finishWithError("Codex 执行超时");
      }, 30000);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutputBytes) stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutputBytes) stderr += chunk.toString("utf-8");
      });
      child.on("error", () => {
        clearTimeout(timeout);
        finishWithError("无法启动 Codex CLI");
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (finished) return;

        let raw = "";
        try {
          if (fs.existsSync(tmpOut)) raw = fs.readFileSync(tmpOut, "utf-8").trim();
        } catch (_) {}

        if (!raw && stdout) {
          const match = stdout.match(/codex\s*\n([\s\S]+?)(?=\ntokens used|$)/i);
          if (match && match[1]) raw = match[1].trim();
        }

        if (code !== 0 && !raw) {
          finishWithError("Codex CLI 执行失败");
          return;
        }
        if (!raw) {
          finishWithError("Codex 返回空结果");
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

  /**
   * 彻底剥离任何“【建议版本 1】”等前缀污染，保证纯净成稿
   */
  public cleanOutput(text: string): string {
    let s = text.trim();
    // 1. 括号包裹型：如 【建议版本 1】、【建议 1】、[Option 1]、(建议版本 1)
    s = s.replace(/^[【\[(（]\s*(?:建议|改写)?\s*(?:版本|选项|候选|Option)?\s*[一二三四五六七八九十0-9]*\s*[】\])）]?[:：\s]*/gi, "");
    // 2. 无括号但带关键词型：如 建议版本1：、版本一：、改写方案 1：
    s = s.replace(/^(?:建议|改写)?\s*(?:版本|选项|候选|方案)\s*[一二三四五六七八九十0-9]*[:：\s]*/gi, "");
    // 3. 数字序号型：如 1. 、1、 、(1) 、①
    s = s.replace(/^(?:[0-9]+[\.、:：\s]+|[①②③④⑤⑥⑦⑧⑨⑩]|\([0-9]+\)\s*)/g, "");
    return s.trim();
  }

  private fallbackHeuristicRewrite(text: string, instruction: string): string[] {
    const clean = text.trim();

    if (instruction.includes("去AI味")) {
      return [
        clean
          .replace(/总的来说|综上所述|不难看出|显而易见/g, "")
          .replace(/为我们提供了|为创作者带来了|有力地证明了/g, "说明了")
          .replace(/不仅.*?而且.*?/g, "")
          .trim() || clean,
        `老实说，${clean.replace(/我们可以发现|值得注意的是/g, "").trim()}`,
        `说白了，${clean}`,
      ];
    } else if (instruction.includes("口语化")) {
      return [
        `聊到这儿，我想说句大白话：${clean}`,
        clean.replace(/，/g, "。").replace(/从而/g, "这样就").replace(/进而/g, "接着"),
        `其实很简单，${clean}`,
      ];
    } else if (instruction.includes("痛点") || instruction.includes("现实")) {
      return [
        `现实是残酷的：${clean}`,
        `很多人卡在这一步不是因为不努力，而是：${clean}`,
        `普通上班族最真切的困境莫过于：${clean}`,
      ];
    } else if (instruction.includes("精炼")) {
      return [
        clean.replace(/的|地|得/g, "").replace(/非常|十分|极其|特别/g, ""),
        clean.split("，")[0] + "。",
        clean,
      ];
    }

    return [
      clean,
      `说实话，${clean}`,
      `从实际落地来看：${clean}`,
    ];
  }
}
