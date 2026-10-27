#!/usr/bin/env node
// taskhand：把一单活派给无头 CLI agent 执行——首选 claude -p（任意 Anthropic 兼容端点），
// 按通道/引擎兜底，并记日志。用法与派工单格式见 README.md。
//
//   node taskhand.mjs dispatch --cwd <worktree> --prompt-file <file> [--resume sess_x|<claude会话id>]
//        [--engine auto|claude|zcode] [--model <内置短名|任意模型id>] [--mode yolo|build|edit|plan]
//        [--task <label>] [--unit <n>] [--timeout-min 30] [--channel auto|magpie|primary|alt]
//        [--magpie-model <网关模型 id>] [--hard] [--skip-check]
//   node taskhand.mjs note --kind exception|takeover|rework|publish|rollback --task <label> [--unit <n>] [--detail "..."]
//   node taskhand.mjs log [--days 14]
//
// auto 兜底顺序：magpie 网关（在线时打头，连不上网关也换）→ alt key（钥匙串，无周上限）
// →（仅限流时）主 key（有周上限） →（仅非限流、非超时的失败）zcode 引擎。
// claude 超时不兜底直接失败。--resume 不跨引擎：sess_ 开头是 zcode 会话，否则是 claude 会话，按 id 钉死引擎。

import { spawn as realSpawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, appendFileSync, chmodSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkOrder } from "./order-check.mjs";

const HOME = homedir();
const TASKHAND_HOME = join(HOME, ".taskhand");
const STORAGE = join(TASKHAND_HOME, ".zcode");
const PROVIDER_FILE = join(TASKHAND_HOME, "provider_config.json");
const LOG_FILE = join(TASKHAND_HOME, "log.jsonl");
const USER_PROVIDER_FILE = join(HOME, ".zcode", "v2", "provider_config.json");
const ZCODE_APP = "/Applications/ZCode.app";
const ZCODE_CLI = join(ZCODE_APP, "Contents", "Resources", "glm", "zcode.cjs");

// 走 Coding Plan API key 通道（bigmodel-api，包月额度）；账号通道在命令行里解析不出来。
// 第二个 key 存在钥匙串（service=taskhand-alt，TASKHAND_ALT_KEYCHAIN_SERVICE 可换）；auto 下先用它（无周上限），撞限额再换主 key，key 只写进 600 权限的配置文件。
const ALT_KEYCHAIN_SERVICE = process.env.TASKHAND_ALT_KEYCHAIN_SERVICE || "taskhand-alt";
const CHANNELS = new Set(["auto", "magpie", "primary", "alt"]);
const ENGINES = new Set(["auto", "claude", "zcode"]);
const MODELS = { flashx: "GLM-5.3-FLASHX", flash: "GLM-5.3-Flash", "glm-5.3": "GLM-5.3" };
const MODES = new Set(["yolo", "build", "edit", "plan", "guarded"]);
// 无人值守下不该有的工具：替你回消息、演示用的部署/制造崩溃。
const DISALLOWED_TOOLS = [
  "ReplyToChannel",
  "mcp__plugin_showcase_showcase__deploy",
  "mcp__plugin_showcase_showcase__simulate_crash",
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function die(msg) {
  process.stderr.write(`taskhand: ${msg}\n`);
  process.exit(2);
}

function appendLog(entry) {
  mkdirSync(TASKHAND_HOME, { recursive: true, mode: 0o700 });
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function zcodeVersion() {
  const plist = readFileSync(join(ZCODE_APP, "Contents", "Info.plist"), "utf8");
  const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  if (!m) die("读不到 ZCode.app 版本号");
  return m[1];
}

function builtinProviderFile() {
  const dir = join(HOME, ".zcode", "v2", "runtime", "provider", "darwin-aarch64", zcodeVersion());
  if (!existsSync(dir)) die(`找不到 ${dir}——先打开一次 ZCode 桌面版让它生成运行时配置`);
  for (const ep of readdirSync(dir)) {
    const f = join(dir, ep, "zcode-builtin.json");
    if (ep.startsWith("endpoint-") && existsSync(f)) return f;
  }
  die(`${dir} 下没有 zcode-builtin.json`);
}

export function altApiKey() {
  const r = spawnSync("security", ["find-generic-password", "-s", ALT_KEYCHAIN_SERVICE, "-a", process.env.USER ?? "", "-w"], { encoding: "utf8" });
  const key = r.status === 0 ? r.stdout.trim() : "";
  return key || null;
}

// 每次从你自己的 provider 配置现场生成力工那份：只改默认模型，并把 FLASHX 挂到 API key 通道上；alt 通道只换 key。
function writeProviderConfig(modelId, channel) {
  const cfg = JSON.parse(readFileSync(USER_PROVIDER_FILE, "utf8"));
  const rules = cfg.config?.providerConfigRules?.providerRules ?? [];
  const api = rules.find((r) => r.providerId === "bigmodel-api");
  if (!api) die("你的 zcode 配置里没有 bigmodel-api（Coding Plan API key）通道");
  if (channel === "alt") {
    const key = altApiKey() ?? die(`钥匙串里没有 ${ALT_KEYCHAIN_SERVICE}`);
    api.config.access = { ...api.config.access, apiKey: key };
  }
  api.config.personalModelIds = ["GLM-5.3-FLASHX"];
  api.config.modelOrder = ["GLM-5.3-FLASHX", "GLM-5.3", "GLM-5.3-Flash"];
  cfg.config.defaultModelSelection = { providerId: "bigmodel-api", modelId, options: { reasoningLevel: "max" } };
  mkdirSync(TASKHAND_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(PROVIDER_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(PROVIDER_FILE, 0o600);
}

// worktree 也归到主仓库名下，复盘时按项目汇总才对得上。
function gitTop(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return r.status === 0 ? dirname(r.stdout.trim()) : null;
}

function runZcode({ cwd, prompt, resume, mode, timeoutMs }) {
  const args = [ZCODE_CLI, "--cwd", cwd, "--mode", mode, "--json", "--disallowed-tools", DISALLOWED_TOOLS.join(",")];
  if (resume) args.push("--resume", resume);
  args.push("-p", prompt);
  const env = {
    ...process.env,
    ZCODE_STORAGE_DIR: STORAGE,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinProviderFile(),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: PROVIDER_FILE,
  };
  return new Promise((done) => {
    const child = realSpawn(process.execPath, args, { cwd: HOME, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 非 JSON 输出按失败处理 */ }
      done({ code, json, stderr, timedOut });
    });
  });
}

export function looksRateLimited(r) {
  const text = `${r.stderr} ${r.json?.response ?? ""} ${r.json?.result ?? ""}`;
  return /\b429\b|\b1308\b|rate.?limit|too many requests|并发|限流|使用上限/i.test(text);
}

// magpie 通道连不上网关的特征（超时不算，由调用方排除）。DNS 解析失败（ENOTFOUND/EAI_AGAIN）
// 与网关 502/503/504（bigmodel 侧返回 API Error: 5xx）也是网关不可达。
export function looksUnreachable(r) {
  const text = `${r.stderr} ${r.json?.response ?? ""} ${r.json?.result ?? ""}`;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Connection error|fetch failed|socket hang up|API Error: 50[234]/i.test(text);
}

// --channel auto 的通道顺序：网关在线 magpie 打头，第二个 key 次之，主 key 兜底。
export function autoChannels({ magpieUp, hasAlt }) {
  return [...(magpieUp ? ["magpie"] : []), ...(hasAlt ? ["alt"] : []), "primary"];
}

// --magpie-model 把一单钉死在网关的具体模型上：只走 magpie，不回退 alt/primary/zcode（回退等于悄悄换模型）。
const MAGPIE_MODEL_RE = /^[a-z0-9-]+\/[A-Za-z0-9._@:-]+$/;
export function pickRoute({ magpieModel, hard, channelOpt, engineOpt, magpieUp, hasAlt }) {
  if (hard && magpieModel) die("--hard 与 --magpie-model 不能同时给：--hard 已经指定走智囊团组");
  if (!magpieModel) return { model: null, channels: channelOpt === "auto" ? autoChannels({ magpieUp, hasAlt }) : [channelOpt] };
  if (!MAGPIE_MODEL_RE.test(magpieModel)) die(`--magpie-model 只接受 <供应商>/<模型>，如 cursor/grok-4.7@500k：${magpieModel}`);
  if (channelOpt !== "auto" || engineOpt !== "auto") die("--magpie-model 固定走 magpie 通道，不能同时给 --channel 或 --engine");
  return { model: magpieModel, channels: ["magpie"] };
}

// magpie 在线即 /v1/models 3 秒内应答 ok；没起、端口不通等异常一律算不在线。
function magpieUp() {
  return fetch(MAGPIE_BASE_URL + "/v1/models", { signal: AbortSignal.timeout(3000) })
    .then((res) => res.ok).catch(() => false);
}

// —— claude 引擎：claude -p 无头模式，经智谱 Anthropic 兼容端点跑同一份 GLM Coding Plan ——
const CLAUDE_CONFIG_DIR = join(TASKHAND_HOME, "claude");
const ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
// magpie 网关：本机回环固定常量，非动态 URL；网关不鉴权，token 传固定占位串（不是凭据）。
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425";
// 默认模型走 magpie 的 smart-split 分类组；--model 对 magpie 通道无效。
export const MAGPIE_MODEL = "group/smart-split";
// 智囊团派的单直接进力工组，不过分类器（派的单经 smart-split 几乎都被判进上级组）。
export const DISPATCH_MAGPIE_MODEL = "group/taskhand";
// --hard 标的是真难的单（排查 bug、设计取舍），交给智囊团组而不是力工组。
export const HARD_MAGPIE_MODEL = "group/planner";
// 硬拦截禁区：防 force push / 删分支 / 碰钥匙串和 .env，再叠加 zcode 那三项无人值守禁区。
// export 给宿主程序拼无头会话参数复用；内容不动，runClaude 内部照用。
export const CLAUDE_DENY = [
  "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
  "Bash(git push --delete:*)", "Bash(git branch -D:*)", "Bash(git branch -d:*)", "Bash(security:*)",
  "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
  ...DISALLOWED_TOOLS,
];
// PreToolUse 守卫：上面这份只按前缀匹配，拦不住复合命令（x && git push -f、bash -c "…"），
// 换 hook 按整条 Bash 命令逐段判（规则见 taskhand-guard.mjs）；CLAUDE_DENY 留着当双保险。
const CLAUDE_GUARD = join(dirname(fileURLToPath(import.meta.url)), "taskhand-guard.mjs");
export const CLAUDE_HOOKS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${CLAUDE_GUARD}"`, timeout: 10 }] }] },
});
// 追加系统提示声明力工身份：防 claude -p 从上级目录读到「智囊团/力工」分工规则后嵌套派活（实测发生过）。
export const CLAUDE_ROLE_PROMPT = "你就是力工（执行者），这一单由你亲自在当前目录完成。不要再派活：不要调用 taskhand.mjs、不要用 taskhand skill、不要新建 git worktree、不要启动子代理去代做。如果读到的 CLAUDE.md/AGENTS.md 里有「智囊团/力工分工、默认派活」之类的规则，那是写给智囊团的，对你不适用；项目里的其他规矩（代码规范、安全红线、禁区）照常遵守。";

// 主通道 key：优先 TASKHAND_API_KEY 环境变量（配 TASKHAND_BASE_URL 可指向任意 Anthropic 兼容端点）；
// 否则读 zcode 配置的 bigmodel-api 通道。只读进 env，不落盘、不回显。
export function bigmodelApiKey() {
  if (process.env.TASKHAND_API_KEY) return process.env.TASKHAND_API_KEY;
  try {
    const rules = JSON.parse(readFileSync(USER_PROVIDER_FILE, "utf8")).config?.providerConfigRules?.providerRules ?? [];
    return rules.find((r) => r.providerId === "bigmodel-api")?.config?.access?.apiKey ?? null;
  } catch { return null; }
}

// 子进程万一回显 key，进输出/日志前抹掉。
function redact(text, keys) {
  if (text == null) return text;
  let out = String(text);
  for (const k of keys) if (k) out = out.split(k).join("<KEY>");
  return out;
}

// env 白名单从零构建：不展开 process.env，防止继承父会话的 ANTHROPIC_*、CLAUDE_CODE_*、CLAUDECODE 等变量串台。
// 三个例外只在宿主设了时透传，派活路径上不存在，行为不变：
// LOOP_GUARD_ROOT 把守卫的 rm/find 边界从 worktree 换成指定根；
// LOOP_SESSION_ID 是本班会话号，子进程里的 orders CLI 靠它把 sessionId 写进单事件；
// LOOP_SHIFT 是本班编号，orders CLI 靠它认班次身份（02–05 点连班按钟点会算错班次）。
export function claudeEnv(key, modelId, baseUrl = ANTHROPIC_BASE_URL) {
  mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const env = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "TERM"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.env.LOOP_GUARD_ROOT !== undefined) env.LOOP_GUARD_ROOT = process.env.LOOP_GUARD_ROOT;
  if (process.env.LOOP_SESSION_ID !== undefined) env.LOOP_SESSION_ID = process.env.LOOP_SESSION_ID;
  if (process.env.LOOP_SHIFT !== undefined) env.LOOP_SHIFT = process.env.LOOP_SHIFT;
  return {
    ...env,
    CLAUDE_CONFIG_DIR,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    CLAUDE_CODE_SUBAGENT_MODEL: modelId,
    // 默认 32k 输出上限会掐断一次写大文件的回合（2026-10-19 GLM 视频单 36 分钟后中断）
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// 花本机 claude 已登录的订阅时的 env：不带 CLAUDE_CONFIG_DIR 与任何
// ANTHROPIC_*，claude 用他自己的登录；仍从零按白名单构建，免得父会话的变量串台。
// launchd 常不带 USER，claude 靠用户名去钥匙串取令牌；缺或空就补 username，LOGNAME 跟 USER。
export function subscriptionEnv() {
  const env = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "TERM"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.env.LOOP_GUARD_ROOT !== undefined) env.LOOP_GUARD_ROOT = process.env.LOOP_GUARD_ROOT;
  if (process.env.LOOP_SESSION_ID !== undefined) env.LOOP_SESSION_ID = process.env.LOOP_SESSION_ID;
  if (process.env.LOOP_SHIFT !== undefined) env.LOOP_SHIFT = process.env.LOOP_SHIFT;
  if (!env.USER) env.USER = userInfo().username;
  env.LOGNAME = env.USER;
  return {
    ...env,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** subscription: true 用本机 claude 已登录的订阅跑（忽略 key/modelId/baseUrl），守卫与设置照挂。 */
export function runClaude({ cwd, prompt, resume, sessionId, key, modelId, timeoutMs, baseUrl, subscription = false, spawnFn = realSpawn }) {
  const args = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--append-system-prompt", CLAUDE_ROLE_PROMPT, "--disallowedTools", ...CLAUDE_DENY, "--settings", CLAUDE_HOOKS];
  if (subscription) args.push("--model", "opus");
  if (resume) args.push("--resume", resume);
  else if (sessionId) args.push("--session-id", sessionId);
  return new Promise((done) => {
    const child = spawnFn("claude", args, { cwd, env: subscription ? subscriptionEnv() : claudeEnv(key, modelId, baseUrl), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); done(v); } };
    // claude 没装等 spawn 失败只触发 error 不触发 close，两路都兜住。
    child.on("error", (err) => finish({ code: -1, json: null, stderr: stderr + String(err), timedOut }));
    child.on("close", (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 非 JSON 输出按失败处理 */ }
      finish({ code, json, stderr, timedOut });
    });
  });
}

export async function dispatch(opts, deps = {}) {
  const spawnFn = deps.spawnFn ?? realSpawn;
  const cwd = resolve(String(opts.cwd ?? ""));
  if (!opts.cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) die("--cwd 必须是已存在的目录（力工的 worktree）");
  const promptFile = opts["prompt-file"];
  if (!promptFile || !existsSync(promptFile)) die("--prompt-file 必须指向写好的派活单");
  const prompt = readFileSync(promptFile, "utf8");
  // 新单发前体检，单大了拦回去拆；--resume 是打回续跑，不体检；--skip-check 只跳过拦截，stats 照记。
  const order = opts.resume ? null : checkOrder(prompt);
  const skipCheck = Boolean(opts["skip-check"]);
  if (order && !order.ok && !skipCheck) {
    die(`派活单体检不过：\n${order.problems.map((p) => `  - ${p}`).join("\n")}\n拆单，或确需整单派出时加 --skip-check`);
  }
  const modelKey = String(opts.model ?? "flashx");
  // 内置短名之外放行任意模型 id（配 TASKHAND_BASE_URL 指向其他端点用）
  const modelId = MODELS[modelKey] ?? (/^[A-Za-z0-9._@:/-]+$/.test(modelKey) ? modelKey : die(`--model 只能是 ${Object.keys(MODELS).join("|")}，或直接给一个模型 id`));
  const mode = String(opts.mode ?? "yolo");
  if (!MODES.has(mode)) die(`--mode 只能是 ${[...MODES].join("|")}`);
  const timeoutMs = Number(opts["timeout-min"] ?? 30) * 60_000;
  const resume = opts.resume ? String(opts.resume) : undefined;
  const channelOpt = String(opts.channel ?? "auto");
  if (!CHANNELS.has(channelOpt)) die(`--channel 只能是 ${[...CHANNELS].join("|")}`);
  const engineOpt = String(opts.engine ?? "auto");
  if (!ENGINES.has(engineOpt)) die(`--engine 只能是 ${[...ENGINES].join("|")}`);
  if (opts["magpie-model"] === true) die("--magpie-model 需要一个模型 id，如 cursor/grok-4.7@500k");
  const hard = Boolean(opts.hard);
  const route = pickRoute({
    magpieModel: opts["magpie-model"] ? String(opts["magpie-model"]) : null,
    hard, channelOpt, engineOpt,
    magpieUp: opts["magpie-model"] ? false : await (deps.magpieUpFn ?? magpieUp)(),
    hasAlt: opts["magpie-model"] ? false : !!(deps.altKeyFn ?? altApiKey)(),
  });
  const channels = route.channels;
  const magpieModel = route.model ?? (hard ? HARD_MAGPIE_MODEL : DISPATCH_MAGPIE_MODEL);
  // 会话不跨引擎：sess_ 开头是 zcode 的，其余是 claude 的；有 --resume 就按 id 钉死引擎。
  let engine = engineOpt;
  if (resume) {
    const byId = resume.startsWith("sess_") ? "zcode" : "claude";
    if (engineOpt !== "auto" && engineOpt !== byId) die(`--resume ${resume} 是 ${byId} 引擎的会话，不能用 --engine ${engineOpt} 续跑`);
    engine = byId;
  }
  if (engine === "zcode" && !(existsSync(ZCODE_APP) && existsSync(USER_PROVIDER_FILE))) die("zcode 引擎不可用：本机没有 ZCode.app 或它的 provider 配置");

  const started = Date.now();
  // 新会话先定一个 id：claude 失败/超时不回 JSON 时也能交回 sessionId 供 --resume 续跑。
  const freshSessionId = resume ? null : randomUUID();
  const steps = [];
  const zFailed = (x) => x.code !== 0 || !x.json || x.timedOut;
  const cFailed = (x) => zFailed(x) || x.json.is_error === true;
  // claude 失败时原因常在 json.result 里（stderr 多半为空），拼到 stderr 末尾一起交回。
  const failText = (eng, r) => eng === "claude" ? [r.stderr, r.json?.result].filter(Boolean).join("\n") : r.stderr;
  // 只有失败的尝试才判断限流：成功的一律 false，免得交回文本里带个「429」就虚增限流统计。
  const record = (eng, ch, r, failed, keys) => {
    const bad = failed(r);
    steps.push({
      engine: eng, channel: ch, ok: !bad, rateLimited: bad && looksRateLimited(r),
      timedOut: r.timedOut, error: bad ? redact(failText(eng, r).slice(-500), keys) : null,
    });
  };

  // zcode 引擎（原逻辑）：撞限额换下一个 key，其他失败等 30s 重试一次。
  async function runZcodeEngine() {
    // zcode 不认 magpie 通道：过滤掉，全被过滤就按 primary 走。
    const zchs = channels.filter((c) => c !== "magpie");
    let r, channel;
    for (channel of zchs.length ? zchs : ["primary"]) {
      writeProviderConfig(modelId, channel);
      r = await runZcode({ cwd, prompt, resume, mode, timeoutMs });
      record("zcode", channel, r, zFailed, []);
      // 撞限额：同一份 GLM 包月额度的另一个 key 立刻接手（不是换模型）。
      if (zFailed(r) && looksRateLimited(r) && channel !== channels.at(-1)) continue;
      if (zFailed(r) && !r.timedOut) {
        // 力工用不了：等一会儿重试一次，还不行就交回智囊团（规则：不偷偷换模型、不自己接着干）。
        await new Promise((s) => setTimeout(s, 30_000));
        r = await runZcode({ cwd, prompt, resume, mode, timeoutMs });
        record("zcode", channel, r, zFailed, []);
      }
      break;
    }
    return { r, channel, keys: [] };
  }

  // claude 引擎：只按限流换 key（magpie 通道连不上网关也换），其他失败不重试（auto 下交给 zcode 兜底，单引擎下直接失败）。
  async function runClaudeEngine() {
    let r, channel;
    const keys = [];
    for (channel of channels) {
      const key = channel === "magpie" ? "magpie" : channel === "alt" ? (deps.altKeyFn ?? altApiKey)() : (deps.keyFn ?? bigmodelApiKey)();
      if (channel !== "magpie") keys.push(key);
      r = key ? await runClaude({
        cwd, prompt, resume, sessionId: freshSessionId, key, timeoutMs, spawnFn,
        modelId: channel === "magpie" ? magpieModel : modelId,
        baseUrl: channel === "magpie" ? MAGPIE_BASE_URL : process.env.TASKHAND_BASE_URL || undefined,
      })
        : { code: -1, json: null, timedOut: false, stderr: `取不到 ${channel === "alt" ? `钥匙串 ${ALT_KEYCHAIN_SERVICE}` : "TASKHAND_API_KEY / zcode 配置的 bigmodel-api"} 的 API key` };
      record("claude", channel, r, cFailed, keys);
      if (route.model) break; // 固定模型：失败就失败，不换通道也不换引擎
      if (cFailed(r) && (looksRateLimited(r) || (channel === "magpie" && !r.timedOut && looksUnreachable(r))) && channel !== channels.at(-1)) continue;
      break;
    }
    return { r, channel, keys };
  }

  let out;
  if (engine === "zcode") out = { engine: "zcode", ...(await runZcodeEngine()) };
  else if (engine === "claude") out = { engine: "claude", ...(await runClaudeEngine()) };
  else {
    // auto：claude 第二个 key 打头，限流换主 key 后仍限流就认输（zcode 用同一份额度，兜底也是撞墙）；
    // 非限流、非超时的失败才交 zcode；claude 超时不兜底，直接失败。
    const c = await runClaudeEngine();
    // 本机没有 zcode（无 ZCode.app/provider 配置）时不兜底，claude 的失败照原样交回
    const canZcode = existsSync(ZCODE_APP) && existsSync(USER_PROVIDER_FILE);
    out = route.model || !canZcode || !cFailed(c.r) || c.r.timedOut || (cFailed(c.r) && looksRateLimited(c.r))
      ? { engine: "claude", ...c }
      : { engine: "zcode", ...(await runZcodeEngine()) };
  }

  const isClaude = out.engine === "claude";
  const r = out.r;
  const failed = isClaude ? cFailed(r) : zFailed(r);
  const result = {
    ok: !failed,
    engine: out.engine,
    sessionId: isClaude ? r.json?.session_id ?? (resume ?? freshSessionId) : r.json?.sessionId ?? null,
    response: isClaude ? redact(r.json?.result ?? null, out.keys) : r.json?.response ?? null,
    model: isClaude
      ? `claude/${out.channel === "magpie" ? "magpie" : `bigmodel-anthropic${out.channel === "alt" ? "#2" : ""}`}/${out.channel === "magpie" ? magpieModel : modelId}`
      : `bigmodel-api${out.channel === "alt" ? "#2" : ""}/${modelId}`,
    channel: out.channel,
    mode,
    cwd,
    attempts: steps.length,
    timedOut: r.timedOut,
    rateLimited: failed && looksRateLimited(r),
    usage: isClaude && r.json?.usage
      ? { inputTokens: r.json.usage.input_tokens ?? null, outputTokens: r.json.usage.output_tokens ?? null }
      : r.json?.usage ?? null,
    durationMs: Date.now() - started,
    error: failed
      ? (route.model ? `固定模型 ${route.model} 失败：` : "")
        + (r.timedOut ? `超时（${Math.round(timeoutMs / 60_000)} 分钟被强制终止，力工已经工作了这么久，不是模型或通道不可用）：` : "")
        + redact(failText(out.engine, r).slice(-2000), out.keys)
      : null,
    steps,
  };
  if (!deps.returnResult) appendLog({
    kind: "dispatch",
    task: opts.task ?? null,
    unit: opts.unit ?? null,
    project: gitTop(cwd) ?? cwd,
    resume: resume ?? null,
    hard,
    order: order?.stats ?? null,
    skipCheck,
    ok: result.ok,
    engine: out.engine,
    sessionId: result.sessionId,
    model: result.model,
    channel: out.channel,
    attempts: result.attempts,
    timedOut: result.timedOut,
    rateLimited: result.rateLimited,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    durationMs: result.durationMs,
  });
  if (deps.returnResult) return result;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

function note(opts) {
  const kinds = new Set(["exception", "takeover", "rework", "publish", "rollback"]);
  if (!kinds.has(opts.kind)) die(`--kind 只能是 ${[...kinds].join("|")}`);
  appendLog({ kind: opts.kind, task: opts.task ?? null, unit: opts.unit ?? null, project: opts.project ?? null, detail: opts.detail ?? null });
  process.stdout.write("logged\n");
}

export function summarizeLog(rows, days) {
  const since = Date.now() - Number(days ?? 14) * 86_400_000;
  rows = rows.filter((e) => Date.parse(e.ts) >= since);
  const count = (k) => rows.filter((e) => e.kind === k).length;
  const d = rows.filter((e) => e.kind === "dispatch");
  // 按引擎分开看健康度；engine 字段出现前的旧记录都是 zcode 时代的。rework = 带 resume 的续跑单。
  const byEngine = {};
  for (const e of d) {
    const b = byEngine[e.engine ?? "zcode"] ??= { dispatches: 0, failed: 0, rateLimited: 0, rework: 0 };
    b.dispatches++;
    if (!e.ok) b.failed++;
    if (e.rateLimited) b.rateLimited++;
    if (e.resume) b.rework++;
  }
  // 打回率按「单」算：只认 task+unit 都有值的新记录，旧记录缺 unit 的忽略。
  const unitKey = (e) => `${e.task}\u0000${e.unit}`;
  const units = new Set(d.filter((e) => !e.resume && e.task && e.unit).map(unitKey));
  const reworkedUnits = new Set(rows.filter((e) => e.task && e.unit && units.has(unitKey(e))
    && ((e.kind === "dispatch" && e.resume) || e.kind === "rework")).map(unitKey));
  return {
    days: Number(days ?? 14),
    dispatches: d.length,
    failed: d.filter((e) => !e.ok).length,
    rateLimited: d.filter((e) => e.rateLimited).length,
    rework: count("rework"),
    exceptions: count("exception"),
    takeovers: count("takeover"),
    publishes: count("publish"),
    rollbacks: count("rollback"),
    byUnit: {
      units: units.size,
      reworkedUnits: reworkedUnits.size,
      reworkRate: units.size ? Number((reworkedUnits.size / units.size).toFixed(2)) : null,
    },
    byEngine,
    projects: [...new Set(d.map((e) => e.project))],
  };
}

function showLog(opts) {
  if (!existsSync(LOG_FILE)) return process.stdout.write("还没有记录\n");
  const rows = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  process.stdout.write(JSON.stringify(summarizeLog(rows, opts.days), null, 2) + "\n");
}

// CLI 入口只在直接运行时执行：宿主程序 import 本模块复用导出函数，不能连带跑 CLI。
// argv[1] 可能是软链（安装目录指回源仓库），realpath 后再比（同 taskhand-guard.mjs）。
try {
  if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
    const opts = parseArgs(process.argv.slice(2));
    const cmd = opts._[0];
    if (cmd === "dispatch") await dispatch(opts);
    else if (cmd === "note") note(opts);
    else if (cmd === "log") showLog(opts);
    else die("用法：taskhand.mjs dispatch|note|log，详见 README.md");
  }
} catch { /* argv[1] 不存在等情况：不运行 CLI */ }
