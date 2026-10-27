#!/usr/bin/env node
// 力工（taskhand）Bash 守卫（claude -p 的 PreToolUse hook）：--disallowedTools 只按前缀匹配，拦不住复合命令里的
// 危险片段，这里按整条命令粗切成子命令逐段判。管：force push、删远端分支/标签、删本地分支、
// 读写 .env、钥匙串（security）、对外发包、worktree 外的递归 rm 和 find 删；包装前缀（sudo/env/xargs 等）剥掉再判。
// rm/find 的边界默认是 cwd（worktree）；环境变量 LOOP_GUARD_ROOT 把边界换成指定根（宿主模式用）。
// 协议：stdin 收 {tool_name, tool_input:{command}, cwd}；拦 → exit 2 + stderr 一行中文原因（力工看得到）；
// 放行 → exit 0 无输出；守卫自己出错（含 JSON 解析失败）一律 exit 0 放行，不能卡死力工。

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// —— 粗切：只做引号 / $() / 反引号配对，配对失败一律返回 -1/null，调用方退回整条判 ——

// 双引号收尾在哪：管反斜杠转义，跳过里面配对的 $() 和反引号（里面再有引号不算收尾）。
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

// 与 s[i]（"("）配对的右括号在哪：管嵌套，引号里的括号不算数。
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

// 按操作符（&& || & ; | 换行）把命令切成段；$() 和反引号里的内容本身就是子命令，单独成段再判。
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

// 段切成词：引号剥掉并记 sq/dq。单引号内容是字面量，双引号会展开（rm 的目标要连双引号词一起判）。
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

// heredoc：<< 分隔符后面的段是数据不是命令，跳到结束符为止，免得正文里的普通词被当成命令误拦。
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

// 引号不配对时用：整段引号内容抹成空格再判（真 shell 也跑不起来，抹掉不漏事，宁可误拦）。
function stripQuotes(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = s.indexOf(c, i + 1); i = j < 0 ? s.length : j + 1; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

// —— 逐类判危险：都按词判，不按子串判，免得 message/注释里的字面样误伤 ——

// .env 段名：.env 本体或 .env.<任意>；example/sample/template 是模板，放行。
function envSegBad(seg) {
  if (seg === ".env") return true;
  if (!seg.startsWith(".env.")) return false;
  return !["example", "sample", "template"].includes(seg.slice(5).toLowerCase());
}

// 短选项合并拆开判：-fd、-uf、-Dv 这类按字母逐个看；引号词剥完引号才是 shell 传给命令的真词，照样参与。
const bundle = (t) => (/^-[a-z]+$/i.test(t) ? t.slice(1).toLowerCase() : "");
const base = (t) => (t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t);
const isForceFlag = (t) => t === "--force" || t === "--force-if-includes" || t.startsWith("--force-with-lease") || bundle(t).includes("f");
// refspec 以 + 开头是强推（+main、+HEAD:main），以 : 开头是删远端（:branch）。
const isForceRef = (t) => t.startsWith("+");
const isDeleteRef = (t) => t === "--delete" || t.startsWith(":") || bundle(t).includes("d");

// git 全局选项带值，吃掉之后才是子命令：git -C x push、git -c k=v push 也算 push。
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function gitReason(texts) {
  let i = 1;
  while (i < texts.length && (GIT_GLOBAL_WITH_VALUE.has(texts[i]) || /^(--git-dir|--work-tree|--namespace)=/.test(texts[i])))
    i += GIT_GLOBAL_WITH_VALUE.has(texts[i]) ? 2 : 1;
  const sub = texts[i], rest = texts.slice(i + 1);
  if (sub === "push") {
    if (rest.some(isForceFlag) || rest.some(isForceRef)) return "不允许 force push（改写远端历史是禁区）";
    if (rest.some(isDeleteRef)) return "不允许删远端分支/标签（git push --delete / :ref）";
  } else if (sub === "branch") {
    if (rest.some(isDeleteRef)) return "不允许删本地分支（git branch -d/-D）";
  }
  return null;
}

// 对外发包是外发动作，无人值守一律不放。
function publishReason(cmd0, bare) {
  const rest = bare.slice(1);
  if (["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv"].includes(cmd0) && rest.includes("publish"))
    return `不允许对外发包（${cmd0} publish）`;
  if ((cmd0 === "npx" || cmd0 === "pnpx") && rest.includes("np") && rest.includes("publish"))
    return "不允许对外发包（npx np publish）";
  if (cmd0 === "twine" && rest.includes("upload")) return "不允许对外发包（twine upload）";
  if (cmd0 === "gem" && rest.includes("push")) return "不允许对外发包（gem push）";
  return null;
}

// ~、$HOME、${HOME} 起头的换成家目录绝对路径再比（纯字符串运算，不碰文件系统）。
function expandHome(t) {
  if (t === "~" || t.startsWith("~/")) return homedir() + t.slice(1);
  if (t === "$HOME" || t.startsWith("$HOME/")) return homedir() + t.slice(5);
  if (t === "${HOME}" || t.startsWith("${HOME}/")) return homedir() + t.slice(7);
  return t;
}

// 目标是否越出 worktree：相对目标按「有效 cwd」（cd 会换）解析，再和原始 worktree 边界比；纯字符串运算。
function outside(root, eff, t) {
  if (t === "*") return true;
  const abs = expandHome(t);
  if (abs.startsWith("/")) {
    const rel = relative(root, abs);
    return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
  }
  if (!eff) return true; // cd - 之后目录未知：相对路径宁可拦
  const rel = relative(root, resolve(eff, abs));
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
}

// rm 递归删只对 worktree 内放行；引号里的目标/flag 剥完引号就是 shell 传给 rm 的真词，照判。
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
  if (viaXargs) return "xargs 递归删：目标来自输入流，担保不了在 worktree 内";
  for (const t of targets) {
    if (t === "*") return "rm -r 目标是 *（整目录通配，删数据禁区）";
    if (outside(root, eff, t)) return `rm -r 目标越出 worktree（${t}）`;
  }
  return null;
}

// find 删文件：起点在 worktree 外又带 -delete / -exec(rm) 的才拦；worktree 里清临时文件随它去。
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
  return starts.some((p) => outside(root, eff, p)) ? `find 从 worktree 外删文件（起点 ${starts.join(" ")}）` : null;
}

// 包装前缀循环剥到底：VAR=val、sudo/doas/env/command/builtin/exec/nohup/time/nice/timeout/xargs，
// 连同各自选项（带值的连值一起吞，见下表）剥完，剩下的才是真命令。
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
      if (t === "timeout" && /^\d/.test(o)) { i++; continue; } // 时长：60、60s、1h30m
      break;
    }
  }
  return { start: i, xargs };
}

// 判一个子命令段：先看参数里有没有 .env（引号里的词也算——shell 剥引号后照样传给命令），
// 剥掉包装前缀后按真命令分发。commit message 不误拦靠的是结构：只扫 push/branch 的 flag 区，-m 后面的词不看。
// cd/pushd 换目录后，后续子命令的相对路径不再以 worktree 为基准：跟踪「有效 cwd」。
// 返回 undefined=不是 cd；null=目录未知（cd -、pushd 无参）；字符串=解析后的新目录。
function cdTarget(ws, eff) {
  const texts = ws.map((w) => w.text);
  if (texts[0] !== "cd" && texts[0] !== "pushd") return undefined;
  const args = texts.slice(1).filter((t) => !/^-[LPE]$/.test(t)); // cd 的选项不带值
  if (!args.length) return texts[0] === "pushd" ? null : homedir(); // cd 无参→HOME；pushd 无参→换目录栈，未知
  const p = expandHome(args[0]);
  if (p.startsWith("/")) return p;
  if (args[0] === "-") return null;
  return eff ? resolve(eff, p) : null;
}

function checkWords(ws, root, eff) {
  for (const w of ws) {
    if (w.text.split("/").some(envSegBad)) return "不允许读写 .env（凭据禁区；.env.example/.env.sample/.env.template 除外）";
  }
  const { start, xargs } = stripWrappers(ws);
  const rest = ws.slice(start);
  if (!rest.length) return null;
  const texts = rest.map((w) => w.text);
  const cmd0 = base(texts[0]);
  if (cmd0 === "security") return "不允许动钥匙串（security 命令）";
  const pub = publishReason(cmd0, texts);
  if (pub) return pub;
  if (cmd0 === "git") return gitReason(texts);
  if (cmd0 === "rm") return rmReason(rest, root, xargs, eff);
  if (cmd0 === "find") return findReason(rest, root, eff);
  return null;
}

// 引号词里的 $() 和反引号内容（双引号里的命令替换，segments() 切段时当成引号整体跳过了）。
function substSpans(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") { const j = s.indexOf("`", i + 1); if (j < 0) break; out.push(s.slice(i + 1, j)); i = j; continue; }
    if (s[i] === "$" && s[i + 1] === "(") { const j = matchParen(s, i + 1); if (j < 0) break; out.push(s.slice(i + 2, j)); i = j; continue; }
  }
  return out;
}

// 整条命令：切段逐段判；引号词里只递归两类真命令文本——$()/反引号替换、壳命令（bash -c "…"、eval）的
// 引号参数；其余引号词是数据（commit message、文件名），不判，免得 message 里的字面样误伤。
// 引号/括号不配对时整条抹掉引号内容再判（宁可误拦不放过）。
function check(cmd, cwd, depth = 0, eff = cwd) {
  if (depth > 8 || typeof cmd !== "string" || !cmd) return null;
  const segs = segments(cmd);
  if (segs === null) return depth === 0 ? check(stripQuotes(cmd), cwd, depth + 1, eff) : null;
  for (const seg of skipHeredoc(segs)) {
    const ws = words(seg);
    if (ws === null) return depth === 0 ? check(stripQuotes(cmd), cwd, depth + 1, eff) : null;
    const reason = checkWords(ws, cwd, eff);
    if (reason) return reason;
    const next = cdTarget(ws, eff); // cd 之后换有效 cwd，后面的 rm/find 按新目录算
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

// —— hook 入口 ——

// 异步读 stdin：管道是非阻塞 fd，readFileSync(0) 会偶发 EAGAIN 把守卫变成「全放行」。
// 读的过程中出错要出声（stderr 记一行便于排查）；输入空/坏 JSON 仍按约定静默放行，不卡死力工。
async function main() {
  if (process.stdin.isTTY) return;
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    process.stderr.write("力工守卫：读取输入失败，已放行\n");
    return;
  }
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (input?.tool_name !== "Bash" || typeof input.tool_input?.command !== "string" || !input.tool_input.command) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  // 宿主模式（宿主设 LOOP_GUARD_ROOT）：守卫边界从 worktree 换成指定根
  // （宿主不在 worktree 里跑，rm -r 根内都该放行），相对路径也按根起算；
  // 变量没设 = 派活模式，行为不变。
  const root = process.env.LOOP_GUARD_ROOT || cwd;
  const reason = check(input.tool_input.command, root);
  if (reason) {
    process.stderr.write(`力工守卫：${reason}\n`);
    process.exit(2);
  }
}

// argv[1] 可能是软链（安装目录指回源仓库），import.meta.url 已是真实路径，两边 realpath 后再比。
try { if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) main().catch(() => {}); }
catch { /* argv[1] 不存在等情况：不运行，放行 */ }



