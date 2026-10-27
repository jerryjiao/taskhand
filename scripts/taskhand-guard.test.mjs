// taskhand-guard.mjs tests: classification goes through check() directly (cwd is only compared as a
// string, the directory needn't exist); the hook protocol (exit 2 / silent allow / allow on parse
// failure) is verified by spawning with stdin.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { check } from "./taskhand-guard.mjs";

const CWD = "/tmp/taskhand-guard-fake-wt";

const BLOCK = [
  // force push in every spelling (flag before/after, -C / -c prefixes, plus-prefixed refspecs)
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
  // deleting remote branches/tags
  "git push --delete origin main",
  "git push -d origin main",
  "git push origin :feature/x",
  // deleting local branches
  "git branch -d main",
  "git branch -D main",
  "git branch --delete main",
  "git -C .. branch -d main",
  // .env reads/writes (.env.<anything> blocked; template suffixes allowed, see ALLOW)
  "cat .env",
  "cat ./.env.local",
  "cp apps/x/.env.production /tmp/",
  "source .env.staging",
  "dotenv -e .env.test -- npm test",
  "rm -rf ./.env",
  // keychain
  "security find-generic-password -s x -w",
  "/usr/bin/security find-generic-password -s x -w",
  // publishing
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
  // recursive rm escaping the worktree
  "rm -rf /",
  "rm -fr ~",
  "rm -r $HOME",
  "rm --recursive /usr",
  "rm -rf *",
  "rm -rf ../outside",
  'rm -rf "$HOME/x"',
  "rm -rf /tmp/taskhand-guard-fake-wt-sub",
  // wrapper-prefix bypasses (from a real rework round): assignment, sudo, env, command, xargs, find
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
  "sudo -u www rm -rf /tmp/taskhand-outside",
  "xargs rm -rf < list",
  "xargs -0 rm -rf",
  "xargs -n 1 rm -rf /",
  // bundled short flags, split and judged per letter
  "git push -fd origin x",
  "git push -uf origin x",
  "git branch -Dv main",
  "rm -Rf /usr",
  "rm -fR /usr",
  "rm -rfv ../outside",
  // rm targets in quotes (escape after stripping quotes)
  "rm -rf '$HOME'",
  "rm -rf ${HOME}/x",
  'rm -rf "~/x"',
  // relative rm/find after cd-ing out of the worktree (second rework round)
  "cd /tmp && rm -rf foo",
  "cd .. && rm -rf x",
  "cd - && rm -rf x",
  "cd ~ ; rm -r foo",
  "pushd /var && rm -rf log",
  "cd /tmp && find . -name x -delete",
  // find deletes from outside
  "find / -name x -delete",
  "find ~ -name x -delete",
  "find .. -name '*.tmp' -execdir rm {} \\;",
  "find / -name x -exec rm {} \\;",
  // dangerous fragments inside compound commands, nesting, unparseable fallbacks
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
  "echo security", // deliberate: security is echo's argument, not the command — only real keychain calls block

  "cargo test",
  "uv run pytest",
  "npx prettier --write .",
  "cat <<'EOF'\nsecurity\nEOF",
  "npm run build && git push origin taskhand/x",
  "ls -la",
  // normal shell-runner usage doesn't block (first rework round)
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

for (const cmd of BLOCK) test(`blocks: ${cmd}`, () => assert.notEqual(check(cmd, CWD), null));
for (const cmd of ALLOW) test(`allows: ${cmd}`, () => assert.equal(check(cmd, CWD), null));

// Hook protocol: real process, stdin fed, verify exit code, stderr, no output.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), "taskhand-guard.mjs");
// The host may have set LOOP_GUARD_ROOT, which swaps the rm boundary to that root; the protocol tests
// verify the default boundary (the hook input's cwd), so strip it explicitly; host-mode tests set it
// themselves via runLoop.
const plainEnv = { ...process.env };
delete plainEnv.LOOP_GUARD_ROOT;
const run = (stdin, entry = GUARD) => spawnSync(process.execPath, [entry], { input: stdin, encoding: "utf8", env: plainEnv });

test("protocol: block → exit 2 + English reason on stderr, no stdout", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: CWD }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /guard/);
  assert.equal(r.stdout, "");
});

test("protocol: allow → exit 0 with no output at all", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: CWD }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("protocol: non-Bash tools pass through", () => {
  const r = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x/.env" } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("protocol: non-JSON stdin → allow", () => {
  const r = run("not json at all");
  assert.equal(r.status, 0);
});

test("protocol: empty stdin → allow", () => {
  const r = run("");
  assert.equal(r.status, 0);
});

test("protocol: rm boundary uses the hook input's cwd (absolute inside cwd allows)", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: `rm -rf ${CWD}/dist` }, cwd: CWD }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("protocol: argv[1] via symlink still enters the hook (realpath compare; test only removes its own temp symlink)", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskhand-guard-link-"));
  try {
    const link = join(dir, "guard-link");
    symlinkSync(GUARD, link);
    const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" }, cwd: CWD }), link);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /guard/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protocol: 50 consecutive spawns feeding git push -f all exit 2 (async stdin read no longer sporadically allows)", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" }, cwd: CWD });
  for (let i = 0; i < 50; i++) {
    const r = run(payload);
    assert.equal(r.status, 2, `attempt ${i + 1} returned ${r.status} (stderr: ${r.stderr.trim()})`);
  }
});

test("protocol: cd tracking works across the child process too (cd /tmp && rm -rf foo → exit 2)", () => {
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cd /tmp && rm -rf foo" }, cwd: CWD }));
  assert.equal(r.status, 2);
});

// —— host mode: LOOP_GUARD_ROOT moves the rm/find boundary from the worktree to the given root (variable unset = unchanged) ——

const WS = mkdtempSync(join(tmpdir(), "taskhand-guard-ws-"));
after(() => rmSync(WS, { recursive: true, force: true }));
const runLoop = (command) =>
  spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: WS }),
    encoding: "utf8",
    env: { ...process.env, LOOP_GUARD_ROOT: WS },
  });

test("host mode: recursive rm inside the root allows (relative paths resolve against the root), outside still blocks", () => {
  const inside = runLoop(`rm -rf ${WS}/loop/tmp-x`);
  assert.equal(inside.status, 0);
  const rel = runLoop("rm -rf loop/tmp-x");
  assert.equal(rel.status, 0);
  const outside = runLoop("rm -rf /tmp/taskhand-loop-outside");
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /guard/);
});

test("host mode: other guard rules unaffected — force push still blocks, .env still blocks, plain git push still allows", () => {
  assert.equal(runLoop("git push --force").status, 2);
  assert.equal(runLoop("cat .env").status, 2);
  assert.equal(runLoop("git push origin main").status, 0);
});
