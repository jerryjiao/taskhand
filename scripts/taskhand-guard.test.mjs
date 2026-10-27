// taskhand-guard.mjs 的测试：分类用 check() 直接判（cwd 只做字符串比较，目录不必存在），
// hook 协议（exit 2 / 放行无输出 / 解析失败放行）用 spawn 喂 stdin 验证。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { check } from "./taskhand-guard.mjs";

const CWD = "/tmp/lg-guard-fake-wt";

const BLOCK = [
  // force push 各种写法（flag 在前在后、-C / -c 前缀、refspec 加号开头）
  "git push --force",
  "git push -f origin main",
  "git push --force-with-lease origin main",
  "git push --force-with-lease=main:abc origin main",
  "git push --force-if-includes origin main",
  "git push origin +main",
  "git push origin +HEAD:main",
  "git push origin main --force",
  "git -C ../other push --force",
  "git -c http.sslVerify=false push -f",
  // 删远端分支/标签
  "git push --delete origin main",
  "git push -d origin main",
  "git push origin :feature/x",
  // 删本地分支
  "git branch -d main",
  "git branch -D main",
  "git branch --delete main",
  "git -C .. branch -d main",
  // .env 读写（.env.<任意> 拦，模板后缀放行在 ALLOW）
  "cat .env",
  "cat ./.env.local",
  "cp apps/x/.env.production /tmp/",
  "source .env.staging",
  "dotenv -e .env.test -- npm test",
  "rm -rf ./.env",
  // 钥匙串
  "security find-generic-password -s x -w",
  "/usr/bin/security find-generic-password -s x -w",
  // 对外发包
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "yarn npm publish",
  "bun publish",
  "npx np publish",
  "twine upload dist/*",
  "gem push pkg/x.gem",
  "cargo publish",
  "poetry publish",
  "uv publish",
  // rm 递归删越出 worktree
  "rm -rf /",
  "rm -fr ~",
  "rm -r $HOME",
  "rm --recursive /usr",
  "rm -rf *",
  "rm -rf ../outside",
  'rm -rf "$HOME/x"',
  "rm -rf /tmp/lg-guard-fake-wt-sub",
  // 包装前缀绕过（第 1 轮打回实测）：赋值、sudo、env、command、xargs、find
  "0 | sudo rm -rf /",
  "GIT_TRACE=1 git push --force",
  "env git push --force",
  "env VAR=1 sudo git push -f",
  "command git push -f",
  "nohup git push -f",
  "exec git push --force",
  "time git push -f",
  "nice git push -f",
  "timeout 60 git push -f",
  "doas rm -rf /",
  "sudo -u www rm -rf /tmp/lg-guard-outside",
  "xargs rm -rf < list",
  "xargs -0 rm -rf",
  "xargs -n 1 rm -rf /",
  // 短选项合并拆开判
  "git push -fd origin x",
  "git push -uf origin x",
  "git branch -Dv main",
  "rm -Rf /usr",
  "rm -fR /usr",
  "rm -rfv ../outside",
  // rm 目标带引号（剥引号后越界）
  "rm -rf '$HOME'",
  "rm -rf ${HOME}/x",
  'rm -rf "~/x"',
  // cd 出 worktree 后的相对 rm/find（第 2 轮打回）
  "cd /tmp && rm -rf foo",
  "cd .. && rm -rf x",
  "cd - && rm -rf x",
  "cd ~ ; rm -r foo",
  "pushd /var && rm -rf log",
  "cd /tmp && find . -name x -delete",
  // find 越界删
  "find / -name x -delete",
  "find ~ -name x -delete",
  "find .. -name '*.tmp' -execdir rm {} \\;",
  "find / -name x -exec rm {} \\;",
  // 复合命令里的危险片段、嵌套、切不干净的兜底
  "npm test && git push --force",
  'bash -c "git push -f"',
  "bash -c 'git push -f'",
  'echo "$(git push -f)"',
  "echo $(git push origin :main)",
  "git commit -m ok; git push --force",
  "git push -f \"unclosed",
];

const ALLOW = [
  "git push",
  "git push origin taskhand/x",
  "git push -u origin main",
  "git push origin main:main",
  "git -C . push origin main",
  "git branch",
  "git branch -a",
  'git commit -m "fix --force flag doc"',
  'git commit -m "update .env handling"',
  "npm test",
  "npm run build",
  "cat .env.example",
  "cat .env.sample",
  "cat .env.template",
  "grep -r env src",
  "rm -rf dist",
  "rm -rf node_modules dist",
  "rm -rf dist/*",
  "rm file.txt",
  "rm -f file.txt",
  "echo security", // 选了放行：security 是 echo 的参数不是命令本体，只拦真正调钥匙串的

  "cargo test",
  "uv run pytest",
  "npx prettier --write .",
  "cat <<'EOF'\nsecurity\nEOF",
  "npm run build && git push origin taskhand/x",
  "ls -la",
  // 壳命令的正常用法不拦（第 1 轮打回补充）
  "sudo -n true",
  "sudo -n git push -u origin x",
  "env NODE_ENV=test npm test",
  "timeout 60 npm test",
  "xargs -n1 echo",
  "time npm test",
  "find . -name x -delete",
  "find . -name '*.tmp' -delete",
  "rm -rf ./build",
  "cd src && rm -rf dist",
  "cd src && find . -name x -delete",
];

for (const cmd of BLOCK) test(`拦：${cmd}`, () => assert.notEqual(check(cmd, CWD), null));
for (const cmd of ALLOW) test(`放：${cmd}`, () => assert.equal(check(cmd, CWD), null));

// hook 协议：真进程喂 stdin，验证 exit code、stderr、无输出。
const GUARD = join(dirname(fileURLToPath(import.meta.url)), "taskhand-guard.mjs");
// 宿主可能设了 LOOP_GUARD_ROOT，rm 边界会被换成指定根；
// 协议测试验的是默认边界（hook 输入的 cwd），显式剥掉；宿主模式测试用 runLoop 自己设。
const plainEnv = { ...process.env };
delete plainEnv.LOOP_GUARD_ROOT;
const run = (stdin, entry = GUARD) => spawnSync(process.execPath, [entry], { input: stdin, encoding: "utf8", env: plainEnv });

test("协议：拦 → exit 2 + stderr 中文原因，stdout 无输出", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: CWD }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /守卫/);
  assert.equal(r.stdout, "");
});

test("协议：放行 → exit 0 无任何输出", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: CWD }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("协议：非 Bash 工具直接放行", () => {
  const r = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x/.env" } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("协议：stdin 不是 JSON → 放行", () => {
  const r = run("not json at all");
  assert.equal(r.status, 0);
});

test("协议：空 stdin → 放行", () => {
  const r = run("");
  assert.equal(r.status, 0);
});

test("协议：rm 的越界判定用 hook 输入的 cwd（cwd 内绝对路径放行）", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: `rm -rf ${CWD}/dist` }, cwd: CWD }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("协议：argv[1] 走软链也能进 hook（realpath 后比对；测试只删自己建的临时软链）", () => {
  const dir = mkdtempSync(join(tmpdir(), "lg-guard-link-"));
  try {
    const link = join(dir, "guard-link");
    symlinkSync(GUARD, link);
    const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" }, cwd: CWD }), link);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /守卫/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("协议：连续 50 次 spawn 喂 git push -f 全部 exit 2（stdin 异步读不再偶发放行）", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" }, cwd: CWD });
  for (let i = 0; i < 50; i++) {
    const r = run(payload);
    assert.equal(r.status, 2, `第 ${i + 1} 次返回 ${r.status}（stderr: ${r.stderr.trim()}）`);
  }
});

test("协议：cd 跟踪走子进程也生效（cd /tmp && rm -rf foo → exit 2）", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cd /tmp && rm -rf foo" }, cwd: CWD }));
  assert.equal(r.status, 2);
});

// —— 宿主模式：LOOP_GUARD_ROOT 把 rm/find 边界从 worktree 换成指定根（默认不带变量，行为不变） ——

const WS = mkdtempSync(join(tmpdir(), "taskhand-guard-ws-"));
after(() => rmSync(WS, { recursive: true, force: true }));
const runLoop = (command) =>
  spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: WS }),
    encoding: "utf8",
    env: { ...process.env, LOOP_GUARD_ROOT: WS },
  });

test("宿主模式：根内递归 rm 放行（含相对路径按根起算），根外照拦", () => {
  const inside = runLoop("rm -rf " + WS + "/loop/tmp-x");
  assert.equal(inside.status, 0);
  const rel = runLoop("rm -rf loop/tmp-x");
  assert.equal(rel.status, 0);
  const outside = runLoop("rm -rf /tmp/loop-outside");
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /守卫/);
});

test("宿主模式：守卫其他规则不受影响——force push 照拦、.env 照拦、git push 照放", () => {
  assert.equal(runLoop("git push --force").status, 2);
  assert.equal(runLoop("cat .env").status, 2);
  assert.equal(runLoop("git push origin main").status, 0);
});

