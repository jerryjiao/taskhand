// taskhand.mjs change verification: the four exports (claudeEnv/runClaude/bigmodelApiKey/altApiKey),
// the CLI entry wrapped in "only when run directly" (importing for reuse doesn't trigger the CLI;
// direct/symlinked runs behave as before), and claudeEnv's LOOP_GUARD_ROOT passthrough (for hosts;
// unset means absent, dispatch behavior unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { altApiKey, autoChannels, bigmodelApiKey, claudeEnv, dispatch, DISPATCH_MAGPIE_MODEL, looksUnreachable, MAGPIE_MODEL, pickRoute, runClaude, summarizeLog } from "./taskhand.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TASKHAND = join(dirname(fileURLToPath(import.meta.url)), "taskhand.mjs");

test("import for reuse: the four names import and are functions, no module-top-level side effects", () => {
  for (const f of [claudeEnv, runClaude, bigmodelApiKey, altApiKey]) assert.equal(typeof f, "function");
});

test("direct run: no args → usage error exit 2; the log subcommand works as before (read-only)", () => {
  const bad = spawnSync(process.execPath, [TASKHAND], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);
  const log = spawnSync(process.execPath, [TASKHAND, "log", "--days", "1"], { encoding: "utf8" });
  assert.equal(log.status, 0);
  assert.ok(log.stdout.length > 0);
});

test("running the CLI via a symlink works as before (the ~/.claude/skills symlink case; the test removes only its own temp symlink)", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskhand-cli-link-"));
  try {
    const link = join(dir, "taskhand-link.mjs");
    symlinkSync(TASKHAND, link);
    const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeEnv: whitelist env as before; LOOP_GUARD_ROOT/LOOP_SESSION_ID/LOOP_SHIFT pass through only when set", () => {
  process.env.LOOP_GUARD_ROOT = "/tmp/ws-root";
  try {
    assert.equal(claudeEnv("k", "GLM-5.3").LOOP_GUARD_ROOT, "/tmp/ws-root");
  } finally {
    delete process.env.LOOP_GUARD_ROOT;
  }
  const env = claudeEnv("k", "GLM-5.3");
  assert.equal("LOOP_GUARD_ROOT" in env, false);
  process.env.LOOP_SESSION_ID = "sess-from-shift";
  process.env.LOOP_SHIFT = "09";
  try {
    assert.equal(claudeEnv("k", "GLM-5.3").LOOP_SESSION_ID, "sess-from-shift");
    assert.equal(claudeEnv("k", "GLM-5.3").LOOP_SHIFT, "09", "the host's shift number must reach the shift's session");
  } finally {
    delete process.env.LOOP_SESSION_ID;
    delete process.env.LOOP_SHIFT;
  }
  assert.equal("LOOP_SESSION_ID" in claudeEnv("k", "GLM-5.3"), false);
  assert.equal("LOOP_SHIFT" in claudeEnv("k", "GLM-5.3"), false);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "k");
  assert.equal(env.ANTHROPIC_MODEL, "GLM-5.3");
  assert.equal(env.CLAUDE_CONFIG_DIR, join(process.env.HOME, ".taskhand", "claude"));
});

test("claudeEnv: without baseUrl the original Zhipu endpoint, with it the one given (magpie channel)", () => {
  assert.equal(claudeEnv("k", "GLM-5.3").ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(MAGPIE_MODEL, "group/smart-split");
  assert.equal(claudeEnv("k", MAGPIE_MODEL, "http://127.0.0.1:3425").ANTHROPIC_BASE_URL, "http://127.0.0.1:3425");
});

/** Records args/env only; never spawns a real claude. */
function fakeSpawn(calls, out = { result: "ok" }) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", JSON.stringify(out));
      child.emit("close", 0);
    });
    return child;
  };
}

test("runClaude subscription: spends the local claude login — no CLAUDE_CONFIG_DIR/ANTHROPIC_* in env, --model opus in args, guard still attached", async () => {
  process.env.CLAUDE_CONFIG_DIR = "/should/not/leak";
  process.env.ANTHROPIC_AUTH_TOKEN = "should-not-leak";
  const calls = [];
  try {
    const r = await runClaude({ cwd: "/tmp", prompt: "p", key: "ignored", modelId: "ignored", subscription: true, timeoutMs: 1000, spawnFn: fakeSpawn(calls) });
    assert.equal(r.code, 0);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
  const { args, env } = calls[0];
  assert.equal("CLAUDE_CONFIG_DIR" in env, false);
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_")), []);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
  for (const flag of ["--settings", "--disallowedTools", "--append-system-prompt", "--dangerously-skip-permissions"]) assert.ok(args.includes(flag), flag);
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
  assert.equal(env.LOGNAME, env.USER, "LOGNAME follows USER");
  // without subscription: the original isolated-config path, unchanged
  const plain = [];
  await runClaude({ cwd: "/tmp", prompt: "p", key: "k", modelId: "GLM-5.3", timeoutMs: 1000, spawnFn: fakeSpawn(plain) });
  assert.equal(plain[0].env.CLAUDE_CONFIG_DIR, join(process.env.HOME, ".taskhand", "claude"));
  assert.equal(plain[0].env.ANTHROPIC_AUTH_TOKEN, "k");
  assert.equal(plain[0].args.includes("--model"), false);
});

test("pickRoute: without --magpie-model the channel order is as before, no pinned model", () => {
  const up = { magpieUp: true, hasAlt: true };
  assert.deepEqual(pickRoute({ ...up, channelOpt: "auto", engineOpt: "auto" }), { model: null, channels: ["magpie", "alt", "primary"] });
  assert.deepEqual(pickRoute({ magpieUp: false, hasAlt: false, channelOpt: "primary", engineOpt: "zcode" }), { model: null, channels: ["primary"] });
});

test("pickRoute: --magpie-model pins the given id, channels collapse to magpie", () => {
  assert.deepEqual(
    pickRoute({ magpieModel: "cursor/grok-4.7@500k", channelOpt: "auto", engineOpt: "auto", magpieUp: false, hasAlt: true }),
    { model: "cursor/grok-4.7@500k", channels: ["magpie"] },
  );
  assert.equal(pickRoute({ magpieModel: "zcode/GLM-5.3-FLASHX", channelOpt: "auto", engineOpt: "auto" }).model, "zcode/GLM-5.3-FLASHX");
  assert.equal(pickRoute({ magpieModel: "deepseek/deepseek-flash", channelOpt: "auto", engineOpt: "auto" }).model, "deepseek/deepseek-flash");
});

test("pickRoute: combined with --channel / --engine, or a malformed id, is exit 2", () => {
  for (const bad of [
    { magpieModel: "cursor/grok", channelOpt: "primary", engineOpt: "auto" },
    { magpieModel: "cursor/grok", channelOpt: "auto", engineOpt: "zcode" },
    { magpieModel: "no-slash", channelOpt: "auto", engineOpt: "auto" },
    { magpieModel: "Bad/model", channelOpt: "auto", engineOpt: "auto" },
  ]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { pickRoute } from ${JSON.stringify(TASKHAND)}; pickRoute(${JSON.stringify(bad)});`], { encoding: "utf8" });
    assert.equal(r.status, 2, bad.magpieModel);
    assert.match(r.stderr, /--magpie-model/);
  }
});

test("autoChannels: magpie first when the gateway is up, then the second key, primary last", () => {
  assert.deepEqual(autoChannels({ magpieUp: true, hasAlt: true }), ["magpie", "alt", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: true, hasAlt: false }), ["magpie", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: false, hasAlt: true }), ["alt", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: false, hasAlt: false }), ["primary"]);
});

test("looksUnreachable: DNS failures and gateway 502/503/504 also count as unreachable; ordinary errors don't", () => {
  // a real 502-gateway + getaddrinfo ENOTFOUND mix — both signatures must hit
  const real = { code: 1, stderr: "API Error: 502 ZCode: getaddrinfo ENOTFOUND open.bigmodel.cn", json: null, timedOut: false };
  assert.equal(looksUnreachable(real), true);
  for (const stderr of [
    "Error: getaddrinfo EAI_AGAIN magpie.internal",
    "API Error: 503 Service Unavailable",
    "API Error: 504 Gateway Timeout",
    "Error: connect ECONNREFUSED 127.0.0.1:3425",
    "fetch failed",
    "socket hang up",
  ]) {
    assert.equal(looksUnreachable({ code: 1, stderr, json: null, timedOut: false }), true, stderr);
  }
  // model/argument errors are not gateway unreachability — must not trigger fallback
  for (const stderr of ["[claude-code:unrecognized_model] nope", "API Error: 400 bad request", "API Error: 429 too many requests"]) {
    assert.equal(looksUnreachable({ code: 1, stderr, json: null, timedOut: false }), false, stderr);
  }
  // errors inside json.response must be recognized too (empty stderr, error in the JSON output channel)
  assert.equal(looksUnreachable({ code: 1, stderr: "", json: { response: "Connection error" }, timedOut: false }), true);
});

test("summarizeLog.byUnit: rework rate per task+unit, both resume and rework records count, records without unit ignored", () => {
  const ts = new Date().toISOString();
  const rows = [
    { kind: "dispatch", task: "a", unit: "1", ts },
    { kind: "dispatch", task: "a", unit: "1", resume: "sess_x", ts },   // this order was bounced via resume
    { kind: "dispatch", task: "b", unit: "2", ts },
    { kind: "rework", task: "b", unit: "2", ts },                       // this order was bounced via a rework note
    { kind: "dispatch", task: "c", unit: "3", ts },                     // never bounced
    { kind: "dispatch", task: "d", ts },                                // old record: no unit, not counted
    { kind: "rework", task: "d", ts },
  ];
  assert.deepEqual(summarizeLog(rows, 14).byUnit, { units: 3, reworkedUnits: 2, reworkRate: 0.67 });
  assert.deepEqual(summarizeLog([], 14).byUnit, { units: 0, reworkedUnits: 0, reworkRate: null });
});

/** A fake claude: records args, never spawns. While hanging it stays up until killed (the script's timeout verdict). */
function fakeClaude(calls, script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const args = calls.at(-1);
    const r = script(args);
    child.kill = () => child.emit("close", r.code ?? null);
    queueMicrotask(() => {
      if (r.stderr) child.stderr.emit("data", r.stderr);
      if (r.stdout) child.stdout.emit("data", r.stdout);
      if (!r.hang) child.emit("close", r.code ?? 1);
    });
    return child;
  };
}

/** A health-check-clean order; runDispatch uses it by default — don't add --skip-check to existing tests. */
const VALID_ORDER = `# Goal
A fake order.
# Files
- a.mjs
# Requirements
- Change one thing.
# Off-limits
No credentials.
# Acceptance
::RUBRIC{id:r1|threshold:1.0}
  R:tests|check:"node --test"
# Report
Report back.
`;
const OVERSIZED_ORDER = VALID_ORDER.replace("- Change one thing.\n", "- one\n- two\n- three\n- four\n");

/** Calls dispatch directly (deps.returnResult skips logging and process.exit): magpie channel pinned. */
async function runDispatch(extra, script, prompt = VALID_ORDER) {
  const dir = mkdtempSync(join(tmpdir(), "taskhand-dispatch-"));
  const promptFile = join(dir, "task.md");
  writeFileSync(promptFile, prompt);
  const calls = [];
  try {
    const json = await dispatch({
      cwd: dir, "prompt-file": promptFile, channel: "magpie", engine: "claude", "timeout-min": "70", ...extra,
    }, {
      spawnFn: (...a) => { calls.push(a[1]); return fakeClaude(calls, script)(); },
      magpieUpFn: async () => false,
      keyFn: () => "k",
      returnResult: true,
    });
    return { json, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("timeout: error starts with 'timeout (N min…)', model errors from stderr stay on the tail", async () => {
  const { json } = await runDispatch({ "timeout-min": "0.001" }, () => ({ stderr: "[claude-code:unrecognized_model] nope", hang: true }));
  assert.equal(json.timedOut, true);
  assert.match(json.error, /^timeout \(0 min, force-killed/);
  assert.match(json.error, /unrecognized_model/);
});

test("new session: claude args carry --session-id <uuid>; on failure sessionId falls back to that uuid", async () => {
  const { json, calls } = await runDispatch({}, () => ({ stderr: "boom", code: 1 }));
  const i = calls[0].indexOf("--session-id");
  assert.notEqual(i, -1);
  assert.match(calls[0][i + 1], UUID_RE);
  assert.equal(json.ok, false);
  assert.equal(json.sessionId, calls[0][i + 1]);
  assert.equal(json.model, `claude/magpie/${DISPATCH_MAGPIE_MODEL}`);
});

test("--hard: the magpie channel routes to the planner group", async () => {
  const { json } = await runDispatch({ hard: true }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }));
  assert.equal(json.model, "claude/magpie/group/planner");
});

test("without --hard: the magpie channel goes to the worker group as before", async () => {
  const { json } = await runDispatch({}, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }));
  assert.equal(json.model, `claude/magpie/${DISPATCH_MAGPIE_MODEL}`);
});

test("health check: an oversized new order is blocked (exit 2, problems listed + --skip-check hint), no child spawns", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskhand-check-"));
  try {
    const promptFile = join(dir, "big.md");
    const marker = join(dir, "spawned");
    writeFileSync(promptFile, OVERSIZED_ORDER);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      import { dispatch } from ${JSON.stringify(TASKHAND)};
      await dispatch({ cwd: ${JSON.stringify(dir)}, "prompt-file": ${JSON.stringify(promptFile)}, channel: "primary", engine: "claude" }, {
        spawnFn: () => writeFileSync(${JSON.stringify(marker)}, "x"),
        magpieUpFn: async () => false, keyFn: () => "k", returnResult: true,
      });
    `], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /over the limit of 3/);
    assert.match(r.stderr, /split the order, or pass --skip-check/);
    assert.equal(existsSync(marker), false, "a failed check must not spawn a child");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("health check: --skip-check lets an oversized order through and spawns the child", async () => {
  const { json, calls } = await runDispatch({ "skip-check": true }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }), OVERSIZED_ORDER);
  assert.equal(json.ok, true);
  assert.equal(calls.length, 1);
});

test("health check: --resume rework skips the check, oversized orders run as usual", async () => {
  const { json, calls } = await runDispatch({ resume: "11111111-2222-3333-4444-555555555555" }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }), OVERSIZED_ORDER);
  assert.equal(json.ok, true);
  assert.equal(calls.length, 1);
});

test("--hard together with --magpie-model: dispatch exits 2 with a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskhand-hard-"));
  try {
    const promptFile = join(dir, "task.md");
    writeFileSync(promptFile, VALID_ORDER);
    const r = spawnSync(process.execPath, [TASKHAND, "dispatch", "--cwd", dir, "--prompt-file", promptFile, "--hard", "--magpie-model", "cursor/grok-4.7@500k"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--hard and --magpie-model are mutually exclusive/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--resume drops --session-id; on failure sessionId falls back to the given id", async () => {
  const { json, calls } = await runDispatch({ resume: "11111111-2222-3333-4444-555555555555" }, () => ({ stderr: "boom", code: 1 }));
  assert.equal(calls[0].includes("--session-id"), false);
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--resume"), calls[0].indexOf("--resume") + 2), ["--resume", "11111111-2222-3333-4444-555555555555"]);
  assert.equal(json.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("pinned model timeout: error still starts with 'pinned model X failed:', 'timeout' within the first 60 chars", async () => {
  const { json } = await runDispatch({ channel: "auto", engine: "auto", "magpie-model": "cursor/grok-4.7@500k", "timeout-min": "0.001" }, () => ({ stderr: "[claude-code:unrecognized_model] nope", hang: true }));
  assert.match(json.error, /^pinned model cursor\/grok-4\.7@500k failed: timeout \(0 min/);
  assert.ok(json.error.indexOf("timeout") < 60, json.error.slice(0, 60));
});
