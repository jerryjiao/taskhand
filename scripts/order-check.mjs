#!/usr/bin/env node
// Work-order health check: counts the fixed sections, bounces missing or oversized
// orders (dispatch runs it before sending; format documented in README).
//
//   node order-check.mjs <order-file>

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SECTIONS = ["Goal", "Files", "Requirements", "Off-limits", "Acceptance", "Report"];
// Calibrated by feel on day one; recalibrate against rework data once it accumulates
export const MAX_REQUIREMENTS = 3;
export const MAX_FILES = 4;
export const MIN_CHECKS = 1;

// Sequential-step phrases: any of these in Goal/Requirements means the order really wants to be two
const STEP_PATTERNS = [
  [/\bfirst\b[^.;\n]*\bthen\b/i, "first…then"],
  [/\bthen\b/i, "then"],
  [/\bfinally\b/i, "finally"],
  [/\bstep\s*\d+/i, "step N"],
];

// Only top-level headings count; `#` lines inside code fences don't (Report examples often have them)
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

  const requirements = countItems(lines("Requirements"));
  const files = countItems(lines("Files"));
  const checks = (lines("Acceptance").join("\n").match(/check:"[^"]*"/g) ?? []).length;
  // Text inside code spans, parentheses, or double quotes merely *mentions* these words
  // (this module's own orders do) — not real steps
  const stepText = [...lines("Goal"), ...lines("Requirements")]
    .join("\n")
    .replace(/`[^`]*`/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/"[^"]*"/g, "");
  // "first…then" spans swallow their "then" — blank them first so the standalone rule doesn't double-count
  const firstThen = /\bfirst\b[^.;\n]*\bthen\b/gi;
  const spans = [...stepText.matchAll(firstThen)];
  const residual = spans.length ? stepText.replace(firstThen, " ") : stepText;
  const steps = [...spans.map(() => "first…then")];
  for (const [re, word] of STEP_PATTERNS.slice(1)) {
    if (new RegExp(re.source, re.flags).test(residual)) steps.push(word);
  }

  const problems = [];
  for (const name of SECTIONS) {
    if (!sections.has(name)) problems.push(`missing section "${name}"`);
  }
  if (requirements > MAX_REQUIREMENTS)
    problems.push(`Requirements has ${requirements} items, over the limit of ${MAX_REQUIREMENTS} — split the order`);
  if (files > MAX_FILES) problems.push(`Files has ${files} entries, over the limit of ${MAX_FILES} — split the order`);
  if (checks < MIN_CHECKS) problems.push(`Acceptance has no check:"…" item`);
  if (steps.length) problems.push(`Goal/Requirements contain sequential-step words: ${steps.join(", ")} — split the order`);

  return { ok: problems.length === 0, problems, stats: { requirements, files, checks, steps } };
}

// CLI entry only runs when executed directly: argv[1] may be a symlink, compare after realpath (same as taskhand.mjs).
try {
  if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
    const file = process.argv[2];
    if (!file) {
      process.stderr.write("usage: node order-check.mjs <order-file>\n");
      process.exitCode = 1;
    } else {
      const result = checkOrder(readFileSync(file, "utf8"));
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.ok ? 0 : 1;
    }
  }
} catch { /* argv[1] missing etc.: don't run the CLI */ }
