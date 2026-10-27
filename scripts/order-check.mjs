#!/usr/bin/env node
// 派活单体检：按固定段落数一数，缺段或太肥就拦（dispatch 发单前用；格式见 README）。
//
//   node order-check.mjs <派活单路径>

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SECTIONS = ["目标", "相关文件", "要求", "禁区", "验收", "交回"];
// 2026-10-25 估值，等按单打回数据校准
export const MAX_REQUIREMENTS = 3;
export const MAX_FILES = 4;
export const MIN_CHECKS = 1;

// 连续步骤字眼：要求里出现就说明这一单其实该拆成多单
const STEP_PATTERNS = [
  [/先[^\n。；]*再/, "先…再"],
  [/然后/, "然后"],
  [/最后/, "最后"],
  [/第一步/, "第一步"],
  [/步骤\s*\d+/, "步骤+数字"],
];

// 只认一级标题；代码块里的 # 行不算标题（交回里的示例常带）
function splitSections(text) {
  const sections = new Map();
  let cur = null;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = line.match(/^#(?!#)\s*(.+)$/);
      if (m) {
        cur = { title: m[1].trim(), lines: [] };
        sections.set(cur.title, cur);
        continue;
      }
    }
    cur?.lines.push(line);
  }
  return sections;
}

const countItems = (lines) => lines.filter((l) => /^(?:- |\d+\.\s)/.test(l)).length;

export function checkOrder(text) {
  const sections = splitSections(text);
  const lines = (name) => sections.get(name)?.lines ?? [];

  const requirements = countItems(lines("要求"));
  const files = countItems(lines("相关文件"));
  const checks = (lines("验收").join("\n").match(/check:"[^"]*"/g) ?? []).length;
  // 括号、引号、行内代码里是在「提到」这些词（本模块自己的派活单就是），不算真步骤
  const stepText = [...lines("目标"), ...lines("要求")]
    .join("\n")
    .replace(/`[^`]*`/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/「[^」]*」/g, "");
  const steps = STEP_PATTERNS.filter(([re]) => re.test(stepText)).map(([, word]) => word);

  const problems = [];
  for (const name of SECTIONS) {
    if (!sections.has(name)) problems.push(`缺「${name}」段`);
  }
  if (requirements > MAX_REQUIREMENTS)
    problems.push(`「要求」段有 ${requirements} 条，超过上限 ${MAX_REQUIREMENTS} 条，拆单`);
  if (files > MAX_FILES) problems.push(`「相关文件」有 ${files} 个，超过上限 ${MAX_FILES} 个，拆单`);
  if (checks < MIN_CHECKS) problems.push(`「验收」段没有 check:"…" 项`);
  if (steps.length) problems.push(`「目标/要求」出现连续步骤字眼：${steps.join("、")}，拆单`);

  return { ok: problems.length === 0, problems, stats: { requirements, files, checks, steps } };
}

// CLI 入口只在直接运行时执行：argv[1] 可能是软链，realpath 后再比（同 taskhand.mjs 末尾）。
try {
  if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
    const file = process.argv[2];
    if (!file) {
      process.stderr.write("用法：node order-check.mjs <派活单路径>\n");
      process.exitCode = 1;
    } else {
      const result = checkOrder(readFileSync(file, "utf8"));
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.ok ? 0 : 1;
    }
  }
} catch { /* argv[1] 不存在等情况：不运行 CLI */ }
