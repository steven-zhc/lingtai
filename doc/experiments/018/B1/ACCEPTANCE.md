# Acceptance: a sandboxed Codex run goes through srt (S5)

Tests: [`packages/agent/unit/acceptance-s5.test.ts`](packages/agent/unit/acceptance-s5.test.ts), 31 tests, unit
project. Run with `npx vitest run packages/agent/unit/acceptance-s5.test.ts`.

**The file name uses `s5` because the ticket body does not carry its issue number** and `gh` could not be asked
from this session. Rename it to `acceptance-<issue>.test.ts` when the number is known.

**This is not a page.** The ticket names no UI and links no mock, so there is no style table and no visual
checklist.

## How the tests run the thing for real

They call the real `codexRun` and `createCodexRuntime().invocation()`, with:

- **`node:fs` replaced for the fixture paths only**, as `unit/interruption.test.ts` already does. The fixture holds
  the hook wiring, the operator's `config.toml`, and a *linked* worktree whose `.git` points into
  `/state/repos/p.git`. That makes today's argv carry `--add-dir`, so its absence in the sandboxed argv proves
  something.
- **a fake `spawn`** that records its command, args and options;
- **a fake `request.sandbox.wrap`** (the `RunSandbox` seam #1150 built) that records its `WrapInput` and returns
  `[srt, …, '--', …command]` with the input's env plus two policy variables.

The recorded `WrapInput` then goes through `@lingtai/sandbox`'s own `resolvedPolicy`. So *config.toml is readable*
and *auth.json is writable* are checked against the `allowWrite`, `denyWrite` and `denyRead` srt would really
receive.

Layout: worktree = `cwd` = `/work/tree`, `HOME=/home/op`, Codex home `/home/op/.codex`, mirror
`/state/repos/p.git`, project cache `/state/cache/p` (`cacheDir(host,'p')`, beside `mirrorDir(host,'p')`). The
cache is not a field on `RunSandbox` today, so the implementation has to derive it or add it. The fixture follows
the standard layout, so either way works.

## What the tests pin that the ticket leaves open

| Pinned | Why |
|---|---|
| The exported conversion is `absoluteProfileDenies(verdict, { home, cwd })` in `codex.ts` | Done when 8 asks for *an exported function* and gives it no name. Only the name and the arguments are pinned. It may answer with a list, `{ paths }`, a refusal value carrying `why`/`reason`/`message`, a throw, or an Effect. |
| The Codex home comes from `request.env`: `CODEX_HOME`, else `HOME/.codex` | The same rule `codexConfigPath` (`codex.ts:519`) uses for the file the child reads. |
| *Not sandboxed* is `request.sandbox` absent | `RunSandboxDecision` (`claude-sandbox.ts:18`) has no `unsandboxed` member: *"`unsandboxed` never reaches a request: `RunRequest.sandbox` is absent instead"*. |
| A refusal's `detail` names the offending key or its resolved path | The ticket says "by name". |

## Want → check

| Want clause | Proved by |
|---|---|
| When the decision is *sandboxed*, `codexRun` spawns Codex through `Sandbox.wrap` | *Done when 3: one wrap whose command is codex exec …*; *Done when 3 / Watch out: the spawn is the wrap's argv and env, with no shell* |
| … with `--sandbox danger-full-access` | *Done when 3: one wrap …* (command); *Done when 4 …* (positive control); *Edges: invocation() …* |
| `~/.codex` (or `$CODEX_HOME`) writable as a caller addition | *Done when 3 / 9: the Codex home is a caller write …*; *Want: $CODEX_HOME, when set, …*; *Done when 9: … in the policy srt would get* (`allowWrite`) |
| … except `config.toml`, `AGENTS.md`, `rules/`, write-denied always, whether they exist or not | *Done when 3 / 9: … though none exists* (the fixture has none of the three); *Done when 9: …* (`denyWrite` in the resolved policy, and `config.toml` not under `denyRead`) |
| The operator's Codex profile denies on this run's deny lists | *Done when 5: deny keys reach caller_additions.deny absolute …* (both `denyRead` and `denyWrite` of the resolved policy) |
| When the decision is *unsandboxed*, the run is exactly today's, byte for byte | *Done when 2: no sandbox on the request spawns today's argv and env …* (args `toEqual` today's `codexArgv` with `--add-dir` and the profile `-c`; same command, cwd, stdio, `detached`, env = `request.env` + marker); *Edges: invocation() …* (absent half) |

## Done when → check

| # | Done when | Proved by |
|---|---|---|
| 1 | `refused` fails before spawn by name; fake `wrap` and fake spawn never called | *Done when 1: a refused decision fails by name …* (`vi.fn` wrap not called, no spawn, detail contains *sandbox required and unavailable on this host*) |
| 2 | Unsandboxed (and none): `codexArgv`'s output and the spawn call identical to today's | *Done when 2: …*. Its first half passes on this checkout, which is intended: it **is** today's behaviour. The test fails on its control, *the same request sandboxed is wrapped*, so the decision is shown to be the only switch. |
| 3 | One `wrap` with `[binary,'exec',…,'--sandbox','danger-full-access',…]`, no `-c default_permissions`, no `-c permissions.…`, no `--add-dir`; `caller_additions.write` holds the Codex home; `env` carries the marker; spawn uses the fake's `argv` and `env` with no shell | *Done when 3: one wrap …*; *Done when 3 / Watch out: the spawn …*; *Done when 3 / 6: the env handed to wrap carries LINGTAI_CODEX_PROCESS_MARKER …*; *Done when 3 / 9: the Codex home is a caller write …* |
| 4 | `danger-full-access` in no argv built without a sandboxed decision (every branch) | *Done when 4: …*. It covers `codexArgv` over both roles × {plain, writable, denies, `overrideIn`, `profiles`, output schema} × {with wiring and no model, no wiring and a model}, plus `invocation()` with no sandbox and with a `refused` one, on both roles. Positive control: `invocation()` with a sandboxed decision carries it. |
| 5 | Profile denies reach `caller_additions.deny` absolute; `:special` refuses by name; `unreadable` refuses before `wrap`; `kept` adds nothing; a deny that is / lies inside / contains the worktree, mirror, cache or Codex home refuses (incl. `<worktree>/secrets`) | *Done when 5: deny keys reach …*; *… a :special key refuses …*; *… an unreadable profile refuses …*; *… kept adds no denies …*; twelve *Done when 5 / Watch out: a deny that {is, lies inside, contains} the {worktree, mirror, project cache, Codex home} …*. Each relation test carries a control: the same run with a deny that collides with nothing is wrapped. Without it, five of the twelve passed on this checkout, because today's `denyCoveringRoot` already refuses a deny over a git store. |
| 6 | Marker in the env handed to `wrap` (created before it); a test stops a wrapped run through the marker | *Done when 3 / 6: the env handed to wrap …*; *Done when 6: interrupting the run scans for the very marker that was in the env given to wrap*. Under fake timers, the injected `stopProcesses` receives the marker from `WrapInput.env`, and that marker is the one in the spawned env. |
| 7 | `wrap` failure → `crash` with srt's sentences, nothing spawned | *Done when 7: a wrap failure ends the run as a crash …* |
| 8 | Exported function: verdict → absolute deny paths, unit-tested | *Done when 8: …*, three tests: `~/`, relative, absolute and glob; `none` and `kept` give no paths; `:special` refuses by name |
| 9 | Codex home a caller write; three configuration paths on `CallerAdditions.denyWrite` whether or not they exist; `config.toml` not on `denyRead`; `auth.json` and `sessions/` writable | *Done when 3 / 9: …*; *Done when 9: config.toml stays readable, auth.json and sessions/ stay writable, in the policy srt would get* |
| 10 | `pnpm typecheck` and `HOME=/nonexistent pnpm test` green; ratchet baseline unchanged or lower | **No test written.** This is the gate itself: `pnpm test` runs this file, and `packages/domain/unit/effect-ratchet.test.ts` holds the baseline. |

## Edges → check

| Edge | Proved by |
|---|---|
| `refused` decision | Done when 1 |
| Unreadable profile refuses a sandboxed run; a `wrap` failure never falls back to an unwrapped spawn | Done when 5 (unreadable), Done when 7 |
| `kept`: no denies, explicit `--sandbox danger-full-access` outranks `sandbox_mode` | *Done when 5 / Edges: kept adds no denies …* |
| A deny srt would void | The twelve relation tests |
| How a profile key becomes a path | Done when 5 (run) and Done when 8 (function) |
| Process restarts or dies halfway; marker before `wrap`; stop through the marker scan | Done when 6 |
| Null, unknown or absent: no decision is today's argv, never read as sandboxed | Done when 2, Done when 4 |
| `invocation()` shows `--sandbox danger-full-access` without srt's prefix | *Edges: invocation() shows the argv Codex runs with …* |
| `CallerAdditions.denyWrite` added in `packages/sandbox` if #1150 had not | **Nothing to check: it exists** (`packages/sandbox/src/policy.ts:35-36`, on `denyWrite` only at `:138`), and the resolved-policy assertions use it. |

## Lines with no check, and why

- **Done when 10** (typecheck, full unit suite, ratchet): this is the build gate, not a behaviour. I could not run
  `tsc` on the new file from this session either: the command needed an approval nobody could give.
- **Two passes at once; pause, drain, shutdown; a retry**: the ticket says these are unchanged or that each run
  wraps afresh. The tests build a fresh harness per run, but nothing asserts concurrency.
- **Codex's JSON stream read as today; srt adds nothing to stdout**: no test. The receipt reducer is untouched,
  and the fake child prints nothing.
- **That a denied path is unreadable on a real host, and Codex working inside srt**: out of scope by the ticket
  (S10's canary, 017). No integration test is added, as the ticket asks.

## A finding for the implementer

`userPermissionsAt` (`codex.ts:663-671`) answers `unreadable` for **any** read error, including `ENOENT`. Under
this ticket an `unreadable` verdict refuses a sandboxed run, so **an operator with no `~/.codex/config.toml` at all
would have every sandboxed Codex run refused**. A missing file is not a profile whose denies went missing. The
tests always provide a `config.toml` and do not pin either answer. The ticket does not decide this case, so the
implementer has to.
