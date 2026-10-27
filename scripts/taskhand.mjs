#!/usr/bin/env node
// taskhand: dispatch one order to a headless CLI agent — prefers claude -p (any Anthropic-compatible
// endpoint), falls back across channels/engines, and logs everything. Usage & order format: README.md.
//
//   node taskhand.mjs dispatch --cwd <worktree> --prompt-file <file> [--resume sess_x|<claude-session-id>]
//        [--engine auto|claude|zcode] [--model <built-in short name|raw model id>] [--mode yolo|build|edit|plan]
//        [--task <label>] [--unit <n>] [--timeout-min 30] [--channel auto|magpie|primary|alt]
//        [--magpie-model <gateway model id>] [--hard] [--skip-check]
//   node taskhand.mjs note --kind exception|takeover|rework|publish|rollback --task <label> [--unit <n>] [--detail "..."]
//   node taskhand.mjs log [--days 14]
//
// auto fallback order: magpie gateway (first when up; switch away if the gateway is unreachable)
// → alt key (keychain, no weekly cap) → (rate-limited only) primary key (weekly cap)
// → (only for non-rate-limit, non-timeout failures) the zcode engine.
// A claude timeout is a hard failure, no fallback. --resume never crosses engines: sess_ ids are
// zcode sessions, everything else is claude; the id pins the engine.

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

// Uses the Coding Plan API-key channel (bigmodel-api, monthly quota); the account channel can't be
// resolved from the CLI. A second key lives in the keychain (service=taskhand-alt, override with
// TASKHAND_ALT_KEYCHAIN_SERVICE); under auto it goes first (no weekly cap), and on rate limits the
// primary key takes over. Keys only ever land in 0600 config files.
const ALT_KEYCHAIN_SERVICE = process.env.TASKHAND_ALT_KEYCHAIN_SERVICE || "taskhand-alt";
const CHANNELS = new Set(["auto", "magpie", "primary", "alt"]);
const ENGINES = new Set(["auto", "claude", "zcode"]);
const MODELS = { flashx: "GLM-5.3-FLASHX", flash: "GLM-5.3-Flash", "glm-5.3": "GLM-5.3" };
const MODES = new Set(["yolo", "build", "edit", "plan", "guarded"]);
// Tools an unattended worker must not have: replying on your behalf, demo deploys / fake crashes.
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
  if (!m) die("can't read the ZCode.app version");
  return m[1];
}

function builtinProviderFile() {
  const dir = join(HOME, ".zcode", "v2", "runtime", "provider", "darwin-aarch64", zcodeVersion());
  if (!existsSync(dir)) die(`can't find ${dir} — open the ZCode desktop app once so it generates its runtime config`);
  for (const ep of readdirSync(dir)) {
    const f = join(dir, ep, "zcode-builtin.json");
    if (ep.startsWith("endpoint-") && existsSync(f)) return f;
  }
  die(`no zcode-builtin.json under ${dir}`);
}

export function altApiKey() {
  const r = spawnSync("security", ["find-generic-password", "-s", ALT_KEYCHAIN_SERVICE, "-a", process.env.USER ?? "", "-w"], { encoding: "utf8" });
  const key = r.status === 0 ? r.stdout.trim() : "";
  return key || null;
}

// Generate the worker's provider config fresh from your own on every run: only the default model
// changes, with FLASHX pinned to the API-key channel; the alt channel swaps only the key.
function writeProviderConfig(modelId, channel) {
  const cfg = JSON.parse(readFileSync(USER_PROVIDER_FILE, "utf8"));
  const rules = cfg.config?.providerConfigRules?.providerRules ?? [];
  const api = rules.find((r) => r.providerId === "bigmodel-api");
  if (!api) die("your zcode config has no bigmodel-api (Coding Plan API key) channel");
  if (channel === "alt") {
    const key = altApiKey() ?? die(`no ${ALT_KEYCHAIN_SERVICE} in the keychain`);
    api.config.access = { ...api.config.access, apiKey: key };
  }
  api.config.personalModelIds = ["GLM-5.3-FLASHX"];
  api.config.modelOrder = ["GLM-5.3-FLASHX", "GLM-5.3", "GLM-5.3-Flash"];
  cfg.config.defaultModelSelection = { providerId: "bigmodel-api", modelId, options: { reasoningLevel: "max" } };
  mkdirSync(TASKHAND_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(PROVIDER_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(PROVIDER_FILE, 0o600);
}

// Attribute the worktree to the main repo, so per-project rollups line up in reviews.
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
      try { json = JSON.parse(stdout); } catch { /* non-JSON output counts as failure */ }
      done({ code, json, stderr, timedOut });
    });
  });
}

export function looksRateLimited(r) {
  const text = `${r.stderr} ${r.json?.response ?? ""} ${r.json?.result ?? ""}`;
  // The Chinese alternatives match rate-limit errors from Chinese-language upstream endpoints.
  return /\b429\b|\b1308\b|rate.?limit|too many requests|并发|限流|使用上限/i.test(text);
}

// Signature of the magpie channel failing to reach the gateway (timeouts excluded — caller filters).
// DNS failures (ENOTFOUND/EAI_AGAIN) and gateway 502/503/504 (upstream returns "API Error: 5xx")
// also count as unreachable.
export function looksUnreachable(r) {
  const text = `${r.stderr} ${r.json?.response ?? ""} ${r.json?.result ?? ""}`;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Connection error|fetch failed|socket hang up|API Error: 50[234]/i.test(text);
}

// Channel order under --channel auto: magpie first when the gateway is up, then the second key, primary last.
export function autoChannels({ magpieUp, hasAlt }) {
  return [...(magpieUp ? ["magpie"] : []), ...(hasAlt ? ["alt"] : []), "primary"];
}

// --magpie-model pins one order to a specific gateway model: magpie only, no fallback to
// alt/primary/zcode (a fallback would silently change the model).
const MAGPIE_MODEL_RE = /^[a-z0-9-]+\/[A-Za-z0-9._@:-]+$/;
export function pickRoute({ magpieModel, hard, channelOpt, engineOpt, magpieUp, hasAlt }) {
  if (hard && magpieModel) die("--hard and --magpie-model are mutually exclusive (--hard already routes to the planner group)");
  if (!magpieModel) return { model: null, channels: channelOpt === "auto" ? autoChannels({ magpieUp, hasAlt }) : [channelOpt] };
  if (!MAGPIE_MODEL_RE.test(magpieModel)) die(`--magpie-model only accepts <vendor>/<model>, e.g. cursor/grok-4.7@500k: ${magpieModel}`);
  if (channelOpt !== "auto" || engineOpt !== "auto") die("--magpie-model pins the magpie channel; don't combine it with --channel or --engine");
  return { model: magpieModel, channels: ["magpie"] };
}

// magpie is up iff /v1/models answers ok within 3s; not started, port closed, anything else = down.
function magpieUp() {
  return fetch(MAGPIE_BASE_URL + "/v1/models", { signal: AbortSignal.timeout(3000) })
    .then((res) => res.ok).catch(() => false);
}

// —— claude engine: headless claude -p over an Anthropic-compatible endpoint ——
const CLAUDE_CONFIG_DIR = join(TASKHAND_HOME, "claude");
const ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
// magpie gateway: fixed loopback constant, not a dynamic URL; the gateway authenticates nobody, the
// token is a fixed placeholder (not a credential).
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425";
// The default front door: magpie's smart-split classifier group; --model is ignored on the magpie channel.
export const MAGPIE_MODEL = "group/smart-split";
// Dispatched orders go straight to the worker group, skipping the classifier (smart-split almost
// always routes dispatched orders to the planner group).
export const DISPATCH_MAGPIE_MODEL = "group/taskhand";
// --hard marks a genuinely hard order (bug hunts, design trade-offs): planner group, not worker group.
export const HARD_MAGPIE_MODEL = "group/planner";
// Hard-blocked off-limits: force push / branch deletion / keychain and .env access, plus zcode's
// three unattended-work tools.
// Exported so host programs can reuse it to assemble headless session args; contents frozen — runClaude uses it internally.
export const CLAUDE_DENY = [
  "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
  "Bash(git push --delete:*)", "Bash(git branch -D:*)", "Bash(git branch -d:*)", "Bash(security:*)",
  "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
  ...DISALLOWED_TOOLS,
];
// PreToolUse guard: the deny list above matches prefixes only — compound commands (x && git push -f,
// bash -c "…") slip through. The hook judges the whole Bash command segment by segment
// (rules in taskhand-guard.mjs); CLAUDE_DENY stays as a second net.
const CLAUDE_GUARD = join(dirname(fileURLToPath(import.meta.url)), "taskhand-guard.mjs");
export const CLAUDE_HOOKS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${CLAUDE_GUARD}"`, timeout: 10 }] }] },
});
// Appended system prompt declaring the worker role: stops claude -p from reading orchestrator/worker
// division rules in a parent directory and dispatching again (observed in practice).
export const CLAUDE_ROLE_PROMPT = "You are the worker (executor): complete this order yourself, in the current directory. Do not dispatch further — don't call taskhand.mjs, don't use the taskhand skill, don't create git worktrees, don't spawn subagents to do the work. If the CLAUDE.md/AGENTS.md you read contains rules like 'orchestrator/worker division of labor, dispatch by default', those are written for the orchestrator and don't apply to you; the project's other rules (code style, security red lines, off-limits) still hold.";

// Primary key: TASKHAND_API_KEY env var first (pair with TASKHAND_BASE_URL for any Anthropic-compatible
// endpoint); otherwise read the bigmodel-api channel from the zcode config. Read into env only — never
// written to disk, never echoed.
export function bigmodelApiKey() {
  if (process.env.TASKHAND_API_KEY) return process.env.TASKHAND_API_KEY;
  try {
    const rules = JSON.parse(readFileSync(USER_PROVIDER_FILE, "utf8")).config?.providerConfigRules?.providerRules ?? [];
    return rules.find((r) => r.providerId === "bigmodel-api")?.config?.access?.apiKey ?? null;
  } catch { return null; }
}

// If a child ever echoes a key, scrub it before the text reaches output/logs.
function redact(text, keys) {
  if (text == null) return text;
  let out = String(text);
  for (const k of keys) if (k) out = out.split(k).join("<KEY>");
  return out;
}

// Env as a whitelist, built from scratch: no process.env spread, so the parent session's ANTHROPIC_*,
// CLAUDE_CODE_*, CLAUDECODE etc. can't leak in and cross wires.
// Three exceptions pass through only when the host sets them; absent on the dispatch path, behavior unchanged:
// LOOP_GUARD_ROOT moves the guard's rm/find boundary from the worktree to a given root;
// LOOP_SESSION_ID is the host session id; a child orders CLI stamps it onto order events;
// LOOP_SHIFT is the shift number; the orders CLI needs it to know which shift it serves (clock-based
// shift math gets the 02:00–05:00 chain wrong).
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
    // the default 32k output cap truncates a turn that writes a large file
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// Env for spending the local claude login's subscription: no CLAUDE_CONFIG_DIR, no ANTHROPIC_* — claude
// uses its own login. Still whitelist-built from scratch, so parent-session vars can't cross wires.
// launchd often omits USER; claude fetches its token from the keychain by username — backfill it if
// missing/empty, and make LOGNAME follow USER.
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

/** subscription: true spends the local claude login's subscription (key/modelId/baseUrl ignored); guard and settings still attach. */
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
    // when claude isn't installed, spawn failure fires `error` without `close` — handle both.
    child.on("error", (err) => finish({ code: -1, json: null, stderr: stderr + String(err), timedOut }));
    child.on("close", (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* non-JSON output counts as failure */ }
      finish({ code, json, stderr, timedOut });
    });
  });
}

export async function dispatch(opts, deps = {}) {
  const spawnFn = deps.spawnFn ?? realSpawn;
  const cwd = resolve(String(opts.cwd ?? ""));
  if (!opts.cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) die("--cwd must be an existing directory (the worker's worktree)");
  const promptFile = opts["prompt-file"];
  if (!promptFile || !existsSync(promptFile)) die("--prompt-file must point to a written order");
  const prompt = readFileSync(promptFile, "utf8");
  // Health-check new orders; bounce oversized ones back to be split. --resume is a rework continuation:
  // no check. --skip-check skips only the block; stats are still recorded.
  const order = opts.resume ? null : checkOrder(prompt);
  const skipCheck = Boolean(opts["skip-check"]);
  if (order && !order.ok && !skipCheck) {
    die(`order check failed:\n${order.problems.map((p) => `  - ${p}`).join("\n")}\nsplit the order, or pass --skip-check if it truly must go whole`);
  }
  const modelKey = String(opts.model ?? "flashx");
  // Beyond the built-in short names, accept any raw model id (pair with TASKHAND_BASE_URL for other endpoints)
  const modelId = MODELS[modelKey] ?? (/^[A-Za-z0-9._@:/-]+$/.test(modelKey) ? modelKey : die(`--model must be one of ${Object.keys(MODELS).join("|")}, or a raw model id`));
  const mode = String(opts.mode ?? "yolo");
  if (!MODES.has(mode)) die(`--mode must be one of ${[...MODES].join("|")}`);
  const timeoutMs = Number(opts["timeout-min"] ?? 30) * 60_000;
  const resume = opts.resume ? String(opts.resume) : undefined;
  const channelOpt = String(opts.channel ?? "auto");
  if (!CHANNELS.has(channelOpt)) die(`--channel must be one of ${[...CHANNELS].join("|")}`);
  const engineOpt = String(opts.engine ?? "auto");
  if (!ENGINES.has(engineOpt)) die(`--engine must be one of ${[...ENGINES].join("|")}`);
  if (opts["magpie-model"] === true) die("--magpie-model needs a model id, e.g. cursor/grok-4.7@500k");
  const hard = Boolean(opts.hard);
  const route = pickRoute({
    magpieModel: opts["magpie-model"] ? String(opts["magpie-model"]) : null,
    hard, channelOpt, engineOpt,
    magpieUp: opts["magpie-model"] ? false : await (deps.magpieUpFn ?? magpieUp)(),
    hasAlt: opts["magpie-model"] ? false : !!(deps.altKeyFn ?? altApiKey)(),
  });
  const channels = route.channels;
  const magpieModel = route.model ?? (hard ? HARD_MAGPIE_MODEL : DISPATCH_MAGPIE_MODEL);
  // Sessions never cross engines: sess_ ids are zcode's, everything else claude's; --resume pins the engine by id.
  let engine = engineOpt;
  if (resume) {
    const byId = resume.startsWith("sess_") ? "zcode" : "claude";
    if (engineOpt !== "auto" && engineOpt !== byId) die(`--resume ${resume} is a ${byId} session; can't resume it with --engine ${engineOpt}`);
    engine = byId;
  }
  if (engine === "zcode" && !(existsSync(ZCODE_APP) && existsSync(USER_PROVIDER_FILE))) die("zcode engine unavailable: no ZCode.app or provider config on this machine");

  const started = Date.now();
  // Pick a session id up front for new sessions: if claude fails/times out without returning JSON,
  // the id still comes back for --resume.
  const freshSessionId = resume ? null : randomUUID();
  const steps = [];
  const zFailed = (x) => x.code !== 0 || !x.json || x.timedOut;
  const cFailed = (x) => zFailed(x) || x.json.is_error === true;
  // On claude failures the reason usually sits in json.result (stderr is often empty) — append it to stderr.
  const failText = (eng, r) => eng === "claude" ? [r.stderr, r.json?.result].filter(Boolean).join("\n") : r.stderr;
  // Only failed attempts get the rate-limit test: successes are always false, so a stray "429" in
  // returned text can't inflate the rate-limit stats.
  const record = (eng, ch, r, failed, keys) => {
    const bad = failed(r);
    steps.push({
      engine: eng, channel: ch, ok: !bad, rateLimited: bad && looksRateLimited(r),
      timedOut: r.timedOut, error: bad ? redact(failText(eng, r).slice(-500), keys) : null,
    });
  };

  // zcode engine (the original path): on rate limits switch to the next key; other failures retry once after 30s.
  async function runZcodeEngine() {
    // zcode doesn't know the magpie channel: filter it out; if nothing remains, go as primary.
    const zchs = channels.filter((c) => c !== "magpie");
    let r, channel;
    for (channel of zchs.length ? zchs : ["primary"]) {
      writeProviderConfig(modelId, channel);
      r = await runZcode({ cwd, prompt, resume, mode, timeoutMs });
      record("zcode", channel, r, zFailed, []);
      // Rate limit: the other key on the same GLM monthly quota takes over immediately (not a model change).
      if (zFailed(r) && looksRateLimited(r) && channel !== channels.at(-1)) continue;
      if (zFailed(r) && !r.timedOut) {
        // Worker unavailable: wait a bit and retry once; if it still fails, hand back to the orchestrator
        // (rules: never silently switch models, never finish the order yourself).
        await new Promise((s) => setTimeout(s, 30_000));
        r = await runZcode({ cwd, prompt, resume, mode, timeoutMs });
        record("zcode", channel, r, zFailed, []);
      }
      break;
    }
    return { r, channel, keys: [] };
  }

  // claude engine: switch keys only on rate limits (or an unreachable magpie gateway); other failures
  // don't retry — under auto the zcode engine gets them, single-engine fails outright.
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
        : { code: -1, json: null, timedOut: false, stderr: `no API key for ${channel === "alt" ? `keychain service ${ALT_KEYCHAIN_SERVICE}` : "TASKHAND_API_KEY / the zcode bigmodel-api channel"}` };
      record("claude", channel, r, cFailed, keys);
      if (route.model) break; // pinned model: fail is fail — no channel switch, no engine switch
      if (cFailed(r) && (looksRateLimited(r) || (channel === "magpie" && !r.timedOut && looksUnreachable(r))) && channel !== channels.at(-1)) continue;
      break;
    }
    return { r, channel, keys };
  }

  let out;
  if (engine === "zcode") out = { engine: "zcode", ...(await runZcodeEngine()) };
  else if (engine === "claude") out = { engine: "claude", ...(await runClaudeEngine()) };
  else {
    // auto: claude starts on the second key; if the primary key also rate-limits, give up (zcode draws
    // on the same quota — falling back there hits the same wall). Only non-rate-limit, non-timeout
    // failures go to zcode; a claude timeout fails outright.
    const c = await runClaudeEngine();
    // No zcode on this machine (no ZCode.app/provider config): no fallback, return the claude failure as-is
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
      ? (route.model ? `pinned model ${route.model} failed: ` : "")
        + (r.timedOut ? `timeout (${Math.round(timeoutMs / 60_000)} min, force-killed — the worker had been working this long; not a model or channel failure): ` : "")
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
  if (!kinds.has(opts.kind)) die(`--kind must be one of ${[...kinds].join("|")}`);
  appendLog({ kind: opts.kind, task: opts.task ?? null, unit: opts.unit ?? null, project: opts.project ?? null, detail: opts.detail ?? null });
  process.stdout.write("logged\n");
}

export function summarizeLog(rows, days) {
  const since = Date.now() - Number(days ?? 14) * 86_400_000;
  rows = rows.filter((e) => Date.parse(e.ts) >= since);
  const count = (k) => rows.filter((e) => e.kind === k).length;
  const d = rows.filter((e) => e.kind === "dispatch");
  // Health per engine; records older than the engine field are all zcode-era. rework = a resumed order.
  const byEngine = {};
  for (const e of d) {
    const b = byEngine[e.engine ?? "zcode"] ??= { dispatches: 0, failed: 0, rateLimited: 0, rework: 0 };
    b.dispatches++;
    if (!e.ok) b.failed++;
    if (e.rateLimited) b.rateLimited++;
    if (e.resume) b.rework++;
  }
  // Rework rate per order: only records with both task and unit count; old records without unit are ignored.
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
  if (!existsSync(LOG_FILE)) return process.stdout.write("no entries yet\n");
  const rows = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  process.stdout.write(JSON.stringify(summarizeLog(rows, opts.days), null, 2) + "\n");
}

// CLI entry only runs when executed directly: hosts import this module for its exports, which must not
// run the CLI as a side effect.
// argv[1] may be a symlink (the install dir points back at the source repo), realpath both sides first (same as taskhand-guard.mjs).
try {
  if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
    const opts = parseArgs(process.argv.slice(2));
    const cmd = opts._[0];
    if (cmd === "dispatch") await dispatch(opts);
    else if (cmd === "note") note(opts);
    else if (cmd === "log") showLog(opts);
    else die("usage: taskhand.mjs dispatch|note|log — see README.md");
  }
} catch { /* argv[1] missing etc.: don't run the CLI */ }
