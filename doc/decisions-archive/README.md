# Archived decisions

These are the 75 ADRs written before 2026-10-01, kept exactly as they were.
**None of them is current.** Each topic's current decision is one ADR in
[`../decisions/`](../decisions/), numbered from 0100, and the last line of each
says which of these it replaces.

They stay because the code cites them: a comment reading `0061 §4` names
`0061-the-recipe-is-the-pipeline.md` here, section 4. Read one to learn why a
line of code is the way it is, never to learn what is decided now.

## The packages were renamed

[0022](0022-the-seams.md) renamed four packages and split one, on
2026-09-07. **The ADRs are not rewritten** — they are append-only in spirit and
record the names that were in force when each was decided — so this is the map
from what an older file says to what is on disk now.

| an older ADR says | on disk now | why |
|---|---|---|
| `@lingtai/core` | `@lingtai/domain` | "core" names importance, not content |
| `@lingtai/config` | `@lingtai/recipe` | a recipe is not "config" |
| `@lingtai/gates` | `@lingtai/actions` | `end` gates nothing; it runs for effect |
| `@lingtai/store` | `@lingtai/event-store` + `@lingtai/projector` | an event store offers resumption; it does not remember its readers |
| `@lingtai/runtime` | `@lingtai/agent` | starting the process and hearing it back are one concern |

`#63` prefixed every environment variable Lingtai reads for itself, so an older
file quoting `DATABASE_URL`, `TEST_DATABASE_URL`, `GITHUB_APP_ID` or
`GITHUB_WEBHOOK_SECRET` means `LINGTAI_DATABASE_URL`,
`LINGTAI_TEST_DATABASE_URL`, `LINGTAI_GITHUB_APP_ID` and
`LINGTAI_GITHUB_WEBHOOK_SECRET`. A **project's** own file is not covered and
keeps its own names.

Three packages came *out* of `conductor` on the same day, which no older ADR
mentions at all: **`@lingtai/repo`** (git, worktrees, the merge lane),
**`@lingtai/agent`** (the runtime, the hook wiring and the hook socket) and
**`@lingtai/agent-env`** (the agent's environment — never to be confused with
`@lingtai/env`, which holds the *machine's* credentials).

## The archived decisions, and what each said of the others

| | | |
|---|---|---|
| [0001](0001-event-sourcing.md) | Rebuild the loop as an event-sourced system | accepted |
| [0002](0002-typescript.md) | TypeScript, with the hook as a Bun single file | accepted |
| [0003](0003-postgres-event-store.md) | PostgreSQL as the event store | accepted |
| [0004](0004-prisma.md) | Prisma 8 as the ORM | accepted |
| [0005](0005-config-in-target-repo.md) | Configuration lives in the managed repository | policy half superseded by 0016; **the rest by [0046](0046-lingtai-is-personal.md)** |
| [0006](0006-github-app.md) | A GitHub App, not a personal access token | accepted |
| [0007](0007-dual-runtime.md) | Two runtime interfaces, one implementation | accepted; role-specific containment and capability contract extended by 0054 (implementation pending) |
| [0008](0008-nextjs-board.md) | Next.js for the board, SSE for live updates | accepted |
| [0009](0009-two-connections.md) | Two connection strings: pooled, and session mode | accepted |
| [0010](0010-source-runs-unbuilt.md) | The source runs unbuilt, so it obeys strip-only rules | accepted |
| [0011](0011-hook-latency-is-runtime-startup.md) | The hook's 20ms budget is Bun's startup, and is not met | accepted |
| [0012](0012-one-task-view.md) | One `TaskView`, and the queue leaves the log | accepted |
| [0013](0013-daemon-hosts-the-work.md) | The daemon holds the work; the UI controls it | accepted |
| [0014](0014-one-loop-one-log.md) | One loop, one log; everything else is a projection or a subscriber | superseded by 0016 |
| [0015](0015-five-gates-and-two-extensions.md) | Five gates, and the two ways a plugin may extend the loop | superseded by 0016 |
| [0016](0016-the-settled-model.md) | **The settled model: one loop, five gates, no policy** | accepted; §1's queue row clarified by 0036, §5's "plugins are trusted" superseded by 0037 |
| [0017](0017-the-project-is-called-lingtai.md) | The project is called Lingtai | accepted |
| [0018](0018-the-proposed-point.md) | The gate point called `diff` is called `proposed` | accepted |
| [0019](0019-a-second-reset.md) | The log is reset a second time, and what makes it the last | accepted |
| [0020](0020-the-agent-environment-in-layers.md) | The agent's environment comes from three named layers | superseded by 0021 |
| [0021](0021-the-recipe-decides-the-environment.md) | The recipe decides the environment; the machine only holds it | accepted |
| [0022](0022-the-seams.md) | **Where the seams go: eleven packages, and four deletions** | accepted |
| [0023](0023-effect-at-the-boundary.md) | Effect at the port boundary, and nowhere else | accepted |
| [0024](0024-agent-env-is-its-own-package.md) | The agent's environment is its own package, and Effect is in | accepted; §2's "what is not built" superseded by 0026 |
| [0025](0025-a-failure-buys-one-agent.md) | **A failure buys one agent, and the person approves a diff** | accepted |
| [0026](0026-the-conversion-past-the-seam.md) | **The conversion goes past the seam: `runOnce` and the adapters are Effect** | accepted |
| [0027](0027-the-lease-is-deleted.md) | **The lease is deleted: the constraint excludes, the lock proves liveness** | accepted; supersedes 0013's claim-recovery paragraph |
| [0028](0028-the-backoff-is-the-recipes.md) | **The backoff is the recipe's: an hour, flat, and only a blind retry waits** | accepted |
| [0029](0029-the-prompt-budget-is-the-recipes.md) | **The prompt budget is the recipe's, and a limit is written down where a kind is** | accepted; records 0012's retention value |
| [0030](0030-shutting-down-safely.md) | **Shutting down safely: the boundary is the pass, and the trigger is a command** | accepted; §2's *a daemon that is down finds it waiting* superseded by 0048 |
| [0031](0031-a-run-that-never-started.md) | **A run that never started is its own outcome, and a quota stops the conductor** | accepted |
| [0032](0032-the-page-is-organised-by-attempt.md) | **The task page is organised by attempt, and its control is the prompt** | accepted |
| [0033](0033-the-third-kind-of-agent.md) | **The third kind of agent: one that reads, and cannot run** | accepted; configurable runtime under 0053 and role boundary extended by 0054 (implementation pending) |
| [0034](0034-the-run-log.md) | **A run leaves a log you can watch, and it is a trace, not a record** | accepted |
| [0035](0035-the-site-is-a-projection.md) | **The site is a projection of this repository, and its hero is the real board** | accepted |
| [0036](0036-the-core-takes-a-ticket.md) | **The core takes a ticket, and where it came from is an adapter's business** | accepted; clarifies 0016 §1's queue row |
| [0037](0037-an-extension-is-a-command.md) | **An extension is a command, and the only question is whether the core waits** | accepted; supersedes 0016 §5's "plugins are trusted code" |
| [0038](0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) | **A finding buys an agent before it buys your attention** | accepted; §4's two purses superseded by 0039 |
| [0039](0039-the-worktree-is-the-whole-of-a-pass.md) | **The worktree is the whole of a pass, and a refusal never costs it** | accepted; supersedes 0025 §2–§3 and 0038 §4 |
| [0040](0040-rounds-bound-depth-restarts-bound-breadth.md) | **`rounds` bound depth; a second ceiling bounds breadth** | accepted; extends 0039 §2–§3, off by default |
| [0041](0041-a-gate-that-never-ran.md) | **A gate that never ran has judged nothing, and the same quota stops the conductor** | accepted; extends 0031 to the agent inside a gate |
| [0042](0042-the-restart-is-a-command.md) | **The restart is a command, the checks come before the drain, and a start is an event** | accepted; §8's handoff superseded by 0048 |
| [0043](0043-evidence-is-plain-text.md) | **A gate's evidence is plain text, stripped where it is captured** | accepted; closes #156 |
| [0044](0044-a-close-is-a-terminal-outcome.md) | **A close is a terminal outcome, so `end` runs on it** | accepted; completes #151 |
| [0045](0045-one-team-one-conductor.md) | **One team, one conductor, one recipe** | **superseded by [0046](0046-lingtai-is-personal.md)** |
| [0046](0046-lingtai-is-personal.md) | **Lingtai is personal; the repository is the team's** | accepted; supersedes 0045 and 0005's surviving half; §3's machine placement of agent and limits superseded by 0053 (implementation pending) |
| [0047](0047-the-recipe-a-run-got-is-on-the-log.md) | **The recipe a run was given is on the log, and nothing resolves from it** | accepted; qualifies 0005 |
| [0048](0048-a-signal-is-aimed-at-one-daemon.md) | **A signal is aimed at one daemon, so the restart hands nothing to the next** | accepted; supersedes 0030 §2's waiting request and 0042 §8's handoff |
| [0049](0049-the-publishable-unit-is-dist.md) | **The publishable unit is `dist/`, and both workspace manifests stay private** | accepted; qualifies 0010 for distribution, and 0035's *built by `pnpm build`* |
| [0050](0050-the-binary-is-a-sea-signed-ad-hoc.md) | **The binary is a SEA built on its own platform, signed ad hoc, and run before it is published** | accepted; builds on 0049 |
| [0051](0051-a-version-is-a-directory.md) | **A version is a directory, and the shim is the only thing that moves** | accepted; the installer, upgrade, rollback and uninstall (#184) |
| [0052](0052-the-lock-is-sqlite-on-a-file.md) | **The lock is SQLite's, on a file, and the queue is made rather than given** | accepted; supersedes 0046 §1's `flock(2)`, which Node cannot call |
| [0053](0053-the-recipe-chooses-the-agent-for-each-role.md) | **The recipe chooses the agent for each role** | accepted, implementation pending; supersedes 0046 §3's machine placement of agent and limits |
| [0054](0054-a-role-keeps-its-permissions-when-its-agent-changes.md) | **A role keeps its permissions when its agent changes** | accepted, implementation pending; extends 0007/0033; independent review worktrees and enforceable limits |
| [0055](0055-two-implementations-chosen-at-init.md) | **Every store has two implementations, and init chooses one** | accepted; supersedes 0003's premise; §2's *absence means SQLite* superseded by [0056](0056-the-store-is-a-written-choice.md) |
| [0056](0056-the-store-is-a-written-choice.md) | **The store is a written choice; absence decides nothing at open time** | accepted, implementation pending; supersedes 0055 §2 and 0046's *selected by the presence of LINGTAI_DATABASE_URL* |
| [0057](0057-a-gate-that-did-not-finish.md) | **A gate's agent that started and did not finish gets one retry, then a person** | accepted; extends 0041 with the neighbouring case; governed by 0031 §1. **§4's retry is withdrawn** (`#234`): it recomputed the crashed attempt's session id, so every one of them was refused in zero seconds having run nothing, and the log said *did not finish, twice* about one attempt. §1–3 stand and are what the ADR is worth — whether a step that did not finish buys another agent is 0058 §3c's judge |
| [0058](0058-lingtai-is-a-development-pipeline.md) | **Lingtai is a development pipeline, and a pass is ten steps** | accepted; one step, plugins decide what it does, the pipeline fixes which may refuse; revises 0015's five attachment points and 0047's `GatesResolved`; generalises 0053; its file shape is 0061 |
| [0059](0059-a-point-carries-only-the-kinds-it-runs.md) | **A point carries only the kinds it runs, and the recipe refuses the rest** | accepted; completes 0016 §4 for the ten point × kind cells that were configurable and executed by nothing (#61). **Its rule is kept and its numbers are revised by 0061** — ten steps against ten plugins rather than five points against six kinds, and §3's *`admit` carries nothing* stopped being true on 2026-09-27, when `worktree:` became its plugin (#268, 0065 §4) |
| [0060](0060-the-gate-runs-unit-tests.md) | **The gate runs unit tests, and integration runs after the merge** | accepted; integration is a test that exercises a dependency outside the system — Postgres, GitHub, git, a process, the filesystem, the network, $HOME, the clock; unit touches none; first instance of 0058 §2b choosing a step's contents on evidence |
| [0061](0061-the-recipe-is-the-pipeline.md) | **The recipe is the pipeline, and every step is a list of plugins** | accepted; `steps:` replaces `gates:` with the ten names in order, Ansible's module-as-key because 0037 leaves no third-party plugin to namespace, and every setting moves to the step that owns it; no v1 migration, though the log still needs its upcast |
| [0062](0062-what-a-claim-leaves-behind.md) | **What a claim leaves behind, and what takes it away** | accepted; every claim that produced commits publishes `agent/<n>-attempt-<k>` whatever its ending, replacing `-restart-<k>` — an attempt ordinal is defined for a claim that never restarted and a restart ordinal is not; the agent commits as the work stands; and a landing's cleanup is a plugin at `end`, `when: landed`. Completes 0039 and 0040, which decided where a pass works and when it starts over but not what survives it |
| [0063](0063-every-setting-is-the-recipes.md) | **Every setting is the recipe's, on the step that uses it** | accepted; `~/.lingtai/config.yml` holds the log and nothing else — no `runtime:`, no `projects:`, and no list of installed runtimes, because whether one is signed in is looked at and not written down. **Implements [0053](0053-the-recipe-chooses-the-agent-for-each-role.md)**, which superseded 0046 §3's placement of agent and limits on 2026-09-17 and which `the-v2-recipe.md` §3.6 asks its question without knowing about. `agent:`'s scalar becomes the runtime as an enum, with `model:` and `prompt:` beside it; `rounds`/`restarts` stay where 0061 §3 put them, so a step is still a plain list. **Revises 0061 §§2–3**: `assignee` is a field of `queue:` rather than a plugin, and PLUGINS goes from twelve to eleven |
| [0064](0064-a-plugin-declares-the-steps-it-implements.md) | **A plugin declares the steps it implements, and that is what makes it legal there.** `KINDS_AT`'s 120 cells answered two questions at once — *is this output read here* and *has this step been built* — and could not tell them apart. A plugin carries one function per step it serves, typed by that step; `"*"` is for the ones that do not care which step they are at. Legality is read off the declaration, and a step nobody implements says so by name. |
| [0065](0065-the-default-is-a-plugin.md) | **The default at a step is a plugin, and an unconfigured step runs it.** The workflow guarantees that the ten steps turn and nothing more; no step has a built-in implementation. Seven of the ten keep their work in a body a recipe cannot see, name or replace — which is why the cold reviewer is editable and the agent that writes the code is not. A step the recipe says nothing about runs that step's default plugin; `[]` runs nothing, which is the first thing 0064 §5's *absent is not empty* decides. `CALLED_DIRECTLY` turns out to be the list of defaults that are not plugins yet. |
| [0066](0066-a-large-answer-is-a-locator-on-the-log.md) | **A large answer is a locator on the log, and where it lands is a plugin.** A document goes to a destination and the event records a string only the plugin that wrote it understands; `file:` and `confluence:` are two plugins rather than one with a field. A design is worth buying if it lets a cheaper model implement, and that cannot be measured while it is a paragraph in a prompt. |
| [0067](0067-a-plugin-is-a-declaration-and-an-implementation.md) | **A plugin is a declaration and an implementation, and only the implementation must be ours.** Supersedes 0037 §2 — *there is no plugin system* — whose premise expired when one was built: three built-in kinds became twelve and every step's main work is a plugin. The declaration is data and anyone may supply it; 0037 §1's trust table survives, so third-party code stays a subprocess. |
| [0068](0068-a-step-that-asked-is-not-a-step-that-crashed.md) | **A step that asked and a step that crashed are two endings, not one ending and a string.** `did-not-finish` covered both, told apart by `because === "needs-input"` — a control-flow decision taken on a free-form field at six call sites, every one of which compiles if the token is misspelled or forgotten and silently loses the pass's destination. *Asked* is its own ending and its own event, with the question on `detail` and no `because`; `did-not-finish` keeps the field for the several things only a person reads. Refines 0057, whose grouping is by *cost* and stays true of both. The log is reset rather than upcast (`#296`, [014](experiments/014-the-log-before-the-fourth-reset.md)) — **and §5 says that after 1.0 the answer becomes an upcaster**. |

| [0069](0069-both-the-document-and-the-locator-cross-the-step-boundary.md) | **Both the document and the locator cross the step boundary, and nothing above the plugin reads the locator.** Decides what 0066 §3 left open: `implement` is handed the document *and* the locator, the document is the source of truth, and a locator the plugin cannot read is the ordinary case rather than a failure — so there is no pairing rule and nothing for a recipe to refuse. The other reading, *only the locator travels*, is what would need one, because it makes an unreadable locator a pass with no design at all. The cost taken instead is two copies of one text and nothing that notices when they differ. |
| [0070](0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) | **A dispatch is one shape every plugin embeds, and the ceiling is stated once.** `agent:` and `judge:` each declared their own fields and have already diverged — a runtime judge cannot name a model, so the cheapest call in a pass ($0.42 and one turn on #300, against `implement`'s $22.56 and 150) is the one with no way to ask for a cheap model. `model`, `prompt` and a one-call `limits` become a group a paid plugin embeds; *which* runtime stays the plugin's own key, because only `judge:` needs *not a runtime at all* to be legal. `runtime.limits` is the ceiling and a dispatch may only narrow it, so `lingtai status`'s computed sentence stays readable from the top of the file — which also lands #295's per-step limits as part of the shape rather than as work of its own. Not about `RuntimeId`, which is declared once and derived everywhere already. |
| [0071](0071-a-templated-field-is-judged-twice.md) | **A templated field is judged twice, and the second judgement is at execution.** 0061 §9 validates every plugin at resolve on the grounds that *a recipe has no templating* — true when it was written, and false since `#310` gave `file:` a `{{issue}}`. The rule keeps its force about the string a person wrote; the expansion is judged where it exists, by the same function, and the cost of that one late refusal is 0066 §6's own arithmetic. What it does not license is moving a check to run time because it is easier there — or writing the expansion's check on the template, which is the trap. A second templated field carries the two-judgement obligation with it. |
| [0072](0072-an-earlier-attempt-is-a-locator-the-next-one-is-handed.md) | **An earlier attempt's work is a locator the next attempt is handed, and the cut does not move.** Thirty-one arms — `agent/<n>-attempt-<k>` — sit on the remote and nothing reads one: `priorAttempts` hands the brief `n`, `runId`, how it `ended` and the refusal, and no ref, so an agent learns an attempt happened and never where the code went. `#314`'s quota-killed pass had paid 58 turns and $5.18 for a design that was on `agent/314-attempt-1` while the requeued pass wrote a new one. So the brief carries the arm's name, derived rather than stored, offered only where the ref resolves and beside the ending it had. Always continuing from the arm is refused instead of deferred — it makes a refused approach impossible to abandon, which deletes `restart`'s meaning while leaving the word. Cutting an *interrupted* attempt's successor at its arm is the deferred half, waiting on 015 for how often that happens; §2 records that `--detach` was argued and `baseSha` never was. |
| [0073](0073-tokens-go-on-the-event-and-money-never-does.md) | **Tokens go on the event and money never does, and the rate card is a file a person edits.** `review` runs on Codex since 2026-09-29, and Codex reports no dollars — so that step costs nothing on the board beside a $22.56 implementer, which is #198's *unknown cost reported as free* wearing an absence instead of a zero. `codex.ts:300` sums two of the five counts the stream carries, overwrites itself every turn, and reaches no third file: the test says *"`turns` is the spend leg and `billedTokens` cannot be"*. A sum is not a lossy price but no price — cache reads cost ~0.1x fresh input and cache writes ~1.25x, a 12x spread — and both runtimes already hold the same four counts and drop them. So the five counts and what it takes to price them (model, and mode, because Opus 5 is $5/$25 standard and $10/$50 fast at one model id) go on all four events carrying `costUsd`, every field optional with absent meaning *this runtime did not say*, never zero. Money is computed where it is displayed and never inside a fold, or a rebuild disagrees with the live fold the day a price moves — silently. The rate card is a dated table a person appends to, not the Models API (which carries no price) and not a scraped page. |
| [0074](0074-the-test-side-defaults-to-a-file-of-its-own.md) | **The test side defaults to a file of its own; the reason a fallback was refused stays the reason.** 0046, 0055 §2 and 0056 §4 all refuse the same fallback in the same words — a SQLite default for `LINGTAI_TEST_DATABASE_URL` would let a suite that exists to assert Postgres pass against SQLite — and each was written when that meant *every* integration file. #178 gave the log a second implementation the same month, and #275 is the audit nobody had run since: most files only ever used Postgres as a convenient store. So `storeChoice` now answers SQLite for a test with no Postgres URL, at a file `test-support/teardown.ts` makes and removes per run — never the operator's own `~/.lingtai/lingtai.db` — and the eight files that actually assert `LISTEN`/`NOTIFY`, two clients racing or the Postgres store's own SQL skip rather than run, named on `@lingtai/event-store/test/postgres`'s `ON_POSTGRES` list and held to the code by a unit test rather than to memory (0055 §1, a second time). The reason those three ADRs give is kept; only the mechanism — a blanket refusal versus a per-file, type-checked skip — changes. |
| [0075](0075-a-paid-call-records-its-spend-on-the-event-it-ends-on.md) | **A paid call records its spend on the event it ends on, and a reviewer's ends on a step.** 0073 §4 named the four events carrying `costUsd` — and none of them is written by a `review:` agent: `RunFinished` is the implementer's, `FixApplied` the fixer's, the two `Discussion*` come from `discuss.ts`. A reviewer runs through `agent-action.ts`, whose `ActionResult` has no spend field, so its turns and dollars are interpolated into `evidence` prose and a Codex review's whole durable trace is `(4 turns)` inside a string; a judge's is a run-log line, and the log is deleted when a ticket lands. So 0073 built as written would have left its own §1 example — *a Codex review costs nothing on the board* — exactly where it was. The group therefore goes on `StepPassed`/`StepFailed`/`StepDidNotFinish`/`StepNeverRan` and the judge's record too; `ActionResult` grows a spend field, because the conductor cannot append what the action never handed it; and `costUsd` stops being interpolated into prose. Found by a `design` step for $0.98 four hours after 0073 was accepted, and #208's own contract had said it months earlier. 0073 §5 is untouched: money is still computed where it is displayed, never in a fold. |

