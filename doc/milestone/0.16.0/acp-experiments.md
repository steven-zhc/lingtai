# 0.16 — the ACP experiments: what to run, and how

**Status** planned · 2026-11-18 · the round of measurements
[0.16.md](0.16.md) asks for before its open questions are discussed and before
any ticket is cut. The results go to `doc/experiments/019-…`; this file is the
procedure, and is not edited to hold them.

Each experiment answers a question 0.16.md cannot settle from the spec. Where
an agent's documentation already claims an answer, the claim is written beside
the experiment as the thing to confirm or refute, never as the answer.

## The agents

| Agent | Start it as | Logs in with | Known before the run |
|---|---|---|---|
| GitHub Copilot CLI | `copilot --acp` (stdio) | its own GitHub login, or a BYOK provider through `COPILOT_PROVIDER_*` | Server-wide options (`--available-tools`, `--excluded-tools`, `--effort`, `--sandbox`) are fixed at start and `session/new` cannot change them ([ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)). A user reports that in `--acp` mode it approves tools itself and never sends `session/request_permission` ([copilot-cli#845](https://github.com/github/copilot-cli/issues/845)); open or fixed is not known |
| Antigravity CLI | `agy acp` (stdio) | its own Google login, made with `agy acp --login` (ACP terminal auth) | In place of Gemini CLI (2026-11-19): Google replaced Gemini CLI with it for unpaid and Google One users on 2026-06-18, and Homebrew disables `gemini-cli` on 2026-12-18. ACP since 1.5.0 ([docs](https://antigravity.google/docs/cli/acp/)). `agy acp --help` on 1.5.9 lists `--dangerously-skip-permissions` (auto-approve every tool permission request — so by default it asks), `--sandbox` (its own), `--gemini-dir` and `--app-data-dir` (where its state lives), `--disable-telemetry`, `--process-per-session`. A Google forum reply warns that reaching the service through third-party software with Antigravity OAuth can suspend the account ([thread](https://discuss.ai.google.dev/t/is-using-the-official-agy-cli-through-a-local-mcp-server-with-third-party-ai-agents-permitted/184829)); Lingtai drives the official `agy acp` as an editor does, not a third-party bridge, and whether that reading holds is the operator's to weigh |
| DeepSeek Harness | `dsh --profile acp` | `DEEPSEEK_API_KEY` (prepaid balance) | npm package `@deepseek-ai/dsh`; config under `~/.dsh/` (`cordis.patch.yml`, `profiles/<name>`); `dsh --profile acp --dump-config` prints what it will run with ([CLI README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)). Developer preview: record the version |

Record `--version` of each agent, and the date, at the top of the write-up: all
three are moving, and a result is about a version.

## Where it runs: Foundry

The round runs on **Foundry**, the operator's second Mac (reached over
Tailscale as `foundry`), not on the machine that conducts Lingtai: the agents
start there never logged in, so E6 sees a clean state, and nothing they write
to their config directories touches the conducting machine.

Foundry is an **Intel Mac on macOS 15.7**, so every sandbox result is about
Seatbelt on x86_64 and says so. Installed for the round on 2026-11-19:

| What | Version | How |
|---|---|---|
| GitHub Copilot CLI | 1.0.112 | `brew install --cask copilot-cli` |
| Antigravity CLI | 1.5.9 | `brew install --cask antigravity-cli` (Homebrew manages its updates) |
| DeepSeek Harness | 0.2.2-rc.5 | `npm i -g @deepseek-ai/dsh` — not Homebrew: brew's `dsh` is an unrelated *distributed shell*, and the `deepseek-harness` cask is the desktop app, arm64 only |
| Lingtai | `2219e83a` (0.15.0) | cloned to `~/workspace/lingtai`, for `packages/sandbox`'s own policy and srt 0.0.83 |
| `acp-lab` | `@agentclientprotocol/sdk` 2.8.0, `@anthropic-ai/sandbox-runtime` 0.0.83 | `~/workspace/acp-lab` |

Gemini CLI 0.27.3 was already on Foundry, never logged in; it is left as it is
and not part of the round.

## Setup, once

**Everything lives outside this repository**, in `~/workspace/acp-lab/` on Foundry — the
client, the fixture project, the transcripts. Nothing is committed here except
the write-up.

1. **Install and log in.** `npm i -g @deepseek-ai/dsh` and a DeepSeek key with a
   small balance (¥20 is far more than the round needs); Copilot CLI logged in;
   Antigravity CLI logged in (`agy acp --login`). E6 is run
   **before** each login, so do that agent's E6 first.
2. **The fixture project** `acp-lab/fixture/`: a git repository with a tiny
   package, one failing unit test, and a `README`. Its task is *make the test
   pass and commit*: small, verifiable, and it needs reading, editing and a
   shell command. `git tag start` so every run resets with
   `git reset --hard start && git clean -fdx`.
3. **The client** `acp-lab/client.ts`: a throwaway Node script on
   `@agentclientprotocol/sdk` (`ClientSideConnection` over `ndJsonStream`
   on the agent's stdio). It is the instrument, so it decides nothing; it takes
   flags and records:
   - `--agent "<command>"`, `--cwd`, `--prompt <file>`, `--model <id>` (tries
     the session model call, E9);
   - `--permission allow|reject|cancel` — how it answers every
     `session/request_permission`;
   - `--mode <id>` — `session/set_mode` after `session/new` (auto-approve);
   - `--cancel-after <s>`, `--kill-self-after <s>`, `--close-stdin-after <s>`
     (E3, E4);
   - writes **every JSON-RPC message both ways, timestamped**, to
     `runs/<agent>-<exp>-<n>/transcript.ndjson`, plus the agent's stderr,
     `git status --porcelain` and `git log` of the fixture after the run, and
     the agent's process id.
   File-system and terminal client capabilities are **not** advertised in
   `initialize`: Lingtai's runtime would let the agent use the worktree
   directly, as Claude Code and Codex do, and the experiment should see the
   agent as Lingtai would run it.
4. **A results sheet** `acp-lab/results.md`, one row per run: agent, experiment,
   options, outcome, the transcript's path.

## The experiments

Order: E6 (before login) → E10 → E1 + E2 together → E4 → E3 → E5 → E8 → E9;
E7 is DeepSeek's pass through all of them, not a separate step. E10 comes
second because it can end an agent's part in the milestone: an agent that
cannot work inside srt runs only on an unsandboxed project, and every later
experiment is then run both ways for it.

### E1 — what each agent reports about spend

*Question:* a run's cost, tokens, both or neither — and do the numbers agree
with the vendor's bill?

1. Reset the fixture; run the task with `--permission allow`.
2. From the transcript, collect every `session/update` of kind `usage_update`
   (`used`, `size`, `cost`), and the `session/prompt` result's fields beyond
   `stopReason` (any `usage` or token field).
3. Repeat three times per agent.
4. For one run, set the numbers beside the vendor's own record, taken just
   before and just after the run: DeepSeek's console usage page, Copilot's
   `/usage` (premium requests), Antigravity's own usage page.

*Record:* per agent, one of **cost** / **tokens only** / **context size only** /
**nothing**, and how far the reported figure sits from the bill.

*Decides:* how an ACP run is priced (0.16.md question 1: estimated from tokens
on the rate card; nothing to estimate from if there are none).

### E2 — permission requests, and whether every tool call is seen

*Question:* can Lingtai refuse a tool call and keep the run's trace from the
protocol alone (`canFailClosed`, in place of the hook)?

1. In the agent's default mode, run the task with `--permission reject`.
   Afterwards, **compare the transcript with the fixture**: did any file change,
   any command run (the test's own output file, the commit), with no
   permission request before it?
2. The same with `--permission allow`: list every `session/request_permission`
   (which tool kinds it covers: read, edit, execute, fetch) and every
   `tool_call` / `tool_call_update`; match them one to one against what
   changed.
3. In the agent's auto-approve mode (`--mode`, or Copilot's own flags,
   DeepSeek's `DSH_PERMISSION_MODE`): are permission requests still sent? are
   `tool_call` updates?
4. **The no-tools case** (for discussions): a prompt that only asks a question
   about the fixture's code, with `--permission reject`. Does the agent still
   answer? Did it read files without asking (a `tool_call` of kind `read`
   with no request before it)?

*Record:* per agent and mode, a table of tool kind × *asked first* /
*reported only* / *neither*.

*Decides:* 0.16.md question 3, and whether a discussion may name an ACP agent.
Any write or execute that was neither asked nor reported is a finding of its
own.

### E3 — the client goes away mid-run

*Question:* the ACP form of *a hook that cannot reach the conductor must stop
the run*: does the agent stop when Lingtai is gone?

1. Start the task; at 20 s, `--close-stdin-after 20`. Watch the agent's
   process id: alive after 5 s, 30 s, 2 min? Is the fixture still changing
   (`git status` every 10 s)?
2. Again with `--kill-self-after 20` (the client killed with SIGKILL, so the
   pipe closes without any message).

*Record:* time to the agent's exit, or *still running at 2 min*, and what it
did after the client went.

*Decides:* whether the runtime needs its own reaper beyond closing the pipe.

### E4 — `session/cancel`

1. Start the task; `--cancel-after 15`.
2. Record: the time from `session/cancel` to the `session/prompt` result, its
   `stopReason` (`cancelled` is the spec's answer), whether any `tool_call`
   finishes after it, and what is left in the fixture (half-edited file, a
   running child process — `ps` for the test runner).
3. Twice per agent: once while the model is thinking, once while a shell
   command is running (a prompt that runs `sleep 60` first).

*Decides:* whether Lingtai's turn and wall limits can be enforced by cancel
alone.

### E10 — does the agent work inside srt at all

*Question:* can each agent run, log in and finish the task inside the
boundary Lingtai actually draws, as Claude Code and Codex do since 0.14?

0127 already decides two things that make this more than a network question:
**srt is the only boundary and an agent's own sandbox is off inside it, because
none can run nested** (§1); and **the run is denied the operator's login** —
`~/.claude/.credentials.json` and, on macOS, `~/Library/Keychains` are on the
deny list (§12), which is why a sandboxed Claude Code run is handed a
long-lived token from `claude setup-token` (§8) while Codex's
`~/.codex/auth.json` stays readable (§6). An ACP agent has to fit one of those
two shapes or bring a third.

1. **The policy.** Wrap the agent with Lingtai's own policy, not a hand-made
   one: the deny list of 0127 §12 (with `~/Library/Keychains`), `~/.lingtai`
   read-denied, writes allowed in the fixture and the agent's own config
   directory only, `enableWeakerNetworkIsolation` on macOS (§9) — and the
   network **open to the agent's hosts**, so that a failure here is not E5's.
   The simplest faithful route is a small script that calls
   `SandboxManager.wrapWithSandboxArgv` the way `packages/sandbox/src/live.ts`
   does, with the policy `packages/sandbox/src/policy.ts` builds.
2. **The agent's own sandbox off.** Copilot: `--no-sandbox` (its docs say an
   enterprise policy that enforces sandboxing overrides it — record whether the
   operator's account has one). Antigravity: no `--sandbox`. DeepSeek Harness: find whether it has one and how it is turned off.
3. **Start and `initialize`.** Does the process start under srt, and does ACP
   over the wrapped stdio answer `initialize`? Record srt's violation lines
   from the start alone.
4. **Login.** With the keychain denied, does a prompt work? Record **where each
   agent keeps its login** (keychain, a file under its config directory, an
   environment variable) and, if the keychain, which token it accepts from the
   environment instead (the equivalent of `claude setup-token`) and how long
   that token lives. DeepSeek's key is an environment variable and should pass;
   confirm it.
5. **The task.** With login working: does it read, edit, run the test and
   `git commit` in the fixture? Every violation line, every refused write.
6. **Nested, on purpose.** The agent's own sandbox on, inside srt (Copilot
   `--sandbox`, Antigravity `--sandbox`): does it fail, and with what sentence? This is
   the message a person sees when the agent's own setting is left on, and the
   adapter must turn it off or refuse by name.
7. **Linux, if a machine is to hand.** The same on Linux, where srt is
   bubblewrap and the hook socket rule differs (§7). Not required for the
   round; written down as *not measured* if skipped.

*Record:* per agent — starts / ACP answers / logs in (and how) / finishes the
task / own sandbox can be turned off / nested sentence; and the violation
lines.

*Decides:* whether an ACP agent may run on a sandboxed project, what the
adapter turns off, and what the operator sets up once for its login, as
`claude setup-token` is for Claude Code. An agent that fails here is limited
to unsandboxed projects, which 0127 §4 makes the exception for a new project.

### E5 — hosts and files under the sandbox

*Question:* what a per-agent entry in the sandbox needs (0.16.md question 2).

1. Run the agent as E10 does, under the same policy, but with **no allowed
   domains**. Only for an agent that passed E10.
2. Record every refused host and every refused write path from srt's log.
3. Allow the refused hosts one at a time until the task completes; the list
   that worked is the agent's minimum. Separate the model's host, the login
   host, and telemetry (as 017 did for Claude Code: `sentry.io` was left out of
   `BUILT_IN_DOMAINS`, `packages/sandbox/src/policy.ts:59`).
4. List the config and cache directories each agent wrote outside the fixture
   (`~/.copilot`, `~/.gemini` and Antigravity's app data, `~/.dsh`, …).

*Record:* per agent, hosts (model / login / telemetry) and directories.

### E6 — not logged in

Run **before** that agent's login, or with `HOME` pointed at an empty
directory; for DeepSeek, with `DEEPSEEK_API_KEY` unset and then set to a wrong
key.

1. `initialize`: record `authMethods` as sent.
2. `session/new` and `session/prompt`: record which fails, the error code
   (`auth_required` is the spec's), and the message.
3. Time how long the failure takes (a prompt that hangs is a finding).

*Decides:* the environment wait's wording and `lingtai doctor`'s check.

### E7 — DeepSeek Harness, in particular

E1–E6 on `dsh`, and in addition:

1. Whether token counts reach the client, and **whether cache hits are counted
   apart** (DeepSeek prices them apart): run the same prompt twice within a few
   minutes so the second hits the cache, and compare the two runs' figures
   with the console.
2. The time of day of each priced run (Beijing peak 9–12, 14–18 on weekdays,
   half price outside), so the bill can be checked against both prices.
3. What happens at a balance too low to finish (if a nearly empty key is
   available; otherwise read the API's error for it and write that down
   instead).

*Decides:* whether a DeepSeek run can be estimated, and what the rate card
lacks (currency, time of day).

### E8 — a structured answer without a schema

*Question:* may `review`, a judge or triage name an ACP agent?

1. Two prompts: `review`'s, asking for an answer in the shape of
   `REVIEW_ANSWER_JSON_SCHEMA` (`packages/domain/src/events.ts:1418`) over a
   fixed diff with one planted bug; triage's, asking for
   `TRIAGE_ANSWER_JSON_SCHEMA` (`packages/domain/src/wait.ts:1052`) over a
   fixed failed-run excerpt. The schema is written into the prompt, as the
   triage route without a schema does today (`apps/cli/src/triage.ts:1059`).
2. Ten runs per agent per prompt, `--permission allow`.
3. Parse each answer: take the JSON out of the prose and validate it against
   the schema (triage's own `parseTriage`,
   `packages/conductor/src/triage.ts:367`, for the triage prompt). On failure,
   ask once more in the same session, quoting the validation error.

*Record:* parsed first time / parsed after one re-ask / failed, per agent and
prompt; for review, whether the planted bug was found.

*Decides:* whether these places may name ACP agents, and whether one re-ask is
the rule.

### E9 — choosing the model

1. Record what `initialize` and `session/new` return about models and modes
   (`models`, `modes`, available commands).
2. Set the model with `session/set_config_option` on the option of category
   `"model"` (`--config <id>=<value>`), the stable route; then try the removed
   unstable `session/set_model` (`--model`) only to see whether an agent still
   answers it ([acp-libraries.md](acp-libraries.md)).
3. For Copilot, whose options are fixed at start: whether a start-up flag
   chooses the model instead.
4. Check which model actually ran from the vendor's record (console, usage
   page), not from asking the agent.

*Decides:* what a recipe's `model:` means for an ACP agent — passed per
session, per process, or not at all.

### E11 — the agents' own headless modes, for comparison

Added 2026-11-19, to answer *would the agents' own CLIs be better than ACP*.
The same task through `copilot -p … --output-format json` and
`agy -p … --output-format stream-json`, once without any approval flag and once
with everything approved (`--allow-all-tools`, `--dangerously-skip-permissions`).

*Record:* exit code, what was done, what the output says about spend and about
each tool call, whether one call can be refused.

*Decides:* whether an agent's own headless mode should replace ACP for it.

### E12 — through a library

Added 2026-11-19. The task approved, the task refused, the `sleep` prompt
cancelled at 15 s and a model chosen, on both agents, through a client on the
official `@agentclientprotocol/sdk` and through acpx (OpenClaw's headless client).

*Record:* whether the library parses every message, what it adds (exit codes,
process cleanup, raw messages) and what it refuses.

*Decides:* whether the runtime is built on the SDK, on acpx, or on neither.

## What it costs

About thirty runs per agent, most of them the small fixture task or a single
answer. Copilot and Antigravity run on the operator's plans (premium requests and
quota, not money per run); DeepSeek on a prepaid key, where the whole round
should cost a few yuan. Stop and write down what was found if any agent's
first E1 run costs more than expected — the task is meant to be small.

## The write-up

`doc/experiments/019-acp-agents-measured.md`: the versions and date; one table
per experiment with the three agents as columns; the findings each decision in
0.16.md's *to discuss after the experiments* rests on, citing the run
directories by name (the transcripts stay in `acp-lab`, outside the
repository). Then the discussion, one question at a time, and only then the
tickets.
