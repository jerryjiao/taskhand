// order-check.mjs tests: one valid order as the baseline; each case mutates one thing to prove one problem.
import test from "node:test";
import assert from "node:assert/strict";
import { checkOrder } from "./order-check.mjs";

const OK = `# Goal
Turn foo into bar.
# Files
- src/a.mjs
# Requirements
1. Change a.
2. Add tests.
# Off-limits
No credentials.
# Acceptance
::RUBRIC{id:r1|threshold:1.0}
  R:tests|check:"node --test"
# Report
commit, then write up the result.
`;

test("valid order passes", () => {
  const r = checkOrder(OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.stats, { requirements: 2, files: 1, checks: 1, steps: [] });
});

test("4 requirements is over the limit", () => {
  const r = checkOrder(OK.replace("2. Add tests.", "2. Add tests.\n3. Change c.\n4. Change d."));
  assert.equal(r.ok, false);
  assert.equal(r.stats.requirements, 4);
  assert.match(r.problems.join("\n"), /over the limit of 3/);
});

test("missing Acceptance section", () => {
  const r = checkOrder(OK.replace(/# Acceptance\n[\s\S]*?(?=# Report)/, ""));
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('missing section "Acceptance"'));
});

test("Acceptance with only check:human", () => {
  const r = checkOrder(OK.replace('check:"node --test"', "check:human"));
  assert.equal(r.ok, false);
  assert.equal(r.stats.checks, 0);
  assert.match(r.problems.join("\n"), /no check:"…" item/);
});

test("'first … then' in Requirements counts as a step", () => {
  const r = checkOrder(OK.replace("1. Change a.", "1. First change a, then change b."));
  assert.equal(r.ok, false);
  assert.deepEqual(r.stats.steps, ["first…then"]);
  assert.match(r.problems.join("\n"), /first…then/);
});

test("merely mentioning the words (quotes/parens/code spans) is not a step", () => {
  const r = checkOrder(OK.replace("1. Change a.", '1. Quote "first … then", "then", "finally", "step 2" (step 2 in parens) and `then` in code.'));
  assert.deepEqual(r.stats.steps, []);
});

test("'then' in the Report section is not a step", () => {
  const r = checkOrder(OK.replace("commit, then write up the result.", "then commit, then write it up."));
  assert.deepEqual(r.stats.steps, []);
});
