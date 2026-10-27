// order-check.mjs 的测试：一张合格单当基线，各条改一处验一个问题。
import test from "node:test";
import assert from "node:assert/strict";
import { checkOrder } from "./order-check.mjs";

const OK = `# 目标
把 foo 改成 bar。
# 相关文件
- src/a.mjs
# 要求
1. 改 a。
2. 补测试。
# 禁区
不碰凭据。
# 验收
::RUBRIC{id:r1|threshold:1.0}
  R:tests|check:"node --test"
# 交回
commit 后写结果。
`;

test("合格单 ok", () => {
  const r = checkOrder(OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.stats, { requirements: 2, files: 1, checks: 1, steps: [] });
});

test("要求 4 条超标", () => {
  const r = checkOrder(OK.replace("2. 补测试。", "2. 补测试。\n3. 改 c。\n4. 改 d。"));
  assert.equal(r.ok, false);
  assert.equal(r.stats.requirements, 4);
  assert.match(r.problems.join("\n"), /超过上限 3 条/);
});

test("缺验收段", () => {
  const r = checkOrder(OK.replace(/# 验收\n[\s\S]*?(?=# 交回)/, ""));
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes("缺「验收」段"));
});

test("验收全是 check:human", () => {
  const r = checkOrder(OK.replace('check:"node --test"', "check:human"));
  assert.equal(r.ok, false);
  assert.equal(r.stats.checks, 0);
  assert.match(r.problems.join("\n"), /没有 check:"…" 项/);
});

test("要求里写了先…再，算步骤", () => {
  const r = checkOrder(OK.replace("1. 改 a。", "1. 先改 a，再改 b。"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.stats.steps, ["先…再"]);
  assert.match(r.problems.join("\n"), /先…再/);
});

test("只是引用这些字眼（引号/括号/行内代码）不算步骤", () => {
  const r = checkOrder(OK.replace("1. 改 a。", "1. 查「先…再」「然后」「最后」「第一步」，括号里（步骤 2）也不算。"));
  assert.deepEqual(r.stats.steps, []);
});

test("交回段出现然后不算步骤", () => {
  const r = checkOrder(OK.replace("commit 后写结果。", "然后 commit，再写结果。"));
  assert.deepEqual(r.stats.steps, []);
});
