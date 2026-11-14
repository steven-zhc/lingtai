# Aggregate audit: facts held outside their aggregate

**2026-11-14, at `5cc4947f`** (main after #1162; `doc/decisions/0128-…` uncommitted). Read-only.

**Scope.** The same class of problem as
[0128](../decisions/0128-the-project-aggregate-holds-every-project-fact.md): a fact about an
aggregate that the log does not hold, a stream reduced twice or outside `@lingtai/domain`, a
reader that searches many streams to assemble one aggregate's state, a fact written on the
wrong stream or on two, and package-layer breaches against
[0101](../decisions/0101-typescript-packages-effect-unbuilt.md) §4. The machine's
`~/.lingtai/config.yml` is out of scope. What 0128 already decides (the recipe file, `rcp-`,
`SandboxBoundaryRecorded` → `ProjectSandboxObserved`, `@lingtai/recipe`'s file IO) is not
repeated; a finding here is either outside 0128 or an edge 0128 does not name.

**Method.** Every line cited was read. Event-type branches were counted with the
[one-reduce-per-stream](one-reduce-per-stream.md) pattern (`case '<T>'`, `.type ===/!== '<T>'`
over the 76 names in `doc/events.json`, `src/` only, `packages/domain/src` excluded). Package
dependencies were read from each `package.json` and checked against the `@lingtai/*` imports
under `src/`. Plain-logic packages were grepped for `node:fs`, `node:child_process`, `node:net`,
`fetch(`. Nothing here was settled by reading `events`: where a claim is about behaviour at run
time and not about the code, it is marked **unconfirmed**.

## Summary

| #   | Finding                                                                                               | Severity | Owning aggregate               | Evidence                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | `configHash` hashes host state (the detected runtime), so 0128 §6's file-vs-Project compare would see edits nobody made | high     | Project                        | `recipe/src/local.ts:190-191`, `:373-385`; `recipe/src/resolve.ts:268-273`                |
| 2   | *Recently blocked* assembles a project's state from two whole-log type scans, joined in memory, windowed, re-reading raw events the attempt reduce already folds | high     | Project (observed) / Attempt   | `board/src/lib/project-sandbox.ts:17-20`; `sandbox-view.ts:357-414`; `domain/src/attempt.ts:613-616` |
| 3   | A project's sandbox observation is also on the integration stream (`BaseChecked.boundary`), which 0128 §5 does not name | medium   | Project                        | `domain/src/events.ts:1494-1513`; `board/src/lib/sandbox-view.ts:265`                     |
| 4   | `DispatchRefused`, by its own comment *the project's refusal for this pass*, is written to a ticket stream and not on the transition | medium   | Project                        | `conductor/src/conduct.ts:1157-1187`                                                      |
| 5   | The project's base branch is held twice — `ProjectConfigured.base` and the recipe's `repo.base` — and reconciled by a refusal every pass | medium   | Project                        | `conductor/src/onboard.ts:586-590`; `recipe/src/resolve.ts:374-385`; `conductor/src/conduct.ts:951` |
| 6   | `prj-` is appended from three packages and reduced inline in seven places; 0128 §7 routes only the recipe through the project module | medium   | Project                        | `daemon/src/control.ts:749`; `conductor/src/onboard.ts:570-596`, `:642-656`; `cli/src/conduct.ts:898-900` |
| 7   | `spend` and `ticket_report` read a mutable rate file while reducing, so they are not *the log and nothing else* | medium   | Control (installation)         | `projector/src/spend.ts:233`, `:297`; `projector/src/ticket-report.ts:586`, `:648`; `conductor/src/rate-snapshot.ts:1-13` |
| 8   | A `db` project's tickets live in mutable `tickets`/`ticket_comments` tables that no event records and a log reset leaves alone | medium   | Ticket (as its source)         | `conductor/src/db-tickets.ts:5-15`; `conductor/src/ticket-history.ts:11-20`               |
| 9   | `actions` (plain logic) imports `agent` and `sandbox` (touches the world)                             | medium   | —                              | `actions/src/agent-action.ts:55-56`; `action.ts:37`; `process-action.ts:15`, `:23`; `from-recipe.ts:1` |
| 10  | `recipe` (plain logic) imports `sandbox`, including the host read; 0128 §8's move list omits it       | medium   | Project (module)               | `recipe/src/sandbox.ts:20-21`, `:44`; `recipe/src/sandbox-builtins.ts:8`                  |
| 11  | `agent-env` (plain logic, "no IO" per 0101 §7) does file IO in `async` functions and is outside the Effect ratchet | medium   | —                              | `agent-env/src/index.ts:22`, `:410`, `:465`, `:676-697`, `:703-715`; `domain/unit/effect-ratchet.test.ts:38-51` |
| 12  | The board (a host) depends on the daemon (a host); the project pause/resume appenders live there     | medium   | Project (writes)               | `board/src/lib/locks.ts:14`; `board/src/lib/health.ts:20-21`; `board/src/app/actions.ts:51`; `daemon/src/control.ts:764-773` |
| 13  | 0128 §4 inverts a test that forbids deciding from the log's recipe                                    | medium   | Project                        | `conductor/unit/recorded-recipe.test.ts:12-13`; `domain/src/events.ts:1136-1139`          |
| 14  | Which ticket a discussion belongs to is read from `DiscussionRequested` on `ctl-conductor`, not the `chat-` stream that carries it too | low      | Discussion                     | `domain/src/events.ts:2026-2034`, `:2055-2061`; `projector/src/ticket-report.ts:502-505`  |
| 15  | Four projections each keep their own pass→ticket link table                                           | low      | Attempt (`RunStarted.ticketId`)| `projector/src/backlog.ts:151`; `spend.ts:135`; `task-view.ts:227`; `ticket-report.ts:472` |
| 16  | `lingtai init` lists projects by `recipe.yml` directories, not `prj-` streams                         | low      | Project                        | `cli/src/init.ts:1233-1237`                                                               |
| 17  | `ProjectRefused`/`Recovered` are decided and appended by the CLI host, not the conductor               | low      | Project                        | `cli/src/conduct.ts:884-900`                                                              |
| 18  | `agent` and `repo` append events (same-layer dependency on `event-store`)                              | low      | Attempt / Integration          | `agent/src/hook-socket.ts:30`, `:194`; `repo/src/integrate.ts:71`, `:287`                 |
| 19  | Manifest drift: `release` imports `repo` with a dev dependency only; `github` and `site` declare unused deps | low      | —                              | `release/src/tickets-changed.ts:8`; `github/package.json`; `site/package.json`            |
| 20  | Terminology: "repository" for the managed project in ~50 strings; worst are user-facing               | low      | —                              | see §6                                                                                    |
| 21  | Stale docstrings still say the recipe is read from the base branch; `loadProject` already names something else | low      | Project                        | `domain/src/project.ts:9-14`; `domain/src/events.ts:1136-1139`; `conductor/src/projects.ts:55`, `:66` |

## 1. Facts outside the log, read as truth

**F1 — the hash is not the file's (high).** 0128 §6 has the project module compare *the file's
hash with the Project's* and append `ProjectRecipeChanged { by: 'file' }` when they differ. The
hash the code computes today is not a hash of the file. Where the file names no
`runtime.agent`, the resolver asks the host which runtime is signed in
(`recipe/src/local.ts:190-191`: *"detected — the only runtime signed in"*), writes that answer
into the raw recipe before parsing (`local.ts:373-385`: *"the callback below sets
`raw.runtime.agent` to the detected runtime where the file names none"*), and hashes the
resolved form (`resolve.ts:268-273`: *"The resolved form is what gets hashed, so the preset is
inside the hash"*). So signing a runtime in or out, or a code change to a preset, changes
`configHash` with no edit to the file. Built as written, §6 would append a `by: 'file'` change
nobody made, and two machines reading the same file could disagree. The probe is cached per
process for a minute (`conductor/src/projects.ts:149-168`), so the change can also come and go
between readers. **Direction:** 0128 §6 compares a hash of the file's *canonical text* (what
the person wrote); the resolved hash stays the run's `StepsResolved.configHash`. The ADR should
say which hash `ProjectRecipeChanged` carries.

**F8 — db tickets (medium).** For a project whose source is `db`, ticket rows are *"a plain
`INSERT INTO tickets`"* (`ticket-history.ts:14-17`) and *"nothing here appends an event: a
reset of `events` (007, 010) leaves them alone"* (`db-tickets.ts:13-15`); comments are edited in
place (`db-tickets.ts:24-26`). This is deliberate (#379, a store for a project with no GitHub
App), and it plays GitHub's part — an input, not the record. But Lingtai writes it, so after a
log reset the log and the store disagree, and `ticketsForEffect` has to scan every
`ticket-{project}-*` stream to decide whether a source switch would strand work
(`ticket-store.ts:284-289`). **Direction:** decide it explicitly: either an external source
(documented as such, like GitHub), or ticket facts that are events.

**F7 — rate file inside two projections (medium).** `spend` and `ticket_report` estimate an
unpriced `RunSpent` from `readRateSnapshot()` while reducing (`spend.ts:233`, `:297`;
`ticket-report.ts:586`, `:648`), and the snapshot is a file a refresh rewrites from LiteLLM
(`rate-snapshot.ts:1-13`, `:96-112`). So a rebuild on another day or machine stores different
estimates, which contradicts *"each is reduced from the log and nothing else"* (CLAUDE.md). The
day ceiling reads those estimates (`cli/src/day-ceiling.ts:118`, `:169`). **Direction:** record a
price change as an event, or keep the estimate at read time and out of the stored row.

**Lower, or deliberate:**

- `lingtai init` names projects by `existsSync(join(home, name, 'recipe.yml'))`
  (`cli/src/init.ts:1236`), a second list beside `prj-` streams (F16, low). It may run before a
  store exists, which would justify it; the line says nothing either way.
- The project's environment file `~/.lingtai/env/<project>.env` (`agent-env/src/index.ts:279-281`)
  has no event when it changes — the same shape as the recipe before 0128. Its values are
  secrets and must stay off the log; names and *changed at* need not. Low.
- In memory by design, with the reason written down: the scheduler's tried-this-pass set
  (`conductor/src/schedule.ts:30-34`), `task_view` stopped (`daemon/src/daemon.ts:85-88`), the
  spend rebuild hold, which the board cannot see (`board/src/lib/locks.ts:304-310`). The queue is
  GitHub's (`domain/src/events.ts:1840`, 0012) and the beacon is `daemon_status` (`cli/src/service.ts:688`).
  None is a finding.
- GitHub state used for decisions was checked: `discover.ts:215`, `converge.ts:417`, `:431`,
  `blocker-state.ts:61`, `:69` read GitHub as input or as the target of convergence, never as the
  record of something the log should hold.

## 2. Reduced twice, or outside `domain`

**The earlier audit is largely closed.** [one-reduce-per-stream](one-reduce-per-stream.md)
counted 138 branches in 34 files plus 13 `!==`, 48 of them a second reduce (class F). The same
pattern today finds **45 in 19 files**, and none is class F. What is left is projection links
(`spend`, `ticket_report`, `backlog`, `task_view`), reactions (`extension/src/index.ts:110-126`,
`work-loop.ts`, `triage.ts:326`, `:338`), renderers (`history.ts:807-809`, `markdown.ts:89`), and
lookups the earlier audit already said to leave (`base-check.ts:138`, `end-step.ts:100`,
`create-app.ts:906`, `split-ticket.ts:212`, `converge.ts:387`, `tell.ts:770`). Spot checks: the
board's `standingOf` calls `reduceTicket` and reads `lastMove` (`task.ts:828-857`); `backoffOf` reads
`reduceTicket(own).lastAttemptAt` (`queued.ts:237-238`); `priorAttempts` is `reduceTicket`'s
`claims` (`attempts.ts:167-183`); `task_view` reduces both halves through
`reduceAttemptEvent`/`reduceTicketEvent` (`task-view.ts:693`, `:716`). Eight domain reducers now
exist: `account`, `attempt`, `backlog` (`reduceFinding`), `chat`, `control`, `integration`,
`project` and `ticket`.

**One new instance — F2's second half.** `projectBlockedOf` parses each
`SandboxConnectionsRefused` row itself (`sandbox-view.ts:383`) and adds every entry
(`:394-405`). The attempt reduce already folds that event into the invocation it names,
replacing the earlier reading (`attempt.ts:613-616`, through `withSandbox` at `:441-462`). So
the recipe page and the attempt's Sandbox tab can read the same events differently: the tab
keeps the latest reading per `commandId`, the page sums every row. Whether two readings for
one `commandId` ever occur is **unconfirmed**. The host tally is also written twice, the same
rule at `sandbox-view.ts:291-310` and `:394-405`.

## 3. Searching across streams for one aggregate

**F2 — the recipe page's *recently blocked* (high).** It is #1163's shape, and it is on
`main`: *"Read on render with two whole-log reads and no projection, joined in memory"*
(`project-sandbox.ts:4`). It reads every `TicketClaimed` and every `SandboxConnectionsRefused`
in the log (`:18-19`), keeps the claims whose stream starts with the project's prefix and whose
tail is all digits (`sandbox-view.ts:367-369`), maps run id → issue, then drops rows outside
`RECENT_DAYS = 14` (`:338`, `:374-382`). It is needed because *"a refusal lands on a
`pass-<uuid>` stream that names no project"* (`:350-351`). #1162 already needed a fix round for
that join and window: `e303e6e4`, *"recently blocked matches a project by its issue number,
dates its caveats"*. Each render reads every row of those two types in the log. **Direction:** 0128 §5's `observed` covers the
boundary only. *Recently blocked* needs its own fact on `prj-` (or a projection), and the
attempt's reduce should be its only reading of the event.

Checked and not findings: `projectStreams(prefix)` is how a project's own streams are listed
(`conductor/src/projects.ts:47-51`, `ticket-history.ts:26`, `ticket-store.ts:287`). The only
other whole-log scan is `cli/src/day-ceiling.ts:31-33`, which the earlier audit already says to
leave. `reconcile.ts:313-386` lists `worktrees/` and `runs/` and asks the log about each one —
the log is the truth there. No other windowed or capped search was found.

## 4. A fact on the wrong stream, or on two

- **F3 (medium).** The base check records the sandbox it ran under on the integration stream:
  `BaseChecked.boundary` (`events.ts:1505`), and the Sandbox tab says so (*"#1153's base check
  records its boundary on `BaseChecked` on the `int-` stream, not here"*, `sandbox-view.ts:265`).
  0128 §5 derives `ProjectSandboxObserved` from `SandboxBoundaryRecorded` on attempts only. A host
  that degrades the base check and not the runs would show *sandboxed*. **Direction:** name
  `BaseChecked` in §5 as a source of the observation too.
- **F4 (medium).** `DispatchRefused` is appended to the queue's top ticket
  (`conduct.ts:1174-1181`), though the comment calls it *"the project's refusal for this pass"*
  that *"pauses nothing"* (`:1162-1163`). The pass returns `ok: false` rather than failing
  (`:1182-1187`). `turnTransition` is reached only when a project's work fails
  (`cli/src/conduct.ts:850-875`), so whether a dispatch refusal ever reaches `prj-` is
  **unconfirmed**. Nothing found in `conductor/src` or `daemon/src` feeds it there. `reduceTicket`
  does not read it either: it is a note in `task-view.ts:358`.
  So the fact is not transition-only, and it sits on a ticket where it belongs to the project
  and its recipe. Whether every pass appends it again is **unconfirmed** — read the log for
  repeated `DispatchRefused` on one stream. **Direction:** a `ProjectRefused`-shaped transition on
  `prj-`.
- **F5 (medium).** The base: `ProjectConfigured.base` is *"a copy of the recipe's
  `repo.base`"* (`onboard.ts:586-590`), and `baseDivergence` refuses each pass when the two
  disagree (`resolve.ts:352-385`, called at `conduct.ts:951`). Under 0128 both halves are one
  aggregate, so one should be derived from the other. **Direction:** the Project's base is the
  recipe's, and registration does not record a second one.
- **F14 (low).** `DiscussionRequested` on `ctl-conductor` carries `chatId`, `ticketId`, `question`
  (`events.ts:2026-2034`); the `chat-` stream's own `DiscussionAsked` carries `ticketId` and
  `question` again (`:2055-2061`). The projections link a chat to its ticket off the control
  event (`ticket-report.ts:502-505`; `spend.ts:194`).
- **F15 (low).** Every projection keeps its own pass→ticket link (`finding_backlog_run`,
  `spend_stream`, `task_view_run`, `ticket_report_stream`; the last is *"this projection's own,
  never `spend_stream`"*, `ticket-report.ts:470`). It is deliberate, because each rebuilds
  alone. The cost is four copies of one join.
- The recipe's hash is on `ProjectConfigured`, `RunStarted` and `StepsResolved` (`events.ts:2253`,
  `:598`, `:1145`). 0128 already covers that.

## 5. Layers (0101 §4)

Declared `@lingtai/*` dependencies match the imports, except for F19. Against the layers:

| Package (layer)                 | Depends on                                       | Breach                                                                                |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `domain` (vocabulary)           | `zod` only; no `effect`, no `node:`              | none                                                                                  |
| `extension` (plain)             | nothing                                          | none                                                                                  |
| `env` (plain)                   | nothing                                          | IO by 0101 §7 (`Config`, the lock)                                                    |
| `agent-env` (plain)             | `env`                                            | **F11**: `node:fs/promises` (`index.ts:22`), six `async` functions (`:410`, `:455`, `:658`, `:676`, `:703`, `:736`); not in ratchet `PACKAGES` |
| `recipe` (plain + loaders)      | `domain`, `env`, **`sandbox`**                   | **F10**: `readHost` imported (`sandbox.ts:21`), and `HOST_FOR_SAVING` bakes it in (`:44`) |
| `actions` (plain + IO)          | `domain`, `recipe`, **`agent`**, **`sandbox`**   | **F9**: `runtimeVersionOfEffect` and `Runtime` from `agent` (`agent-action.ts:55`), `taggedTrace` from `agent/run-log` (`action.ts:37`) |
| `agent`, `repo` (world)         | `event-store` (same layer)                       | F18, low: `repo` *integrate* is in 0101's own list                                    |
| `setup` (unplaced)              | `actions`, `agent`, `agent-env`, `domain`, `github`, `recipe`, `repo` | none; it stays below `conductor` (`ticket-history.ts:7-9` avoids the cycle) |
| `conductor` (decisions)         | everything below, `setup`                        | none                                                                                  |
| `apps/board` (host)             | … **`daemon`** (host)                            | **F12**: `locks.ts:14`, `health.ts:20-21`, `actions.ts:51`, `task.ts:6`, `board.ts:7`, `queued.ts:5`, `draining.tsx:26`, `api/webhook/route.ts:1` |
| `apps/cli` (host)               | … `daemon`                                       | sanctioned: the CLI runs the daemon (0101 §6)                                         |

F12 matters beyond layering: `pauseProject`/`resumeProject` (`daemon/src/control.ts:764-773`)
are writes to `prj-`, so the board reaches a host to change a project. That is part of F6. The
writers of `prj-` are `daemon/src/control.ts:749`, `conductor/src/onboard.ts:596` and `:654`, and
`apps/cli/src/conduct.ts:900`. The readers that reduce it inline are `daemon/src/control.ts:732`,
`daemon/src/guard.ts:77`, `:125`, `conductor/src/projects.ts:58`, `board/src/app/actions.ts:628`,
`board/src/lib/locks.ts:256` and `cli/src/conduct.ts:898`. **Direction:** 0128 §7's `@lingtai/project`
owns every `prj-` append and read, not only the recipe's, and the board stops importing the
daemon for it.

## 6. Terminology

Outside tests, **514 comment lines** and **98 string literals** say *repository*. About 49 of
the strings are not about GitHub, a clone, a mirror, a remote or an installation, and most of
those mean the project. The worst examples:

- **User-facing:** *"no repository name recorded — re-run lingtai add"*, six copies
  (`conductor/src/projects.ts:250`, `filter.ts:270`, `ticket-store.ts:277`, `ownerless.ts:56`,
  `cli/src/doctor.ts:3112`, `:3311`), which is the project's name. The board's `+` says *"add a
  repository"* (`board/src/app/projects.tsx:35`) and goes to `/setup/repository`. The CLI's next
  step is *"the repository Lingtai works on"* (`cli/src/next-steps.ts:50`).
- **Identifiers:** the board action `addRepository` registers a project
  (`board/src/app/setup/repository/read/actions.ts:69`). `onboard.ts` names the project `repo`
  (`projectStream(repo)`, `project: repo`, `:570`, `:584`), and the domain does the same
  (`project.ts:86-87`).
- **Vocabulary docstrings:** `projectStream` is *"everything Lingtai was told about a
  repository"* (`streams.ts:108`), and `ticketOf` says the installation streams *"belong … to no
  repository"* (`streams.ts:190-191`).

Correct as they are: `pickRepository`/*"which repository"* (`cli/src/add.ts:85`, `:127`, choosing
the GitHub repository), `listRepositories`, `installationRepositoriesEffect`, `mirrorPathFor`,
`repoRoot`/`repoPath` (a clone).

## Suggested order

1. **Settle F1 in 0128 before it is built.** It is the one finding that would make the new
   module write wrong events from its first read. The ADR has to say what hash §6 compares and
   what `ProjectRecipeChanged` carries.
2. **Build 0128 with F3, F6 and F13 folded in.** §5 should read `BaseChecked` as well as
   attempts (F3). `@lingtai/project` should own every `prj-` write and read, so the board's import
   of the daemon for pause and resume goes away with it (F6, F12). `recorded-recipe.test.ts`'s
   *nothing decides from it* has to be rewritten in the same change, or §4 is red on arrival
   (F13).
3. **F2 next**: give *recently blocked* a reduced source and delete the whole-log join. It is
   the live instance of #1163's class, and it costs two whole-log reads on every recipe-page
   render.
4. **F4 and F5**, which become small once the Project aggregate owns the recipe: the dispatch
   refusal becomes a project transition, and the base has one source.
5. **The layer fixes (F9, F10, F11)**, each its own ticket. Add `agent-env` to the ratchet's
   `PACKAGES` first, so its `async` functions are counted before anyone moves them.
6. **F7 and F8 are decisions before they are tickets**: whether a price is an event, and whether
   the db ticket store is an input or a record.
7. Terminology and the low findings, as documentation tickets — not bundled into the code
   tickets above.

## Per aggregate (second pass)

**2026-11-14, same commit.** Every aggregate except Project, one section each. Findings F1–F21
above are referred to by number and not repeated. Method as above, plus: every append site
under `src/` (`store.append(`, `events.append(`, and the local wrappers `appendNow`,
`appendAt`, `appendFrom`, `appendEvent`, `appendInvocation`, `recordEffect`), every use of each
domain reducer, every `rowsOfType`/`readAll`/`projectStreams`/`readTypes`, and the store's own
SQL in `event-store/src/queries.ts`. `doc/events.json` (generated at `a3438d1a`, 16 commits
back) was used as a map of append sites and each site was re-read at `5cc4947f`. A *module* below
is one source file.

| Aggregate | Writer modules | Owning module | Second reduces | Facts outside the log | Cross-stream reads | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Ticket `ticket-` | 13 (conductor 9, daemon 2, board 1, cli 1) | no | 2 in store SQL, 1 projection partial, raw `EndActionsResolved` reads | queue, labels, blocked-by, body on GitHub (input); db tickets (F8) | queue decided from `task_view`; requests on `ctl-`; claims found by type scan | needs an ADR-level fix |
| Attempt `pass-` | 4 (conductor 3, agent 1), one process | no (one process) | F2 only; an in-memory spend sum | none new (run logs are a trace) | `StepEnded` → ticket needs `RunStarted` (F15); F2 | minor issues |
| Integration `int-` | 2 (repo, conductor) | no | `BaseChecked` looked up outside the reduce | lane order in process memory (deliberate) | none | minor issues |
| Control `ctl-conductor` | 6 (daemon 3, conductor 1, board 2) | no, though its docstring says yes | raw lookups only, in the module | none | three request lists satisfied on other streams | minor issues |
| GitHub App `ctl-github-app` | 1 | yes | inline last-event lookup, no domain reducer | credentials in `config.yml` (deliberate, out of scope) | none | healthy |
| Account `acct-` | 1 | yes | none | none | none (recipe picks which accounts) | healthy |
| Discussion `chat-` | 1 (+ the request on `ctl-`, board) | yes for `chat-` | none | one-at-a-time is a process semaphore in the CLI | outstanding = `ctl-` requests minus `chat-` answers | minor issues |
| Backlog finding `bkl-` | 1 | yes | none (projection calls the domain reduce) | none | the finding itself is a projection row joined from `pass-` | minor issues |
| `ext-subscribers` | 1 | yes | none | the recorder's version is held in memory, re-read on conflict | doctor counts by type in SQL (a report) | healthy |

### Ticket `ticket-{project}-{issue}`

1. **Writers — 13 modules, two of them hosts.** conductor: `claim.ts:182`, `:255`, `:298`;
   `ask.ts:85`; `conduct.ts:1175` (F4), `:2658`, `:5381`, `:5661`, and the end plan at `:1607`,
   `:5211`; `resolve-wait.ts:421`; `split-ticket.ts:241`; `close.ts:250`; `end-step.ts:173`;
   `tell.ts:406` (`recordEffect`, also used by `write-section.ts:121`); `discuss.ts:749`, `:791`.
   daemon: `reconcile.ts:698`, `converge.ts:590`. Hosts: the board's `editPrompt` appends
   `PromptEdited` at `events.length` with no reduce (`board/src/app/actions.ts:743-744`) — the same
   type `discuss.ts:749` appends; the CLI appends `WaitTriaged` (`cli/src/triage.ts:262`, `:1279`),
   `TriageStarted` (`:840`) and `RunSpent` (`:988`). `TicketDiscovered` is reduced
   (`domain/src/ticket.ts:480`) but nothing under `src/` appends it; its only site is the
   bootstrap probe (`event-store/scripts/bootstrap.mjs:54`), so a stream begins at its claim.
2. **Readers and reduce.** Readers go through `reduceTicket`/`ticketReducer` (board `task.ts`,
   `queued.ts`, conductor, daemon, `task_view`). Second reduces:
   - **The store reduces two ticket facts in SQL.** `unconvergedUpdates` is an anti-join over every
     `IssueUpdated`/`IssueUpdateFailed` in the log (`event-store/src/queries.ts:328-349`), the same
     rule `reduceTicket` folds into `github` (`ticket.ts:596`, `:617`) and `converge` reads
     (`daemon/src/converge.ts:379`). Its docstring says *reconcile converges* it
     (`queries.ts:166-176`); its only caller is `lingtai doctor` (`cli/src/doctor.ts:2305`). So the
     doctor row and the converge can disagree about one issue. `endedWithoutEndActions` likewise
     joins ticket and attempt streams in SQL (`end-step.ts:243-256`).
   - `EndActionsResolved` is not in `reduceTicket` (no `case`, `ticket.ts`) and is read raw at
     `end-step.ts:99-101`, `converge.ts:386-392`, `tell.ts:769` (the first pass accepted these as
     lookups). `doc/events.json` lists its stream as `pass-`; the code appends it to the ticket
     (`end-step.ts:173`, `close.ts:250`).
   - `ticket_report` ends a claimed interval by event type (`TicketLanded`, `WaitStarted`,
     `TicketReleased`, `TicketClosed`, `projector/src/ticket-report.ts:528-535`) while it opens one
     from the reduce's `after` (`:508-524`): half a lifecycle rule, outside `domain`. Low.
   - The CLI's triage decides a lost race by scanning the slice for `TriageStarted`
     (`triage.ts:863-866`), though `TicketWait.triage.started` already reduces it
     (`ticket.ts:95`). Low.
3. **Facts outside the log.** The queue, kind, labels and blocked-by are GitHub's and read as
   input (0012; `claim.ts:47-55` copies title, kind and body onto `TicketClaimed`). Labels are a
   convergence target, and what Lingtai wrote is `IssueUpdated` — correct. `db` tickets: F8.
4. **Cross-stream.**
   - **What to claim next is decided from the `task_view` projection**, not the reduce:
     `selectRunnableEffect` reads `readTasks` and keeps rows whose `state` is `queued`
     (`conductor/src/queue.ts:77-112`; *"It reads the projector's view and decides"*, `:10`).
     The claim re-reads the reduce at a version (`claim.ts:182`), so a stale row costs a lost
     claim, not a double one. Whether a lagging `task_view` ever made a pass pick a ticket the
     reduce had moved on is **unconfirmed** (read the log for a `TicketClaimed` refused after a
     `queued` pick).
   - Two ticket facts are written to `ctl-conductor` and their liveness is a join back to the
     ticket: `ContinueRequested` (`resolve-wait.ts:555`, after `WaitResolved` at `:421`, two
     appends, the second retried and never failing the first, `:536-541`) is *owed* only while the
     ticket reduces as `approved` (`cli/src/continuing.ts:25-37`, read at `cli/src/run.ts:537-550`);
     `RunRequested` (`daemon/src/control.ts:449`) likewise.
   - Reconcile finds claimed tickets by selecting streams by type under each project prefix
     (`daemon/src/reconcile.ts:522-529`) and reduces each. Correct; there is no index of claims.
5. **Misplaced facts.** `ContinueRequested`/`RunRequested` above. `DispatchRefused` (F4). Agent runs
   that are not attempts write run facts here: triage's `RunPrompted` (`triage.ts:1062-1065`) and
   `RunSpent` (`:988`) — so spend lives on `pass-`, `chat-` and `ticket-` (see Attempt).
6. **Invariants.** One claim at a time is the expected-version append in `claim.ts` (`:9-11`),
   and `reconcile` re-reads before releasing (`reconcile.ts:669-686`). There is no transition
   function for a ticket in `domain` — unlike Account (`reachTransition`), Control
   (`raiseTransition`, `ceilingCheck`) and Project (`pauseTransition`, `turnTransition`) — so each
   of the 13 writers checks the lifecycle itself (e.g. `resolve-wait.ts:405`, `ask.ts:80-82`,
   `close.ts:247-250`, `triage.ts:1273`), and the board's `editPrompt` checks nothing.
7. **Verdict: needs an ADR-level fix.** One `ticket` module owning every append and read, with
   the lifecycle rules as domain transitions; the queue's subtraction reads the reduce (or the
   ADR says why the projection is enough); the two SQL reduces go or call the domain rule.

### Attempt `pass-{uuid}`

1. **Writers — 4 modules, all in the conducting process.** `conductor/src/conduct.ts` through
   `appendAt`/`appendNow`/`appendFrom` (`:772-830`) and `emit` (`:4321-4337`, which is how
   `run-attempt.ts`'s `StepStarted`/`StepEnded` arrive, `run-attempt.ts:1833-1836`);
   `sandbox-record.ts:69`, `:117` through the `appendInvocation` port (`conduct.ts:836-870`);
   `record-prompt.ts:112`; `agent/src/hook-socket.ts:194` (F18). No host appends.
2. **Readers and reduce.** `reduceAttempt`/`attemptReducer` in 14 files outside `domain`; `task_view`
   via `reduceAttemptEvent`. No second reduce beyond F2. The pass keeps a running spend sum in
   memory beside its `RunSpent` appends (`conduct.ts:1730`, `:2986`, `:4325-4328`) for the person's
   summary only (`:5177`). The walk holds `roundsSpent` in memory (`run-attempt.ts:1351`), seeded
   on a resume from the reduce (`conduct.ts:1227`) — write-side state, correct.
3. **Facts outside the log.** None new. Two writers share the stream's version **in process
   memory**: the hook server appends at its own `run.version`, so the conductor's invocation rows
   use the registered version (`conduct.ts:836-866`, #1164). Correct for one process; it is why
   the stream cannot have a writer in another.
4. **Cross-stream.** A `StepEnded` names a run and no ticket, so a reader needs `RunStarted`
   (`domain/src/streams.ts:183-188`); that is F15's four link tables. F2.
5. **Misplaced facts.** Run facts of agents that are not attempts live on their host's stream:
   `RunPrompted`/`RunSpent` for a discussion on `chat-` (`discuss.ts:585-590`, `:613`) and for
   triage on `ticket-` (above). The pass↔ticket link is written on both sides
   (`TicketClaimed.runId`, `RunStarted.ticketId`). `MergeLaneWaited` is an attempt fact on the
   attempt (`conduct.ts:3417-3433`) — correct.
6. **Invariants.** Appends read the length and append (`conduct.ts:772-776`); no transition is
   checked against `AttemptState`. Order is guaranteed by being one fiber in one process.
7. **Verdict: minor issues.** Name `conduct.ts`'s append helpers the attempt's one writer (with the
   hook server as its port), and decide whether non-attempt agent runs get an attempt-shaped
   stream of their own so spend has one home.

### Integration `int-{project}-{base}`

1. **Writers — 2.** `repo/src/integrate.ts:286` (`IntegrationAttempted`/`Refused`/`Succeeded`, F18)
   and `conductor/src/base-check.ts:299` (`BaseChecked`).
2. **Readers and reduce.** `reduceIntegration` is called once outside `domain`, for `.version`
   (`integrate.ts:286`). **Nothing reads its state**: no use of `lifecycle`, `landed`,
   `refusals` or `refusalsByReason` outside `domain/src/integration.ts` was found. `BaseChecked` is
   not in the reduce (`integration.ts:72-122`) and is looked up raw, newest first, by
   `baseSha`/`command`/`boundary` (`base-check.ts:127-152`) — a cache read, but a rule about this
   stream outside `domain`. `ticket_report` reads the three integration types to mark a sign of
   life (`ticket-report.ts:569-577`).
3. **Facts outside the log.** One landing at a time per project and base is an in-process lane
   (`conductor/src/landing-lane.ts:1-13`), deliberate (0102).
4. **Cross-stream.** None.
5. **Misplaced facts.** A landing is two appends on two streams: `IntegrationSucceeded` here and
   `TicketLanded` on the ticket (`board/src/lib/progress.ts:368-371` says the caller is *"the only
   one holding the fact"*). A refusal is here and, as the merge action's result, in `StepEnded` on
   the attempt (`conduct.ts:5345-5347`). F3 (`BaseChecked.boundary`).
6. **Invariants.** None enforced on the stream: `attempting` excludes nothing (#194,
   `integration.ts:21-26`); git's ref update and the in-process lane order landings.
7. **Verdict: minor issues.** Either give the reduce a reader (the refusal tally was its reason,
   `integration.ts:13-14`) or shrink it to what is read; put `BaseChecked` in it.

### Control `ctl-conductor`

1. **Writers — 6 modules, 2 in a host.** `daemon/src/control.ts:167`, `:215` (resume, shutdown,
   start, run requests, the raise); `daemon/src/guard.ts:103-107` (ceiling transitions);
   `daemon/src/reconcile.ts:871-873` (`Reconciled`); `conductor/src/resolve-wait.ts:555`
   (`ContinueRequested`); the board's `askDiscussion` (`board/src/app/actions.ts:633-634`,
   `DiscussionRequested`) and webhook (`board/src/app/api/webhook/route.ts:63-72`, `QueueChanged`).
   The reducer's own header says the opposite: *"everything that appends to the stream still goes
   through the commands there"* (`domain/src/control.ts:13-15`).
2. **Readers and reduce.** `reduceControl` through `readControlEffect` (`daemon/src/control.ts:129`)
   everywhere. Raw reads: `startAfterEffect` and `requestsBetween` (`control.ts:361-398`, in the
   owning module, lookups the reducer deliberately drops); `withoutReported` reads every
   `Reconciled` (`reconcile.ts:208-214`); the webhook de-duplicates by reading every
   `QueueChanged` (`route.ts:64-70`). All lookups, none a second state.
3. **Facts outside the log.** None.
4. **Cross-stream.** `requested`, `continuing` and `discussions` grow for ever: the reduce never
   removes an entry, because each is satisfied by a fact on another stream (`control.ts:85-111`).
   `continuing` is joined to the ticket (`cli/src/continuing.ts:25-37`), `discussions` to `chat-`
   (`cli/src/discuss.ts:528-546`), and the board lists a ticket's chats from both
   (`board/src/lib/task.ts:1903`). **No reader of `ControlState.requested` was found** (grep for
   `\.requested\b`); `RunRequested` acts only as a wake-up (`daemon/src/work-loop.ts:146`).
5. **Misplaced facts.** Three requests that belong to other aggregates: `ContinueRequested`
   (ticket), `RunRequested` (ticket), `DiscussionRequested` (discussion; F14). The reason is the
   daemon's wake-up, not ownership. The day ceiling's `DayCeilingReached` is decided from the
   `spend` projection (`guard.ts:99`), so F7's rate file reaches this stream.
6. **Invariants.** Each writer reads the head and appends at it; the ceiling's rules are domain
   transitions (`ceiling-lock.ts:92`, `:147`), pause/resume and shutdown are in `control.ts`.
   The webhook's and the board's appends carry no rule but the version.
7. **Verdict: minor issues.** Route every append through `daemon/src/control.ts` (or a domain-level
   control module), and decide whether a request lives on the aggregate it is about, with the
   daemon woken by type instead of by stream.

### GitHub App `ctl-github-app`

1. **Writers — 1.** `conductor/src/create-app.ts:647-656`, at `existing.length`.
2. **Readers and reduce.** `recordedAppEffect` (`create-app.ts:899-913`), newest
   `GitHubAppCreated`, used only by `configurationEffect` in the same file (`:972`). No domain
   reducer; one event type and one lookup, so a reducer would add nothing. 0101 §4 read
   literally says otherwise.
3. **Facts outside the log.** The credentials are `config.yml` and the environment, and the module
   says why the log records *minted* and never *configured* (`create-app.ts:626-642`, `:947-952`).
4. **Cross-stream.** None. 5. **Misplaced.** None. 6. **Invariants.** In the module; a second App
   can be minted on purpose.
7. **Verdict: healthy.**

### Account `acct-{runtime}`

1. **Writers — 1.** `conductor/src/account.ts:39-63` (`transitionAccount`), called by
   `conduct.ts:1661`, `daemon/src/guard.ts:134`, `board/src/lib/locks.ts:371`,
   `cli/src/account-lift.ts:33` — all through it. The key is the runtime (`streams.ts:116`), where
   0128's table says `acct-{platform}`.
2. **Readers and reduce.** `readAccount`/`accountsFor` (`account.ts:29-33`, `:110-124`) and
   `doctor.ts:1479`. One reduce.
3. None. 4. **Cross-stream.** Which accounts apply is the project's recipe (`account.ts:110-118`),
   which is 0128's business.
5. None. 6. **Invariants.** Transition-only, in `domain/src/account.ts:71-100`, retried once on a
   lost race (`account.ts:56-60`).
7. **Verdict: healthy** — the template for the others.

### Discussion `chat-{id}`

1. **Writers — 1 for the stream.** `conductor/src/discuss.ts:526`, `:554`, `:613`
   (`DiscussionAsked`, `DiscussionAnswered`, `RunSpent`); the same module appends `DiscussionHeld`
   and `PromptEdited` to the ticket (`:749`, `:791`). The request is the board's, on `ctl-`
   (`board/src/app/actions.ts:633-634`).
2. **Readers and reduce.** `reduceChat` everywhere (`cli/src/discuss.ts:546`, `:567`;
   `board/src/lib/task.ts:1089`). No second reduce.
3. **Facts outside the log.** *One answer at a time* is a module-level semaphore in the CLI host
   (`cli/src/discuss.ts:590`, #996): two processes would each answer. Today only the lock holder
   answers, so this holds; it is an invariant in memory.
4. **Cross-stream.** *Is a question outstanding* is `ControlState.discussions` (every request
   ever) minus the chat's answered count (`cli/src/discuss.ts:521-546`), scanned over all chats on
   every request, resume and start.
5. **Misplaced facts.** The question is written twice, `DiscussionRequested` on `ctl-` and
   `DiscussionAsked` here (F14).
6. **Invariants.** In the CLI host, not the module that writes the stream.
7. **Verdict: minor issues.** Put the request on `chat-` and the answering loop beside
   `discuss.ts`; the outstanding question then reduces from one stream.

### Backlog finding `bkl-{project}-{key}`

1. **Writers — 1.** `conductor/src/backlog.ts:281`, `:335`, `:445`; both hosts call it
   (`backlog.ts:7-9`).
2. **Readers and reduce.** `reduceFinding` (`backlog.ts:213`, `:380`); the projection calls
   `reduceFindingEvent` on a state rebuilt from its row (`projector/src/backlog.ts:169-207`).
3. None. The issue opened is the ticket store's, recorded by `FindingProposed`.
4. **Cross-stream.** The stream holds only the decision. *That a finding exists*, and what it
   says, is `StepEnded` on an attempt joined through `finding_backlog_run`
   (`projector/src/backlog.ts:146-154`, `:209-240`), and a decision first reads that projection
   (`readBacklog`, `backlog.ts:205`) before the log (`:212`). So an accept or decline is gated on a
   projection's row, and on F15's link.
5. None. 6. **Invariants.** In the module and the reduce: version-0 accept and decline
   (`backlog.ts:281`, `:445`), and the reduce throws on an order no writer makes
   (`domain/src/backlog.ts:89-127`).
7. **Verdict: minor issues** — only the projection gate; acceptable while minors are raised on
   attempts, worth a line in the ADR that owns findings.

### `ext-subscribers`

1. **Writers — 1.** `daemon/src/failure-recorder.ts:57-59`; its version is held in memory and
   re-read on any conflict (`:32-40`, `:68`).
2. **Nothing derives aggregate state from it.** Its one reader is `lingtai doctor`'s
   `subscribers: failures`, through the store's `subscriberFailures` — a count by `type =
   'PluginFailed'` over the whole log, windowed to a day (`event-store/src/queries.ts:353-366`,
   `cli/src/doctor.ts:2338-2341`). A report, and no decision reads it. The recorder skips a
   `PluginFailed` to avoid a loop (`failure-recorder.ts:86`).
3.–6. Nothing to report.
7. **Verdict: healthy.**

### What the aggregates have in common

1. **Where there is one owning module, the aggregate is healthy.** Account, GitHub App, Backlog,
   `ext-subscribers` and the `chat-` stream each have one file that reads, decides and appends,
   and each is clean. Every aggregate with more than two writer modules has a finding: Ticket (13),
   Control (6), Project (F6). The size of the aggregate is not the cause — Attempt has the most
   events and is fine because its writers are one process's.
2. **Hosts append directly.** The board appends to `ticket-` (`actions.ts:744`) and `ctl-`
   (`actions.ts:634`, `webhook/route.ts:72`); the CLI to `ticket-` (`triage.ts`, four sites) and
   `prj-` (F17). Each carries its own copy of the rule it needs, or none (`editPrompt`).
3. **Transitions live in `domain` only for the small aggregates.** Account, Control's ceiling and
   Project have `…Transition` functions; Ticket and Attempt, which carry the rules that cost money,
   have none, so each writer re-checks the lifecycle.
4. **Requests are written where the daemon listens, not where they belong.** `ctl-conductor` holds
   ticket and discussion requests whose satisfaction is on another stream, so three state lists
   grow for ever and are joined back at read time; one of them (`requested`) is read by nothing.
5. **One decision, two appends on two streams.** Approve (`WaitResolved` + `ContinueRequested`),
   land (`IntegrationSucceeded` + `TicketLanded`), ask (`DiscussionRequested` + `DiscussionAsked`),
   claim (`TicketClaimed.runId` + `RunStarted.ticketId`). Each pair is non-atomic; the readers
   cope by joining.
6. **The store and the projections reduce too.** `unconvergedUpdates` and `endedWithoutEndActions`
   are ticket rules in SQL; the queue decides from `task_view`; the backlog gates a decision on its
   projection. Whole-log scans by type outside these: F2's two and `day-ceiling.ts:31` only.
7. **Spend has no home.** `RunSpent` is on `pass-`, `chat-` and `ticket-`, because an agent run
   that is not an attempt writes onto whatever stream invoked it.

**One rule, stated once.** 0128 §7's *"one module is the way in"* is right for every aggregate,
and what is missing is that it is said only for Project. The general form, for 0101 §4 or a topic
ADR of its own: *every aggregate has one module that owns every append to its stream and every
read of its state; its rules are transition functions in `domain` beside the reducer; hosts call
the module and never append; a request is appended to the aggregate it is about.* A unit test in
the shape of 0128 §7's — refusing a `.append(` whose stream constructor (`ticketStream`,
`CONTROL_STREAM`, …) is used outside the owning module — would hold it the way the Effect ratchet
holds `async`. Ticket and Control are the two that need it built; Account is the example to copy.
