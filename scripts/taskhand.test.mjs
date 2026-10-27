// taskhand.mjs 的改动验证：四个导出（claudeEnv/runClaude/bigmodelApiKey/altApiKey）、
// CLI 入口包进「直接运行才执行」（import 复用不触发 CLI，直跑/软链跑行为照旧）、
// claudeEnv 的 LOOP_GUARD_ROOT 透传（宿主用；不设则不带，派活行为不变）。
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

test("import 复用：四个名字可导入且是函数，模块顶层无副作用", () => {
  for (const f of [claudeEnv, runClaude, bigmodelApiKey, altApiKey]) assert.equal(typeof f, "function");
});

test("直接运行：无参数 → 用法报错 exit 2；log 子命令照常（只读）", () => {
  const bad = spawnSync(process.execPath, [TASKHAND], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /用法/);
  const log = spawnSync(process.execPath, [TASKHAND, "log", "--days", "1"], { encoding: "utf8" });
  assert.equal(log.status, 0);
  assert.ok(log.stdout.length > 0);
});

test("经软链运行 CLI 照常（~/.claude/skills 软链场景；测试只删自己建的临时软链）", () => {
  const dir = mkdtempSync(join(tmpdir(), "lg-cli-link-"));
  try {
    const link = join(dir, "taskhand-link.mjs");
    symlinkSync(TASKHAND, link);
    const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /用法/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeEnv：白名单 env 照旧；LOOP_GUARD_ROOT/LOOP_SESSION_ID/LOOP_SHIFT 设了才透传", () => {
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
    assert.equal(claudeEnv("k", "GLM-5.3").LOOP_SHIFT, "09", "循环宿主的班次编号要透传给班次会话");
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

test("claudeEnv：不传 baseUrl 用原智谱端点，传了就用传的（magpie 通道）", () => {
  assert.equal(claudeEnv("k", "GLM-5.3").ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(MAGPIE_MODEL, "group/smart-split");
  assert.equal(claudeEnv("k", MAGPIE_MODEL, "http://127.0.0.1:3425").ANTHROPIC_BASE_URL, "http://127.0.0.1:3425");
});

/** 只记参数/环境、不真起 claude 的 spawn。 */
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

test("runClaude subscription：用本机 claude 登录——env 无 CLAUDE_CONFIG_DIR/ANTHROPIC_*，args 带 --model opus，守卫照挂", async () => {
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
  assert.equal(env.LOGNAME, env.USER, "LOGNAME 跟 USER");
  // 不传 subscription：走原来的隔离配置，行为不变
  const plain = [];
  await runClaude({ cwd: "/tmp", prompt: "p", key: "k", modelId: "GLM-5.3", timeoutMs: 1000, spawnFn: fakeSpawn(plain) });
  assert.equal(plain[0].env.CLAUDE_CONFIG_DIR, join(process.env.HOME, ".taskhand", "claude"));
  assert.equal(plain[0].env.ANTHROPIC_AUTH_TOKEN, "k");
  assert.equal(plain[0].args.includes("--model"), false);
});

test("pickRoute：不给 --magpie-model 时通道顺序照旧，模型不钉死", () => {
  const up = { magpieUp: true, hasAlt: true };
  assert.deepEqual(pickRoute({ ...up, channelOpt: "auto", engineOpt: "auto" }), { model: null, channels: ["magpie", "alt", "primary"] });
  assert.deepEqual(pickRoute({ magpieUp: false, hasAlt: false, channelOpt: "primary", engineOpt: "zcode" }), { model: null, channels: ["primary"] });
});

test("pickRoute：--magpie-model 钉死给定 id，通道只剩 magpie", () => {
  assert.deepEqual(
    pickRoute({ magpieModel: "cursor/grok-4.7@500k", channelOpt: "auto", engineOpt: "auto", magpieUp: false, hasAlt: true }),
    { model: "cursor/grok-4.7@500k", channels: ["magpie"] },
  );
  assert.equal(pickRoute({ magpieModel: "zcode/GLM-5.3-FLASHX", channelOpt: "auto", engineOpt: "auto" }).model, "zcode/GLM-5.3-FLASHX");
  assert.equal(pickRoute({ magpieModel: "deepseek/deepseek-flash", channelOpt: "auto", engineOpt: "auto" }).model, "deepseek/deepseek-flash");
});

test("pickRoute：和 --channel / --engine 同时给、或 id 不合格式，都是 exit 2", () => {
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

test("autoChannels：网关在线 magpie 打头，第二个 key 次之，主 key 兜底", () => {
  assert.deepEqual(autoChannels({ magpieUp: true, hasAlt: true }), ["magpie", "alt", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: true, hasAlt: false }), ["magpie", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: false, hasAlt: true }), ["alt", "primary"]);
  assert.deepEqual(autoChannels({ magpieUp: false, hasAlt: false }), ["primary"]);
});

test("looksUnreachable：DNS 解析失败与网关 502/503/504 也算不可达；普通报错不算", () => {
  // 502 网关 + getaddrinfo ENOTFOUND 混合报错，两种特征都要命中
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
  // 模型/参数类报错不是网关不可达，不许误回退
  for (const stderr of ["[claude-code:unrecognized_model] nope", "API Error: 400 bad request", "API Error: 429 too many requests"]) {
    assert.equal(looksUnreachable({ code: 1, stderr, json: null, timedOut: false }), false, stderr);
  }
  // json.response 里的报错也要认（stderr 为空、错误在 JSON 输出里的通道）
  assert.equal(looksUnreachable({ code: 1, stderr: "", json: { response: "Connection error" }, timedOut: false }), true);
});

test("summarizeLog.byUnit：按 task+unit 算打回率，resume 和 rework 记录都算，缺 unit 的旧记录忽略", () => {
  const ts = new Date().toISOString();
  const rows = [
    { kind: "dispatch", task: "a", unit: "1", ts },
    { kind: "dispatch", task: "a", unit: "1", resume: "sess_x", ts },   // 这一单被 resume 打回
    { kind: "dispatch", task: "b", unit: "2", ts },
    { kind: "rework", task: "b", unit: "2", ts },                       // 这一单被 rework 记录打回
    { kind: "dispatch", task: "c", unit: "3", ts },                     // 没被打回
    { kind: "dispatch", task: "d", ts },                                // 旧记录：缺 unit，不计入
    { kind: "rework", task: "d", ts },
  ];
  assert.deepEqual(summarizeLog(rows, 14).byUnit, { units: 3, reworkedUnits: 2, reworkRate: 0.67 });
  assert.deepEqual(summarizeLog([], 14).byUnit, { units: 0, reworkedUnits: 0, reworkRate: null });
});

/** 假 claude：记录参数，不真起进程。hang 时一直挂着，直到被 kill（即脚本判定超时）才退出。 */
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

/** 体检能过的派活单；runDispatch 默认用它，别给已有测试加 --skip-check。 */
const VALID_ORDER = `# 目标
假单
# 相关文件
- a.mjs
# 要求
- 改一处
# 禁区
不碰凭据
# 验收
::RUBRIC{id:r1|threshold:1.0}
  R:tests|check:"node --test"
# 交回
交回说明
`;
const OVERSIZED_ORDER = VALID_ORDER.replace("- 改一处\n", "- 一\n- 二\n- 三\n- 四\n");

/** 直接调 dispatch（deps.returnResult 跳过写日志和 process.exit）：钉死 magpie 通道。 */
async function runDispatch(extra, script, prompt = VALID_ORDER) {
  const dir = mkdtempSync(join(tmpdir(), "lg-dispatch-"));
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

test("超时：error 以「超时（N 分钟…）」开头，stderr 里的模型报错只留在尾巴", async () => {
  const { json } = await runDispatch({ "timeout-min": "0.001" }, () => ({ stderr: "[claude-code:unrecognized_model] nope", hang: true }));
  assert.equal(json.timedOut, true);
  assert.match(json.error, /^超时（0 分钟被强制终止，力工已经工作了这么久，不是模型或通道不可用）：/);
  assert.match(json.error, /unrecognized_model/);
});

test("新会话：claude 参数带 --session-id <uuid>，失败时 sessionId 回落这个 uuid", async () => {
  const { json, calls } = await runDispatch({}, () => ({ stderr: "boom", code: 1 }));
  const i = calls[0].indexOf("--session-id");
  assert.notEqual(i, -1);
  assert.match(calls[0][i + 1], UUID_RE);
  assert.equal(json.ok, false);
  assert.equal(json.sessionId, calls[0][i + 1]);
  assert.equal(json.model, `claude/magpie/${DISPATCH_MAGPIE_MODEL}`);
});

test("--hard：magpie 通道走智囊团组", async () => {
  const { json } = await runDispatch({ hard: true }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }));
  assert.equal(json.model, "claude/magpie/group/planner");
});

test("不给 --hard：magpie 通道照旧走力工组", async () => {
  const { json } = await runDispatch({}, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }));
  assert.equal(json.model, `claude/magpie/${DISPATCH_MAGPIE_MODEL}`);
});

test("体检：新单超标被拦（exit 2，逐条列问题 + --skip-check 提示），不起子进程", () => {
  const dir = mkdtempSync(join(tmpdir(), "lg-check-"));
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
    assert.match(r.stderr, /超过上限 3 条/);
    assert.match(r.stderr, /拆单，或确需整单派出时加 --skip-check/);
    assert.equal(existsSync(marker), false, "体检不过不该起子进程");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("体检：--skip-check 放行超标单，照常起子进程", async () => {
  const { json, calls } = await runDispatch({ "skip-check": true }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }), OVERSIZED_ORDER);
  assert.equal(json.ok, true);
  assert.equal(calls.length, 1);
});

test("体检：--resume 打回续跑不体检，超标单照常跑", async () => {
  const { json, calls } = await runDispatch({ resume: "11111111-2222-3333-4444-555555555555" }, () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) }), OVERSIZED_ORDER);
  assert.equal(json.ok, true);
  assert.equal(calls.length, 1);
});

test("--hard 与 --magpie-model 同时给：dispatch exit 2，中文报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "lg-hard-"));
  try {
    const promptFile = join(dir, "task.md");
    writeFileSync(promptFile, VALID_ORDER);
    const r = spawnSync(process.execPath, [TASKHAND, "dispatch", "--cwd", dir, "--prompt-file", promptFile, "--hard", "--magpie-model", "cursor/grok-4.7@500k"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--hard 与 --magpie-model 不能同时给/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--resume 时不加 --session-id，失败时 sessionId 回落传入的 id", async () => {
  const { json, calls } = await runDispatch({ resume: "11111111-2222-3333-4444-555555555555" }, () => ({ stderr: "boom", code: 1 }));
  assert.equal(calls[0].includes("--session-id"), false);
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--resume"), calls[0].indexOf("--resume") + 2), ["--resume", "11111111-2222-3333-4444-555555555555"]);
  assert.equal(json.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("固定模型超时：error 仍以「固定模型 X 失败：」开头，「超时」出现在前 60 个字符内", async () => {
  const { json } = await runDispatch({ channel: "auto", engine: "auto", "magpie-model": "cursor/grok-4.7@500k", "timeout-min": "0.001" }, () => ({ stderr: "[claude-code:unrecognized_model] nope", hang: true }));
  assert.match(json.error, /^固定模型 cursor\/grok-4\.7@500k 失败：超时（0 分钟被强制终止/);
  assert.ok(json.error.indexOf("超时") < 60, json.error.slice(0, 60));
});
