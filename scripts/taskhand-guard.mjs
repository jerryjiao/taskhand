#!/usr/bin/env node
// Worker (taskhand) bash guard — a PreToolUse hook for claude -p. --disallowedTools matches prefixes
// only and misses dangerous fragments inside compound commands; this hook splits the whole command
// into subcommand segments and judges each. Covers: force push, deleting remote branches/tags,
// deleting local branches, reading/writing .env, the keychain (security), publishing packages, and
// recursive rm / find deletes outside the worktree; wrapper prefixes (sudo/env/xargs/…) are stripped
// before judging.
// rm/find default to the cwd (the worktree) as boundary; env LOOP_GUARD_ROOT swaps in a different root.
// Protocol: stdin takes {tool_name, tool_input:{command}, cwd}; block → exit 2 + a one-line English
// reason on stderr (visible to the worker); allow → exit 0 with no output; if the guard itself errors
// (including JSON parse failures) it always exits 0 to allow — it must never wedge the worker.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// —— rough splitting: pairs quotes / $() / backticks only; on any pairing failure return -1/null and the caller judges the whole command ——

// Where a double quote closes: handles backslash escapes, skips nested $() and backticks inside
// (quotes inside those don't close this one).
function closeDq(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { const k = s.indexOf("`", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === "$" && s[j + 1] === "(") { const k = matchParen(s, j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') return j;
  }
  return -1;
}

// The ")" matching s[i] ("("): handles nesting; parens inside quotes don't count.
function matchParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') { const k = closeDq(s, j); if (k < 0) return -1; j = k; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

// Split the command on operators (&& || & ; | newline); $() and backtick bodies are subcommands of
// their own — emit them as separate segments too.
function segments(cmd) {
  const segs = [];
  let cur = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") { const j = cmd.indexOf("'", i + 1); if (j < 0) return null; cur += cmd.slice(i, j + 1); i = j; continue; }
    if (c === '"') { const j = closeDq(cmd, i); if (j < 0) return null; cur += cmd.slice(i, j + 1); i = j; continue; }
    if (c === "`") { const j = cmd.indexOf("`", i + 1); if (j < 0) return null; segs.push(cur, cmd.slice(i + 1, j)); cur = ""; i = j; continue; }
    if (c === "$" && cmd[i + 1] === "(") { const j = matchParen(cmd, i + 1); if (j < 0) return null; segs.push(cur, cmd.slice(i + 2, j)); cur = ""; i = j; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|") { segs.push(cur); cur = ""; if ((c === "&" || c === "|") && cmd[i + 1] === c) i++; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

// Split a segment into words: strip quotes, remember sq/dq. Single-quoted text is literal; double
// quotes expand (rm targets must be judged with their double-quoted words too).
function words(seg) {
  const out = [];
  let i = 0;
  for (;;) {
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) return out;
    let text = "", sq = false, dq = false;
    while (i < seg.length && !/\s/.test(seg[i])) {
      const c = seg[i];
      if (c === "'") { const j = seg.indexOf("'", i + 1); if (j < 0) return null; text += seg.slice(i + 1, j); sq = true; i = j + 1; continue; }
      if (c === '"') { const j = closeDq(seg, i); if (j < 0) return null; text += seg.slice(i + 1, j); dq = true; i = j + 1; continue; }
      if (c === "$" && seg[i + 1] === "(") { const j = matchParen(seg, i + 1); if (j < 0) return null; text += seg.slice(i, j + 1); i = j + 1; continue; }
      if (c === "`") { const j = seg.indexOf("`", i + 1); if (j < 0) return null; text += seg.slice(i, j + 1); i = j + 1; continue; }
      text += c; i++;
    }
    out.push({ text, sq, dq });
  }
}

// Heredoc: the segments after a << delimiter are data, not commands — skip to the terminator so plain
// words in the body don't get falsely blocked.
function skipHeredoc(segs) {
  const out = [];
  let delim = null;
  for (const seg of segs) {
    if (delim !== null) { if (seg.trim() === delim) delim = null; continue; }
    const m = seg.match(/<<-?\s*(['"]?)([\w.-]+)\1\s*$/);
    if (m) delim = m[2];
    out.push(seg);
  }
  return out;
}

// When quotes don't pair: blank out all quoted spans and judge the rest (the real shell can't run it
// either; blanking keeps us safe — prefer false blocks over misses).
function stripQuotes(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = s.indexOf(c, i + 1); i = j < 0 ? s.length : j + 1; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

// —— judging each danger class: by word, never by substring, so literal samples in messages/comments don't trip it ——

// .env segment: ".env" itself or ".env.<anything>"; example/sample/template are templates, allowed.
function envSegBad(seg) {
  if (seg === ".env") return true;
  if (!seg.startsWith(".env.")) return false;
  return !["example", "sample", "template"].includes(seg.slice(5).toLowerCase());
}

// Split bundled short flags and judge per letter: -fd, -uf, -Dv; a word with quotes stripped is the
// real word the shell passes on, so it participates too.
const bundle = (t) => (/^-[a-z]+$/i.test(t) ? t.slice(1).toLowerCase() : "");
const base = (t) => (t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t);
const isForceFlag = (t) => t === "--force" || t === "--force-if-includes" || t.startsWith("--force-with-lease") || bundle(t).includes("f");
// A refspec starting with "+" is a force push (+main, +HEAD:main); starting with ":" deletes a remote ref.
const isForceRef = (t) => t.startsWith("+");
const isDeleteRef = (t) => t === "--delete" || t.startsWith(":") || bundle(t).includes("d");

// git global options with values swallow the next token before the subcommand: git -C x push,
// git -c k=v push all count as push.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function gitReason(texts) {
  let i = 1;
  while (i < texts.length && (GIT_GLOBAL_WITH_VALUE.has(texts[i]) || /^(--git-dir|--work-tree|--namespace)=/.test(texts[i])))
    i += GIT_GLOBAL_WITH_VALUE.has(texts[i]) ? 2 : 1;
  const sub = texts[i], rest = texts.slice(i + 1);
  if (sub === "push") {
    if (rest.some(isForceFlag) || rest.some(isForceRef)) return "force push is not allowed (rewriting remote history is off-limits)";
    if (rest.some(isDeleteRef)) return "deleting remote branches/tags is not allowed (git push --delete / :ref)";
  } else if (sub === "branch") {
    if (rest.some(isDeleteRef)) return "deleting local branches is not allowed (git branch -d/-D)";
  }
  return null;
}

// Publishing is an outbound action — never allowed unattended.
function publishReason(cmd0, bare) {
  const rest = bare.slice(1);
  if (["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv"].includes(cmd0) && rest.includes("publish"))
    return `publishing packages is not allowed (${cmd0} publish)`;
  if ((cmd0 === "npx" || cmd0 === "pnpx") && rest.includes("np") && rest.includes("publish"))
    return "publishing packages is not allowed (npx np publish)";
  if (cmd0 === "twine" && rest.includes("upload")) return "publishing packages is not allowed (twine upload)";
  if (cmd0 === "gem" && rest.includes("push")) return "publishing packages is not allowed (gem push)";
  return null;
}

// ~, $HOME and ${HOME} prefixes become absolute home paths before comparing (pure string math, no fs).
function expandHome(t) {
  if (t === "~" || t.startsWith("~/")) return homedir() + t.slice(1);
  if (t === "$HOME" || t.startsWith("$HOME/")) return homedir() + t.slice(5);
  if (t === "${HOME}" || t.startsWith("${HOME}/")) return homedir() + t.slice(7);
  return t;
}

// Does the target escape the worktree? Relative targets resolve against the "effective cwd" (cd
// changes it), then compare with the original worktree boundary; pure string math.
function outside(root, eff, t) {
  if (t === "*") return true;
  const abs = expandHome(t);
  if (abs.startsWith("/")) {
    const rel = relative(root, abs);
    return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
  }
  if (!eff) return true; // after `cd -` the directory is unknown: rather block relative paths
  const rel = relative(root, resolve(eff, abs));
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
}

// Recursive rm is only allowed inside the worktree; a quoted target/flag, quotes stripped, is the real
// word rm receives — judge it too.
function rmReason(ws, root, viaXargs, eff) {
  let recursive = false, onlyPaths = false;
  const targets = [];
  for (const w of ws.slice(1)) {
    const t = w.text;
    if (!onlyPaths && t === "--") { onlyPaths = true; continue; }
    if (!onlyPaths && t.startsWith("-") && t.length > 1) {
      if (t === "--recursive" || (!t.startsWith("--") && /^-[a-z]*r/i.test(t))) recursive = true;
      continue;
    }
    targets.push(t);
  }
  if (!recursive) return null;
  if (viaXargs) return "xargs recursive delete: targets come from a stream, can't guarantee they stay inside the worktree";
  for (const t of targets) {
    if (t === "*") return "rm -r target is * (whole-directory glob; mass deletion is off-limits)";
    if (outside(root, eff, t)) return `rm -r target escapes the worktree (${t})`;
  }
  return null;
}

// find deletes: block only when a start point lies outside the worktree AND -delete / -exec(rm) is
// present; cleaning temp files inside the worktree is fine.
function findReason(ws, root, eff) {
  const texts = ws.map((w) => w.text);
  let i = 1;
  while (i < texts.length && ["-H", "-L", "-P"].includes(texts[i])) i++;
  const starts = [];
  let deleteish = false;
  for (; i < texts.length; i++) {
    const t = texts[i];
    if (t === "-delete" || ((t === "-exec" || t === "-execdir") && base(texts[i + 1] ?? "") === "rm")) deleteish = true;
    if (starts.length === 0 && !t.startsWith("-") && t !== "(" && !t.startsWith("\\(") && t !== "!") starts.push(t);
  }
  if (!deleteish || !starts.length) return null;
  return starts.some((p) => outside(root, eff, p)) ? `find deletes from outside the worktree (start point ${starts.join(" ")})` : null;
}

// Wrapper prefixes, stripped in a loop: VAR=val, sudo/doas/env/command/builtin/exec/nohup/time/nice/
// timeout/xargs — each with its own options (value flags swallow their values, table below); what
// remains is the real command.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "timeout", "xargs"]);
const WRAP_VALUE_FLAGS = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-R", "-T", "-D"]),
  doas: new Set(["-u"]),
  env: new Set(),
  nice: new Set(["-n"]),
  timeout: new Set(["-k"]),
  xargs: new Set(["-I", "-L", "-P", "-s", "-E", "-a", "-n"]),
};

function stripWrappers(ws) {
  let i = 0, xargs = false;
  for (;;) {
    const t = ws[i]?.text ?? "";
    if (!t) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (!WRAPPERS.has(t)) break;
    if (t === "xargs") xargs = true;
    const valFlags = WRAP_VALUE_FLAGS[t] ?? new Set();
    i++;
    while (i < ws.length) {
      const o = ws[i].text;
      if (o === "--") { i++; break; }
      if (o.startsWith("-") && o.length > 1) { i += valFlags.has(o) && i + 1 < ws.length ? 2 : 1; continue; }
      if (t === "timeout" && /^\d/.test(o)) { i++; continue; } // duration: 60, 60s, 1h30m
      break;
    }
  }
  return { start: i, xargs };
}

// Judge one subcommand segment: first scan the args for .env (quoted words count — the shell strips
// quotes before the command sees them), then strip wrapper prefixes and dispatch on the real command.
// Commit messages survive because the structure matters: only the flag regions of push/branch are
// scanned, words after -m are ignored.
// After cd/pushd, relative paths in later segments are no longer worktree-relative: track an
// "effective cwd".
// Returns undefined = not a cd; null = directory unknown (cd -, bare pushd); string = resolved new dir.
function cdTarget(ws, eff) {
  const texts = ws.map((w) => w.text);
  if (texts[0] !== "cd" && texts[0] !== "pushd") return undefined;
  const args = texts.slice(1).filter((t) => !/^-[LPE]$/.test(t)); // cd options take no value
  if (!args.length) return texts[0] === "pushd" ? null : homedir(); // bare cd → HOME; bare pushd → dir stack, unknown
  const p = expandHome(args[0]);
  if (p.startsWith("/")) return p;
  if (args[0] === "-") return null;
  return eff ? resolve(eff, p) : null;
}

function checkWords(ws, root, eff) {
  for (const w of ws) {
    if (w.text.split("/").some(envSegBad)) return 'reading/writing .env is not allowed (credentials are off-limits; .env.example/.env.sample/.env.template are fine)';
  }
  const { start, xargs } = stripWrappers(ws);
  const rest = ws.slice(start);
  if (!rest.length) return null;
  const texts = rest.map((w) => w.text);
  const cmd0 = base(texts[0]);
  if (cmd0 === "security") return "keychain access is not allowed (the security command)";
  const pub = publishReason(cmd0, texts);
  if (pub) return pub;
  if (cmd0 === "git") return gitReason(texts);
  if (cmd0 === "rm") return rmReason(rest, root, xargs, eff);
  if (cmd0 === "find") return findReason(rest, root, eff);
  return null;
}

// $() and backtick text inside quoted words (command substitution inside double quotes — segments()
// skipped it as part of the quoted span).
function substSpans(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") { const j = s.indexOf("`", i + 1); if (j < 0) break; out.push(s.slice(i + 1, j)); i = j; continue; }
    if (s[i] === "$" && s[i + 1] === "(") { const j = matchParen(s, i + 1); if (j < 0) break; out.push(s.slice(i + 2, j)); i = j; continue; }
  }
  return out;
}

// Whole command: split into segments and judge each; inside quoted words only two kinds of text are
// real command text worth recursing into — $()/backtick substitutions and quoted args of shell
// runners (bash -c "…", eval); any other quoted word is data (commit message, filename) and is not
// judged, so literal samples in messages don't trip the guard.
// Unpaired quotes/parens: blank all quoted spans and judge what's left (prefer false blocks over misses).
function check(cmd, cwd, depth = 0, eff = cwd) {
  if (depth > 8 || typeof cmd !== "string" || !cmd) return null;
  const segs = segments(cmd);
  if (segs === null) return depth === 0 ? check(stripQuotes(cmd), cwd, depth + 1, eff) : null;
  for (const seg of skipHeredoc(segs)) {
    const ws = words(seg);
    if (ws === null) return depth === 0 ? check(stripQuotes(cmd), cwd, depth + 1, eff) : null;
    const reason = checkWords(ws, cwd, eff);
    if (reason) return reason;
    const next = cdTarget(ws, eff); // after cd, later rm/find resolve against the new directory
    if (next !== undefined) eff = next;
    const bareAll = ws.filter((w) => !w.sq && !w.dq).map((w) => w.text);
    const first = bareAll[0]?.split("/").pop();
    const runner = first === "eval" ||
      (["bash", "sh", "zsh", "dash", "ksh", "sudo"].includes(first) && bareAll.includes("-c"));
    for (const w of ws) {
      if (!w.sq && !w.dq) continue;
      for (const span of substSpans(w.text)) {
        const nested = check(span, cwd, depth + 1, eff);
        if (nested) return nested;
      }
      if (runner) {
        const nested = check(w.text, cwd, depth + 1, eff);
        if (nested) return nested;
      }
    }
  }
  return null;
}

export { check };

// —— hook entry ——

// Read stdin asynchronously: the pipe is a non-blocking fd and readFileSync(0) sporadically throws
// EAGAIN, which would turn the guard into "allow everything".
// Errors while reading must be loud (one stderr line for debugging); empty/bad input still allows
// silently, per the protocol — never wedge the worker.
async function main() {
  if (process.stdin.isTTY) return;
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    process.stderr.write("guard: failed to read input, allowing\n");
    return;
  }
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (input?.tool_name !== "Bash" || typeof input.tool_input?.command !== "string" || !input.tool_input.command) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  // Host mode (the host sets LOOP_GUARD_ROOT): the guard boundary moves from the worktree to the given
  // root (hosts don't run inside a worktree; recursive rm anywhere inside the root is fair game), and
  // relative paths resolve against that root. Variable unset = dispatch mode, behavior unchanged.
  const root = process.env.LOOP_GUARD_ROOT || cwd;
  const reason = check(input.tool_input.command, root);
  if (reason) {
    process.stderr.write(`guard: ${reason}\n`);
    process.exit(2);
  }
}

// argv[1] may be a symlink (the install dir points back at the source repo); import.meta.url is already
// the real path — realpath both sides before comparing.
try { if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) main().catch(() => {}); }
catch { /* argv[1] missing etc.: don't run, allow */ }
