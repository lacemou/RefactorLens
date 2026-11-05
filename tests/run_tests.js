const DiffMatchPatch = require("diff-match-patch");
const fs = require("fs");
const path = require("path");

class CopywritingComparator {
  constructor() {
    this.dmp = new DiffMatchPatch();
    this.dmp.Diff_EditCost = 4;
  }

  compare(baselineText, currentText) {
    const rawDiffs = this.dmp.diff_main(baselineText, currentText);
    this.dmp.diff_cleanupSemantic(rawDiffs);

    const segments = [];
    let currentOffset = 0;
    let addedCount = 0;
    let deletedCount = 0;
    let unchangedCount = 0;

    for (const [op, text] of rawDiffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        const from = currentOffset;
        currentOffset += text.length;
        segments.push({ type: "equal", text, from, to: currentOffset });
        unchangedCount += text.length;
      } else if (op === DiffMatchPatch.DIFF_INSERT) {
        const from = currentOffset;
        currentOffset += text.length;
        segments.push({ type: "insert", text, from, to: currentOffset });
        addedCount += text.length;
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        segments.push({ type: "delete", text, from: currentOffset, to: currentOffset });
        deletedCount += text.length;
      }
    }

    const totalChanges = addedCount + deletedCount;
    const baseLength = baselineText.length || 1;
    const refactorRatio = Math.min(100, Math.round((totalChanges / (baseLength + addedCount)) * 100));

    return { segments, addedCount, deletedCount, unchangedCount, refactorRatio };
  }
}

class MovedBlockDetector {
  cleanText(str) {
    return str.replace(/[#*`>\-_0-9\.\s，。、“”《》！？：；（）()\[\]【】\/\\]/g, "");
  }

  stringSimilarity(s1, s2) {
    const str1 = this.cleanText(s1);
    const str2 = this.cleanText(s2);
    if (str1 === str2) return 1.0;
    if (str1.length < 2 || str2.length < 2) return 0.0;

    const bigrams1 = new Map();
    for (let i = 0; i < str1.length - 1; i++) {
      const bg = str1.substring(i, i + 2);
      bigrams1.set(bg, (bigrams1.get(bg) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < str2.length - 1; i++) {
      const bg = str2.substring(i, i + 2);
      const count = bigrams1.get(bg) || 0;
      if (count > 0) {
        bigrams1.set(bg, count - 1);
        intersection++;
      }
    }

    return (2.0 * intersection) / (str1.length - 1 + str2.length - 1);
  }

  splitParagraphs(text) {
    const blocks = [];
    const lines = text.split("\n");
    let offset = 0;
    let buf = "";
    let start = 0;

    lines.forEach((line) => {
      if (line.trim() === "") {
        if (buf.trim().length > 0) {
          blocks.push({
            text: buf,
            from: start,
            to: start + buf.length,
            cleanLen: this.cleanText(buf).length,
          });
        }
        buf = "";
        offset += line.length + 1;
        start = offset;
      } else {
        if (buf.length === 0) start = offset;
        buf += (buf.length > 0 ? "\n" : "") + line;
        offset += line.length + 1;
      }
    });

    if (buf.trim().length > 0) {
      blocks.push({
        text: buf,
        from: start,
        to: start + buf.length,
        cleanLen: this.cleanText(buf).length,
      });
    }

    return blocks;
  }

  detect(baselineText, currentText) {
    const baseBlocks = this.splitParagraphs(baselineText);
    const currBlocks = this.splitParagraphs(currentText);
    const movedPairs = [];
    const matchedBaseIndices = new Set();

    currBlocks.forEach((cBlock, cIdx) => {
      if (cBlock.cleanLen < 15) return;

      let bestBaseIdx = -1;
      let maxSim = 0;

      baseBlocks.forEach((bBlock, bIdx) => {
        if (matchedBaseIndices.has(bIdx)) return;
        if (bBlock.cleanLen < 15) return;

        const sim = this.stringSimilarity(cBlock.text, bBlock.text);
        if (sim > maxSim) {
          maxSim = sim;
          bestBaseIdx = bIdx;
        }
      });

      if (maxSim >= 0.65 && bestBaseIdx !== -1) {
        const baseRatio = bestBaseIdx / (baseBlocks.length || 1);
        const currRatio = cIdx / (currBlocks.length || 1);
        const diffIdx = cIdx - bestBaseIdx;

        const isMoved = Math.abs(diffIdx) >= 2 || Math.abs(baseRatio - currRatio) >= 0.12;

        if (isMoved) {
          matchedBaseIndices.add(bestBaseIdx);
          const baseBlock = baseBlocks[bestBaseIdx];

          const snippet = baseBlock.text
            .replace(/[#*`>\-_]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);

          movedPairs.push({
            id: `moved-${bestBaseIdx}-${cIdx}`,
            targetFrom: cBlock.from,
            targetTo: cBlock.to,
            targetSectionIndex: cIdx + 1,
            originalSectionIndex: bestBaseIdx + 1,
            originalText: baseBlock.text.trim(),
            cleanSnippet: snippet + (baseBlock.text.length > 40 ? "..." : ""),
            similarity: maxSim,
            direction: diffIdx > 0 ? "down" : "up",
            originAnchorPos: Math.min(currentText.length, Math.max(0, cBlock.from)),
          });
        }
      }
    });

    return movedPairs;
  }
}

// 模拟新版 Scratchpad 引擎
class ScratchpadParser {
  serialize(item) {
    return `### [${item.id}] ${item.dateStr} · 来自: ${item.sourceFile}\n\n${item.content}\n\n<!-- end-item -->`;
  }

  parse(text) {
    const items = [];
    const regex = /^###\s*\[(sp-[^\]]+)\]\s*(.*?)\s*·\s*来自:\s*(.*?)$/gm;
    let match;
    const matches = [];

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
        dateStr: cur.dateStr,
        sourceFile: cur.sourceFile,
        content: rawBody,
      });
    }

    return items;
  }
}

// ================= 测试执行器 =================
const comparator = new CopywritingComparator();
const movedDetector = new MovedBlockDetector();
const scratchpadParser = new ScratchpadParser();
const results = [];

function assert(name, condition, details = "") {
  results.push({ name, passed: Boolean(condition), details });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"}: ${name} ${details ? `(${details})` : ""}`);
}

console.log("=== 开始 RefactorLens 全栈强化测试 ===\n");

// Test 1: 自包含长文样例的段落搬家稳定命中
{
  const base = `开场段落介绍作者正在解决的真实问题，也说明这次修改希望得到什么结果。

第二段解释读者为什么会遇到这个问题，并提供足够具体的日常场景作为背景。

第三段给出核心判断，同时说明这个判断成立需要满足哪些边界条件。

第四段补充一个可验证的案例，让前面的判断不只停留在抽象观点层面。

结尾段落回到读者可以立即采取的下一步行动，并保持语气克制清楚。`;
  const curr = `开场段落介绍作者正在解决的真实问题，也说明这次修改希望得到什么结果。

第四段补充一个可以复核的案例，让核心判断不只停留在抽象观点层面。

第二段解释读者为什么会遇到这个问题，并提供足够具体的日常场景作为背景。

第三段给出核心判断，同时说明这个判断成立需要满足哪些边界条件。

结尾段落回到读者可以立即采取的下一步行动，并保持语气克制清楚。`;

  const moved = movedDetector.detect(base, curr);
  assert("自包含长文样例成功命中段落搬家", moved.length >= 1, `捕获搬迁段落数: ${moved.length}`);
}

// Test 2: 现场 Backspace 删除留痕
{
  const snapshotText = "这是进入透镜模式时的现状。无论是黑字还是刚才比出来的绿字。";
  const liveText = "这是进入透镜模式时的现状。";
  const liveDiff = comparator.compare(snapshotText, liveText);
  const liveDeletes = liveDiff.segments.filter(s => s.type === "delete");
  assert("现场 Backspace 删除留痕成功捕获", liveDeletes.length === 1 && liveDeletes[0].text.includes("无论是黑字还是刚才比出来"));
}

// Test 3: 灵感抽屉独立删除测试 (彻底杜绝上下级联 Bug)
{
  const itemA = { id: "sp-1001-a", dateStr: "11/05 13:00", sourceFile: "doc1.md", content: "第一段内容，包含破折号 ---\n还有换行" };
  const itemB = { id: "sp-1002-b", dateStr: "11/05 13:01", sourceFile: "doc2.md", content: "第二段内容，带列表：\n- a\n- b\n--- 甚至带分割线" };
  const itemC = { id: "sp-1003-c", dateStr: "11/05 13:02", sourceFile: "doc3.md", content: "第三段普通内容" };

  const fullDoc = [itemA, itemB, itemC].map(it => scratchpadParser.serialize(it)).join("\n\n");
  const parsed = scratchpadParser.parse(fullDoc);
  assert("灵感抽屉包含3个复杂条目时解析数量无误", parsed.length === 3);

  // 删除中间的 itemB
  const remaining = parsed.filter(it => it.id !== itemB.id);
  const newDoc = remaining.map(it => scratchpadParser.serialize(it)).join("\n\n");
  const newParsed = scratchpadParser.parse(newDoc);

  assert("删除中间条目后，上下条目完好无损且各自可被继续独立删除", newParsed.length === 2 && newParsed[0].id === itemA.id && newParsed[1].id === itemC.id);
}

// Test 4: 删除痕迹保持行内连续，并提供直接恢复而非卡片多选
{
  const cssPath = path.join(__dirname, "../styles.css");
  const css = fs.readFileSync(cssPath, "utf-8");
  const decorationSource = fs.readFileSync(path.join(__dirname, "../src/ui/cm-decorations.ts"), "utf-8");

  assert("红色删除文字支持用户划选 (cursor: text)", css.includes("cursor: text !important"));
  assert("样式表中不包含 border-left: 竖线", !css.includes("border-left:"));
  assert(
    "删除痕迹不再使用块级卡片、复选框或批量暂存",
    !css.includes(".refactor-deleted-block-card") &&
      !css.includes(".refactor-para-checkbox") &&
      !decorationSource.includes("DeletedBlockCardWidget")
  );
  assert(
    "删除痕迹提供轻量行内恢复操作",
    css.includes(".refactor-deleted-inline-actions") &&
      decorationSource.includes("refactor-deleted-restore-btn") &&
      decorationSource.includes("changes: { from: insertPosition, insert: this.deletedText }")
  );
  const floatingSource = fs.readFileSync(path.join(__dirname, "../src/ui/floating-copilot.ts"), "utf-8");
  assert(
    "弹窗打开时由状态管理器移除选区气泡，且不使用高开销 :has 选择器",
    css.includes(".refactor-is-hidden") &&
      !css.includes(":has(") &&
      floatingSource.includes("if (active) {") &&
      floatingSource.includes("this.hideSelectionPopover();")
  );
}

// Test 5: 只有达到完整句子门槛的删除内容才进入灵感抽屉
{
  function isScratchpadCandidate(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const meaningfulText = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
    if (meaningfulText.length < 5) return false;
    const endsLikeSentence = /[。！？!?；;…](?:["'”’）)\]}】》]*)$/u.test(trimmed);
    return endsLikeSentence || meaningfulText.length >= 12;
  }

  assert("删除 1～4 个字不出现灵感暂存入口", !isScratchpadCandidate("删掉四字"));
  assert("有完整句意与句末标点的删除内容可以暂存", isScratchpadCandidate("这句话值得留下。"));
  assert("足够长但没有句末标点的独立表达可以暂存", isScratchpadCandidate("这是一段足够完整并且可以复用的表达"));
  assert("不足一句的短语不进入灵感抽屉", !isScratchpadCandidate("短小片段"));
}

// Test 6: Codex 输出前缀清洗与纯度测试
{
  function cleanOutput(text) {
    let s = text.trim();
    s = s.replace(/^[【\[(（]\s*(?:建议|改写)?\s*(?:版本|选项|候选|Option)?\s*[一二三四五六七八九十0-9]*\s*[】\])）]?[:：\s]*/gi, "");
    s = s.replace(/^(?:建议|改写)?\s*(?:版本|选项|候选|方案)\s*[一二三四五六七八九十0-9]*[:：\s]*/gi, "");
    s = s.replace(/^(?:[0-9]+[\.、:：\s]+|[①②③④⑤⑥⑦⑧⑨⑩]|\([0-9]+\)\s*)/g, "");
    return s.trim();
  }

  const dirty1 = "【建议版本 1】：现实是残酷的，很多人做内容并不是不努力。";
  const dirty2 = "建议版本2：普通上班族最真切的困境在于没有时间。";
  const dirty3 = "1. 这是一句经过数字编号的句子。";

  assert("建议版本1前缀被彻底剥离", cleanOutput(dirty1) === "现实是残酷的，很多人做内容并不是不努力。");
  assert("建议版本2前缀被彻底剥离", cleanOutput(dirty2) === "普通上班族最真切的困境在于没有时间。");
  assert("数字序号前缀被彻底剥离", cleanOutput(dirty3) === "这是一句经过数字编号的句子。");
}

// Test 7: 仅采纳半句智能融合拼接测试
{
  function computeHalfSentenceMerge(origText, candText, selectedPart) {
    const orig = origText.trim();
    const cand = candText.trim();
    const sel = selectedPart.trim();

    if (!sel || sel === cand) return cand;

    const startIdx = cand.indexOf(sel);
    if (startIdx === -1) return cand;
    const endIdx = startIdx + sel.length;

    const isPrefix = startIdx <= 2;
    const isSuffix = endIdx >= cand.length - 2;

    const beforeInCand = cand.substring(0, startIdx).trim();
    const punctRegex = /[，,：:；;！!？?]/g;

    if (isSuffix && !isPrefix) {
      const leadPunctMatch = beforeInCand.match(/([，,：:；;])[^，,：:；;]*$/);
      const leadPunct = leadPunctMatch ? leadPunctMatch[1] : null;

      let splitPos = -1;
      if (leadPunct) {
        splitPos = orig.lastIndexOf(leadPunct);
      }
      if (splitPos === -1) {
        const matches = [...orig.matchAll(punctRegex)];
        if (matches.length > 0) {
          splitPos = matches[matches.length - 1].index;
        }
      }

      if (splitPos !== -1) {
        const origPrefix = orig.substring(0, splitPos + 1);
        const cleanSel = sel.replace(/^[，,：:；;\s]+/, "");
        return origPrefix + cleanSel;
      }
    } else if (isPrefix && !isSuffix) {
      const endPunctMatch = cand.substring(startIdx).match(/^[^，,：:；;]*([，,：:；;])/);
      const endPunct = endPunctMatch ? endPunctMatch[1] : null;

      let splitPos = -1;
      if (endPunct) {
        splitPos = orig.indexOf(endPunct);
      }
      if (splitPos === -1) {
        const matches = [...orig.matchAll(punctRegex)];
        if (matches.length > 0) {
          splitPos = matches[0].index;
        }
      }

      if (splitPos !== -1) {
        const origSuffix = orig.substring(splitPos);
        const cleanSel = sel.replace(/[，,：:；;\s]+$/, "");
        return cleanSel + origSuffix;
      }
    }

    const startRatio = startIdx / cand.length;
    const endRatio = endIdx / cand.length;
    const origCutStart = Math.round(orig.length * startRatio);
    const origCutEnd = Math.round(orig.length * endRatio);

    return orig.substring(0, origCutStart) + sel + orig.substring(origCutEnd);
  }

  // 1. 后半句出彩拼接
  const orig1 = "这时候，还要多看评论区里读者的真实留言：大家是在问提示词怎么写，还是在问本地环境配置怎么操作？";
  const cand1 = "老实说，多翻翻评论区读者的吐槽：大家纠结的到底是提示词，还是死磕本地环境配置？";
  const sel1 = "大家纠结的到底是提示词，还是死磕本地环境配置？";
  const res1 = computeHalfSentenceMerge(orig1, cand1, sel1);
  assert("仅采纳后半句：保留原句前半句，出彩后半句精准拼入", res1 === "这时候，还要多看评论区里读者的真实留言：大家纠结的到底是提示词，还是死磕本地环境配置？");

  // 2. 前半句出彩拼接
  const orig2 = "很多时候我们觉得只要工具够多，效率就会成倍提升。";
  const cand2 = "说白了工具多不等于能打，关键看判断力。";
  const sel2 = "说白了工具多不等于能打";
  const res2 = computeHalfSentenceMerge(orig2, cand2, sel2);
  assert("仅采纳前半句：出彩前半句替换原句开头，原句后半句完好保留", res2 === "说白了工具多不等于能打，效率就会成倍提升。");

  // 3. 样式表包含半句卡片与文字可选中保护
  const cssPath = path.join(__dirname, "../styles.css");
  const css = fs.readFileSync(cssPath, "utf-8");
  assert("样式表包含半句融合预览卡片样式", css.includes(".refactor-partial-preview-card") && css.includes(".refactor-btn-partial-confirm"));
  assert("绿色改写句支持鼠标划选 (user-select: text)", css.includes(".refactor-preview-new") && css.includes("user-select: text !important"));
  assert("支持快捷分句胶囊栏样式", css.includes(".refactor-clause-chips-bar") && css.includes(".refactor-clause-chip"));
}

// Test 7: 发布前隐私保护约束
{
  const codexSource = fs.readFileSync(path.join(__dirname, "../src/copilot/codex-cli.ts"), "utf-8");
  assert("插件不直接读取 Codex 凭据文件", !codexSource.includes("auth.json"));
  assert("用户改写提示词不写入临时明文文件", !codexSource.includes("tmpPrompt") && !codexSource.includes("writeFileSync"));
}

console.log("\n=== 测试汇总 ===");
const passedCount = results.filter(r => r.passed).length;
console.log(`全部测试: ${results.length} | 通过: ${passedCount} | 失败: ${results.length - passedCount}`);
if (passedCount === results.length) {
  console.log("🎉 全部测试 100% 通过！");
} else {
  process.exit(1);
}
