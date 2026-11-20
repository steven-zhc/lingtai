# 019 — What do ACP agents actually do?

**Set up** 2026-11-18 · **Run** 2026-11-19 on Foundry · **Result** both agents
can implement over ACP, and Copilot can inside Lingtai's sandbox; both answer `review` and triage in a parseable shape without a schema; neither can be
an agent with no tools; Antigravity cannot run inside the sandbox as the policy
stands. DeepSeek Harness not run (no key yet). The procedure is
[acp-experiments.md](../milestone/0.16.0/acp-experiments.md); the plan it serves
is [0.16.md](../milestone/0.16.0/0.16.md).

## Why

0.16.0 adds one ACP adapter for every agent but Claude Code and Codex. Five
questions in 0.16.md could not be settled from the spec — what an agent reports
about spend, whether a tool call can be refused, whether cancel stops a run, what
the sandbox must allow, how a model is chosen — so they are answered by what two
agents did, not by what the protocol says they may do.

## Where and what

**Foundry**, an Intel Mac on macOS 15.7.7, reached over Tailscale. Every sandbox
result below is Seatbelt on x86_64.

| Agent | Version | Started as |
|---|---|---|
| GitHub Copilot CLI | 1.0.112 (Homebrew cask) | `copilot --acp` |
| Antigravity CLI | 1.5.9 (Homebrew cask) | `agy acp` |
| DeepSeek Harness | 0.2.2-rc.5 (npm) | `dsh --profile acp` — E6 only |

The client is a throwaway raw JSON-RPC one (`acp-lab/client.mjs`, depending on
no ACP library) that answers what its flags say and records every message both
ways. The fixture is a one-file package with one failing test; the task is *fix
the code, run `npm test`, commit*. The sandbox runs are wrapped by
`acp-lab/srt-wrap.mts`, which imports Lingtai's own `packages/sandbox/src/policy.ts`
(at `2219e83a`) and calls srt 0.0.83 in the order `sandbox.ts`'s `wrap` does.
Transcripts are in `~/workspace/acp-lab/runs/` on Foundry and are not copied
here; run names below are their directory names.

**Antigravity keeps its login in the macOS keychain**, which an ssh session
cannot open, so every `agy` run was launched in a tmux session the operator
started from Foundry's GUI terminal (`acp-lab/gui.sh`).

## Results

### E6 — not logged in

| | Copilot | Antigravity | DeepSeek |
|---|---|---|---|
| `authMethods` | `copilot-login`, with terminal-auth `copilot login` | Google, Gemini Enterprise, Gemini API key, Agent Platform | none |
| fails at | `session/new` | `session/new` | **`session/prompt`** |
| error | -32000 *Authentication required* | -32000 *Authentication required* | -32603 *Internal error … no API key for provider route "deepseek-official"* |
| in | 228 ms | 228 ms | 185 ms |

-32000 is ACP v1's own code for *Authentication required*; DeepSeek is the one
that departs from the spec. **Copilot with no login of its own used `gh`'s**
(`e6-copilot` answered); with `GH_CONFIG_DIR` empty it failed as above
(`e6-copilot-nogh`).

### E1 — spend

Neither agent sends `cost`. Both put tokens on the `session/prompt` result and
send `usage_update` with `used`/`size` only. **The token fields do not mean the
same thing**: Copilot's `inputTokens` include the cached ones
(`e2-copilot-default-allow`: total 101195 = input 100498 + output 697), and
Antigravity's do not (`e2-agy-default-allow`: total 115759 = input 31977 +
output 1386 + cache read 82396). Copilot's own headless mode (E11) reports
`totalNanoAiu` and `premiumRequests`, which ACP does not carry.

### E2 — permission requests

| | Copilot | Antigravity |
|---|---|---|
| default mode, asks before | most `execute`, every `edit` | **every `execute` and every `edit`** |
| default mode, runs unasked | **read-only shell** (`git status && rg …`, kind `execute`), every read | every read |
| every call reported as `tool_call` | yes | yes |
| all rejected | stops: "Operation cancelled by user" | stops at the first, with no word |
| auto mode (`#autopilot` / `auto`), all rejected | **0 requests**, task done and committed | **0 requests**, task done and committed |
| a question, all rejected | answers from 4 unasked reads | asks to run `find`, is denied, **answers nothing** |

### E4 — `session/cancel`

Both answered `stopReason: "cancelled"` in 5–14 ms with no tool update after.
**Copilot killed the shell command it was running; Antigravity did not**:
`sleep 60 && touch slept.txt`, cancelled at 16 s, wrote `slept.txt` a minute
later, after the agent itself had exited (`e4-agy-sleep`).

### E3 — the client goes away

Stdin closed or the client SIGKILLed at 15 s: both agents were gone within ~2 s
and nothing changed afterwards. A SIGKILLed client left an uncommitted
half-done edit behind (`e3-*-kill`).

### E9 — choosing the model

**Antigravity** offers a `model` config option (gemini-3.8-flash,
claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium);
`session/set_config_option` changed it, and so did the removed unstable
`session/set_model`. **Copilot** offers no model option and no model list; its
`session/set_model` and its `--model` start flag both take effect, and a model the
account cannot use **ends the turn `end_turn` with the error as the agent's
text** (`e9-copilot`: "Error: Execution failed: Model \"gpt-5\" is not
available.").

### E10 — inside Lingtai's sandbox

| | Copilot | Antigravity |
|---|---|---|
| under the policy as it stands | starts; `session/new` → *Authentication required*: its `gh` login is in `~/.config/gh`, denied (0127 §5, §12) | **`session/new` → "language server failed to start: listen tcp 127.0.0.1:0: bind: operation not permitted"**: the policy has no `allowLocalBinding` |
| with its login supplied | `COPILOT_GITHUB_TOKEN` in the environment: **the task done inside srt** (`e10-copilot-task`), 0 violations | with `allowLocalBinding`: *Authentication required* — the keychain is denied (§12); with `~/Library/Keychains` readable as well (not the policy): works |
| its own sandbox on inside srt | `--sandbox`: blocked `npm test` and `git commit`, left the edit uncommitted, **ended `end_turn`** | not run |

### E5 — hosts and directories

| | Copilot (individual plan) | Antigravity |
|---|---|---|
| must reach | `api.individual.githubcopilot.com`, `exp.individual.githubcopilot.com` | `daily-cloudcode-pa.googleapis.com`, `www.googleapis.com` |
| refused, harmlessly | `telemetry.individual.githubcopilot.com` | `play.googleapis.com`, `aicode.googleapis.com`, `lh3.googleusercontent.com` |
| writes | `~/.copilot` (session-state, logs, telemetry, session-store.db, config.json) | `~/.gemini/antigravity-cli`, `~/.gemini/config` |
| when the model host is refused | `session/new` fails naming the proxy's 403 | **the turn "succeeds"** with the text "failed to construct executor: plan model not specified" |

Business and enterprise Copilot plans use other `*.githubcopilot.com` hosts; not
measured.

### E11 — the agents' own headless modes, for comparison

| | `copilot -p … --output-format json` | `agy -p … --output-format stream-json` |
|---|---|---|
| no approval flag | **exit 0, nothing done**: 15 calls "Permission denied because no interactive user response was available" | **did the task and committed anyway**: its own sandbox refused `.git/index.lock`, the same command then ran again and succeeded, the escalation not visible in the trace |
| all approved | done in 22 s | done in 39 s |
| spend | `totalNanoAiu`, `premiumRequests` — more than over ACP | tokens, no cost — the same as ACP |
| refuse one call | no: an allow/deny list fixed at start | no |
| structured answer | no schema flag found | **`--json-schema`** — which ACP does not offer |

### E8 — a structured answer without a schema

`review`'s prompt from `buildReviewPrompt` with `REVIEW_ANSWER_JSON_SCHEMA`
appended, over a diff that plants `Math.abs(a) + b` (right for the one test,
wrong for a negative first argument); triage's brief from `triageBrief` for a
run that met its wall with no reading left. Five of each per agent, each agent
on its default model (Copilot `auto`, Antigravity gemini-3.8-flash).

| | Copilot | Antigravity |
|---|---|---|
| review, parsed by `ReviewAnswer.safeParse` first time | 5/5 | 5/5 |
| review, planted bug found | 5/5 | 5/5 |
| triage, `answered` by `parseTriage` first time | 5/5 (`Unfinished`) | 5/5 (`Unfinished`) |

Every answer was bare JSON, so the re-ask was never needed and is not measured.
One small diff is an easy case: this says the prose route parses, not how well a
review of a real change reads.

### Conformance — against the official SDK's own schema

Every message the agents sent in the round's runs was checked against
`@agentclientprotocol/sdk` 2.8.0's v1 zod validators (`dist/v1/schema/zod.gen.js`,
by `acp-lab/conform.mjs`): **none was rejected** — Antigravity 1006, Copilot
3040, DeepSeek 2 (initialize, `session/new`, `session/prompt` and
`set_config_option` results, permission requests, every `session/update` kind).
zod drops unknown keys, so extras such as Antigravity's `load_session` beside
`loadSession` are not counted. **What the agents get wrong is what they do, not
how they say it**: a library on the client side would have parsed every one of
these messages and changed none of the findings above.

### E12 — through a library: the official SDK, and acpx

The same four runs (the task approved, the task refused, the `sleep` prompt
cancelled at 15 s, a model chosen) through two clients built on libraries:
`acp-lab/sdk-client.mjs` on **`@agentclientprotocol/sdk` 2.8.0** (the official
SDK, stable v1, raw messages tapped on its stream), and **acpx 0.22.0** (OpenClaw
— 3,450 stars, 828,086 npm downloads in the week to 2026-11-18, built on the SDK's
pre-2.0 1.9.0), in its one-shot `exec` mode with `--format json`.

| | official SDK 2.8.0 | acpx 0.22.0 |
|---|---|---|
| task, all approved | done, both agents | done, both agents (exit 0) |
| task, all refused | stops; `end_turn` | stops; **exit 5** |
| cancel at 15 s, `sleep 60 && touch slept.txt` | `cancelled` in 15 ms (Copilot) / 7 ms (Antigravity); **Antigravity's `sleep` still wrote `slept.txt`**: the SDK does not own the process | `--timeout 15`: **exit 3**, no `session/cancel` sent; **`slept.txt` not written for either agent: acpx kills the agent's process tree** |
| model, Antigravity | `set_config_option` → "Claude" | `--model` → `set_config_option` → "Claude" |
| model, Copilot | the removed `session/set_model` still sendable as an untyped request → works | **refused by acpx itself**: Copilot advertises no model option, so `--model` exits 1; only Copilot's own start flag is left |
| raw messages | through a `TransformStream` on each side | `--format json` is the raw ACP messages as NDJSON |
| errors from the library | none in 8 runs | none |
| what it is | a library: Lingtai spawns and owns the process | a CLI over a library: it spawns the agent; its session mode keeps a detached queue-owner process alive 300 s by default (`--ttl`); `exec` left none behind |
| Antigravity | `agy acp` | its built-in `antigravity` entry starts `agy_acp_server.par`, which the Homebrew CLI does not ship: `--agent "agy acp"` needed |

**Neither changes what the agents do**: the same asks, the same unasked reads,
the same tokens and no cost. The SDK is the raw client with typing; acpx adds
two things of real value — exit codes that name a refusal (5) and a timeout (3),
and a process-tree kill that removed Antigravity's orphan — and two that cut
against Lingtai: it decides model support from what the agent advertises, and in
session mode it runs a process of its own beside the conductor.

### E7 — DeepSeek Harness

Not run: no key yet. Only E6 above.

## What it means for 0.16.md

1. **Spend is estimated, per agent.** No `cost` from either; tokens from both,
   with different meanings, so the adapter reads each agent's fields its own
   way. Copilot's credits are only in its headless mode.
2. **Refusing a call works only in default mode, and only for what the agent asks
   about.** The adapter must never set an auto mode. Reads are never asked by
   either, and Copilot's read-only shell is not either, so **neither can stand in
   for an agent with no tools**: a discussion may not name them.
3. **Cancel is not enough.** Antigravity leaves a child running; turns and wall
   time are enforced by cancel *and* by killing the agent's process group.
4. **A finished turn is not a success.** Copilot (an unavailable model, its own
   sandbox nested) and Antigravity (its model host refused) both end `end_turn`
   with an error as their text; the adapter reads the text and the tool results,
   not the `stopReason` alone.
5. **The agents differ in ways one adapter has to know by name**: the mode ids,
   the token fields, the model route, the kill. That is evidence for question 4
   — a `RuntimeId`, or at least a profile, per agent.
6. **Sandbox**: Copilot fits 0127 as Codex does, with a token in the environment
   in place of `gh`'s login (the `claude setup-token` shape, §8) and its own
   sandbox off. Antigravity needs two things the policy refuses — binding a local
   port and reading the keychain — and has no file or environment login found
   besides a Gemini API key, which bills per token. As the policy stands it runs
   only on an unsandboxed project.
7. **Native headless modes are not better** on what was measured: one refuses
   everything with exit 0, the other escalates out of its own sandbox unasked.
   Two things they offer that ACP does not: Copilot's credits, Antigravity's
   `--json-schema`.
