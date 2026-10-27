# taskhand

<p align="center">
  <img src="assets/logo.svg" width="128" alt="taskhand logo">
</p>

Dispatch coding **work orders** to headless AI coding agents (Claude Code) in isolated **git worktrees** — with a bash-command guard hook and evidence-based acceptance.

You act as the orchestrator: write a small, focused order, and `taskhand` runs it in a headless `claude -p` session confined to a dedicated worktree, then hands back a JSON envelope with the session id, token usage, and the worker's report. Orders that can't be verified by a command get bounced before they ever reach a model.

Extracted from a personal multi-agent production system and open-sourced as-is, with everything workspace-specific removed.

## What's in the box

| File | What it does |
|---|---|
| `scripts/taskhand.mjs` | Dispatcher/runner CLI: `dispatch`, `note`, `log` |
| `scripts/taskhand-guard.mjs` | `PreToolUse` hook — parses whole bash commands and blocks dangerous fragments |
| `scripts/order-check.mjs` | Work-order sanity check: bounces oversized, untestable, or sequential orders |
| `SKILL.md` | Claude Code skill manifest (install the repo as a skill to let an agent drive it) |

No dependencies. Node ≥ 20.

## The safety model

A headless agent with `--dangerously-skip-permissions` is only safe if the rails are real. taskhand stacks four layers:

1. **Worktree isolation** — every order runs in its own worktree; the worker never touches your checkout.
2. **Claude deny list** — `--disallowedTools` blocks force push, branch deletion, `security` (macOS keychain), and `.env` reads/writes by prefix.
3. **The guard hook** (`taskhand-guard.mjs`) — deny lists match prefixes; `x && git push -f` walks right past them. The guard splits the whole command into segments (`&&`, `;`, `|`, `$()`, backticks, `bash -c "…"`, heredocs), strips wrapper prefixes (`sudo`, `env`, `xargs`, `timeout`, `VAR=1`, …), tracks `cd`, and judges each real subcommand. It blocks:
   - force push (including `+ref` refspecs, bundled flags like `-fd`, `--force-with-lease`)
   - deleting remote refs (`git push --delete`, `:branch`) or local branches
   - reading/writing `.env*` (`.env.example/.sample/.template` allowed)
   - macOS keychain access (`security …`)
   - publishing packages (`npm/pnpm/yarn/bun/cargo/poetry/uv publish`, `twine upload`, `gem push`)
   - recursive `rm` and destructive `find` targeting outside the worktree (or `*`)
   When it blocks, the worker sees a one-line Chinese reason on stderr. When the guard itself can't parse input, it fails open — a wedged hook is worse than a missed block.
4. **The order format** — every order carries an explicit Off-limits section, machine-checkable acceptance criteria, and strict size limits. Untrusted material (logs, web pages, error text) is wrapped in `::UNTRUSTED` blocks so the worker treats it as data, not instructions.

## Quickstart

```bash
git clone https://github.com/jerryjiao/taskhand && cd taskhand
npm test                 # 163 tests, no deps

# optional: expose as a Claude Code skill
ln -s "$PWD" ~/.claude/skills/taskhand
```

Point it at any Anthropic-compatible endpoint:

```bash
export TASKHAND_API_KEY=sk-...      # primary key
export TASKHAND_BASE_URL=https://api.anthropic.com   # any Anthropic-compatible endpoint
# (default endpoint is Zhipu's bigmodel Anthropic-compatible API — the author's setup;
#  if you use that Coding Plan, you only need the key)
```

Write an order (see format below), give the worker a worktree, dispatch:

```bash
git -C ~/code/myrepo worktree add -b taskhand/fix-1 ~/.taskhand/wt-myrepo-fix-1 main

node scripts/taskhand.mjs dispatch \
  --cwd ~/.taskhand/wt-myrepo-fix-1 \
  --prompt-file fix-1.task.md \
  --task fix-1 --unit 1
```

`dispatch` runs the order check first (oversized orders are bounced with a problem list — split them, or pass `--skip-check`), then prints a JSON envelope:

```json
{ "ok": true, "sessionId": "…", "response": "…", "usage": { "inputTokens": …, "outputTokens": … },
  "engine": "claude", "channel": "primary", "steps": [...], "durationMs": … }
```

**Verify yourself**: run the acceptance checks in the worktree and read `git diff <base>..HEAD`. The worker's `::EVIDENCE` lines are *proposals*, not proof. Failed? Send a rework order with `--resume <sessionId>` (the session id comes back even on failure/timeout, so a 29-minute run isn't wasted). Still failing after two rounds — take over. When accepted: merge the branch, then log it:

```bash
node scripts/taskhand.mjs note --kind rework   --task fix-1 --unit 1 --detail "tests still fail on edge case"
node scripts/taskhand.mjs note --kind takeover --task fix-1 --unit 1
node scripts/taskhand.mjs note --kind publish  --task fix-1 --unit 1
node scripts/taskhand.mjs log --days 14        # health summary: failures, rate limits, rework rate
```

Independent orders run in parallel (up to ~5, each in its own worktree); dependent ones reuse the same worktree in sequence.

## The work order format

Section keywords are English literals — `order-check.mjs` enforces them; copy the template. The last two sections are intentionally phrased as instructions to the worker.

```markdown
# Goal
<one sentence of what, plus one of why — the worker uses the why to settle choices the order didn't specify>
# Files
- <paths, as specific as possible>
# Requirements
- <concrete changes, constraints, project rules>
# Off-limits
No credentials (keys, passwords, .env, keychain); no deleting data, no force push, no branch deletion; nothing the project says must be done by a human; no publishing, no app-store submissions, no mass messaging, no payments.
# Acceptance
::RUBRIC{id:r1|threshold:1.0}
  R:tests|check:"npm test"
  R:lint|check:"npm run lint"
# Report
When done, commit locally in the worktree (don't push), then run each acceptance check and answer one line per item:
::EVIDENCE{id:e1|deliverable:r1.tests|kind:test_output|ref:"<key output line>"|result:pass|by:@AGENT|authority:proposal}
For failures write result:fail|gap:<what's missing>. Finally: which files changed, the commit id, problems encountered.
```

`dispatch` bounces an order unless it has ≤ 3 requirements, ≤ 4 files, ≥ 1 machine-checkable `check:"…"`, and no sequential-step phrases ("first … then" / "then" / "finally" / "step N") in Goal/Requirements — those are the tell that one order wants to be two.

Attach logs, pages, or quoted text for reference (never as instructions) in a `::UNTRUSTED` block:

~~~
::UNTRUSTED{id:u1|source:log|effects:none|delimiter:EOF_u1}
<<<EOF_u1
<raw material>
EOF_u1
::END_UNTRUSTED{id:u1}
~~~

## Channels, engines, and keys

`--channel auto` tries, in order: a local **magpie** gateway (`http://127.0.0.1:3425` — skipped silently when it isn't up), an **alt** key from the macOS keychain (`TASKHAND_ALT_KEYCHAIN_SERVICE`, default `taskhand-alt`), then the **primary** key (`TASKHAND_API_KEY`, or read from a local ZCode install's config). Channel switches happen only on rate limits or a down gateway — never silently otherwise. `--engine auto` falls back from `claude` to the **zcode** engine only on non-rate-limit failures, and only when ZCode.app actually exists on the machine.

`--model` takes built-in short names (`GLM-5.3-FLASHX` | `GLM-5.3-Flash` | `GLM-5.3`) or any raw model id for whatever `TASKHAND_BASE_URL` points at. `--magpie-model <vendor/model>` pins one order to one gateway model (no fallback — a fallback would silently change the model). `--hard` routes a genuinely hard order to the planner group instead of the worker group.

Each spawned `claude` session gets a clean env (no inherited `ANTHROPIC_*`), an isolated `CLAUDE_CONFIG_DIR` under `~/.taskhand/`, an appended system prompt that tells it *it is the worker* (nested dispatch after reading orchestrator rules is a real failure mode), a 64k output ceiling, and the guard hook.

## Configuration reference

| Flag / Env | Meaning |
|---|---|
| `--cwd` | the worker's worktree (required) |
| `--prompt-file` | the order file (required) |
| `--task` / `--unit` | labels for the log and rework-rate stats |
| `--timeout-min` | per-order wall clock, default 30; timeout kills, reports, keeps the session id |
| `--resume <id>` | continue a session (rework); pins the engine by id prefix (`sess_` = zcode) |
| `--skip-check` | dispatch an order that failed the sanity check anyway |
| `TASKHAND_API_KEY` | primary API key (Anthropic-compatible) |
| `TASKHAND_BASE_URL` | primary endpoint |
| `TASKHAND_ALT_KEYCHAIN_SERVICE` | macOS keychain service for the alt key |
| `LOOP_GUARD_ROOT` | guard boundary override for hosts not running inside a worktree |
| `LOOP_SESSION_ID` / `LOOP_SHIFT` | host bookkeeping passed through to the worker env |

## Notes

- The rate-limit matcher also checks a few Chinese phrases (并发/限流/使用上限): upstream endpoints sometimes answer rate-limit errors in Chinese, and a missed rate limit means a wasted attempt.
- Origin: this ran as the dispatch layer of the author's personal agent workspace (skills/ligong) since 2025-10; the author's instance retired in favor of a gateway split, and the mechanics were extracted and published under this name.
- License: [MIT](LICENSE).
