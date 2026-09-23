# The v2 recipe for this repository, and where every v1 key went

**Status** the target · 2026-09-23 ·
[#226](https://github.com/steven-zhc/lingtai/issues/226) · T0b of
[the-pipeline.md](the-pipeline.md) · **no code, no schema, no parser**

[0061](../decisions/0061-the-recipe-is-the-pipeline.md) decides that the recipe
becomes the pipeline — ten step names in order, each a list of plugins, read
top to bottom. Five tickets aim at that. **This is the file they are aiming
at**, written out for this repository with the values in use today, followed by
every v1 key and where it went.

It is also 0061's own test. The ADR ends: *if the v2 file is not plainly easier
to read than the v1 it replaces, this ADR was wrong and the file will say so.*
§5 answers that, and the answer is yes on shape with one finding that is not
about shape.

## 0. What this is written against

Two files, neither of them in this repository, and both read on every resolve:

```
~/.lingtai/lingtai/recipe.yml     462 lines — 346 comment, 23 blank, 93 YAML
~/.lingtai/config.yml             this machine's: runtime.agent, and
                                  projects.lingtai.runtime.limits
```

Of the 93 YAML lines, 36 are the review prompt's own text. **The v1 file is 57
lines of structure**, and the machine file contributes 10 more that a pass
cannot be read without — `runtime.agent`, and `turns`, `wall`, `rounds`,
`restarts` under `projects.lingtai`. **67 lines across two files**, and that is
the number §4 compares against. The prose is the same prose in both versions
and travels unchanged, so structure is the only honest comparison.

`.lingtai/config.yaml` in this repository is read by nothing since
[#180](https://github.com/steven-zhc/lingtai/issues/180); it survives as the
record of why each value is what it is.

## 1. The v2 file

Every value below is the one in use today. The review prompt is verbatim. The
long comments the v1 file carries travel unchanged and are marked `# ↑ v1's
comment, unchanged` rather than reprinted, so that the two files can be
compared on the thing that actually changed — **the structure**.

```yaml
version: 2

# Unchanged from v1, and still top-level: this is the *run's* environment
# policy, not any one plugin's declaration. A plugin's `env:` is the names its
# process is handed (0061 §9); these five decide what exists to hand out.
env:
  required:
    - LINGTAI_TEST_DATABASE_URL     # ↑ v1's comment, unchanged
  refuseHosts: [eliwlauokdzgsqfgczkv]   # ↑ v1's comment, unchanged
  plantAt: .env.local

steps:
  # `restarts` is written here and counted at `proposed` — the step it bounds,
  # not the step that counts it (0061 §2). One restart: at most 8 × 1h on a
  # ticket before it is anyone's.
  claim:
    - queue:
        kinds: [bug, tech-debt, feature, documentation]
        # ↑ v1's comment, unchanged — priority order, earlier wins
        exclude:
          - blocked
          - in-progress
          - agent:hold
          - agent:blocked
          - agent:review
          - agent:wip
          - epic
        # ↑ v1's comment, unchanged — including why `epic` is named rather
        # than hidden by taking its kind label away
        backoff: 1h
      restarts: 1

  # `repo:` was never a section about the repository. It was about what `admit`
  # cuts, and this is the whole of 0061's readability claim in one line.
  admit:
    - worktree: { base: main, submodules: false }

  prepared:
    - name: install
      run: pnpm install --frozen-lockfile
      timeout: 10m
      env: []

  # `design:` is omitted, and that is the one honest omission in this file
  # (0061 §5). Nothing writes a design today — T9 is the last ticket in the
  # plan — so it resolves to `[]`, and the board and `lingtai doctor` draw it
  # as a step that will run nothing.

  # `rounds` is written here and counted at `proposed`, for the reason
  # `restarts` is written on `claim`. Three, and the number is a hypothesis
  # about what a refusal means (experiment 011) — ~31 turns and ~$3.40 each.
  implement:
    - agent: claude-code
      turns: 150
      wall: 1h
      evidence: 10200      # ↑ v1's `runtime.budget.evidence` comment, unchanged
      attempts: 5
      rounds: 3            # ↑ v1's `runtime.limits.rounds` comment, unchanged

  # Its own step, and a red one skips `review`: a diff that does not compile is
  # never paid to be reviewed. In v1 this ordering was a comment on the second
  # action in a list; here it is two steps and needs no comment.
  build:
    - name: build
      run: pnpm typecheck && pnpm test
      timeout: 20m
      env: []
      # ↑ v1's comment, unchanged — why `pnpm test:db` is suspended from this
      # gate, what stops being checked, and what brings it back

  # The cold reviewer, on from 2026-09-09. It returns findings with a severity
  # and no verdict; `proposed` decides.
  #
  # The rubric, the checklist and the JSON contract are fixed in `agent-gate.ts`
  # and cannot be removed from here — this text is appended. What belongs here
  # is only what *this* repository keeps getting wrong.
  review:
    - name: review
      agent: claude-code
      diff: 400000
      findings: 5
      prompt: |
        This is an event-sourced scheduler that schedules its own development.
        Six shapes have produced real defects here. Look for them as well as the
        checklist above.

        1. **A comment that was true when it was written and is false now.**
           This repository's signature defect: it appeared six times in a single
           session. A lease duration that no longer exists; a `reconcile`
           described as running only at startup; a justification resting on
           "every merge already waits for a person" written after merges stopped
           waiting. Ask of every comment, doc line and ADR sentence near a
           behavioural change: does it still describe what the code now does?
           A stale claim is a finding, and its failure scenario is the next
           reader who believes it and acts on it.

        2. **A check that is present, reported, and not looking at the thing you
           think it is.** `#58`: the `merge` point renders as resolved and
           executes nothing. `#89`: `runtime.limits.turns` was declared in the
           recipe, carried through three layers, and handed to no runtime. Ask
           of any check the diff adds or touches: what exact input does it read,
           and is that input the thing its name claims? A check that cannot fail
           is worse than no check, because it is believed.

        3. **A guarantee that holds only because the single implementation is
           careful.** `work-loop.ts` invokes a subscriber with no `.catch` and
           depends on that subscriber never rethrowing. Ask whether the
           invariant would survive a second implementation written by somebody
           who had not read the first.

        4. **A projection that is not a pure fold.** A reducer may read the
           event and nothing else — no clock, no network, no environment.
           Anything time-dependent makes `lingtai projection rebuild` disagree
           with the live fold, and the two disagreeing silently is the failure.

        5. **A required field added to a shared type, with a hand-written
           literal missed.** `#89`'s first attempt added a field to
           `RuntimeCapabilities` and missed a literal in a package the change
           never opened. For every widened type: where else is this constructed
           by hand?

        6. **A name Lingtai reads for itself without the `LINGTAI_` prefix**
           (`#63`) — or a project's own variable wrongly given one. A project's
           file keeps its own names.

  # The only step that routes. One judge per direction, and only one of the
  # five is a judgement worth an agent (0061 §3).
  #
  # `tamper` would be the last entry here — the `watch:` block is
  # doc/tamper-watch.md, deliberately not wired in this repository, and since
  # #180 it has lost its subject: the recipe is outside every worktree, so
  # there is no gate file for an agent to weaken.
  proposed:
    - when: findings
      backlog: minor          # at or below this is filed (#137), and buys no round
    - when: red | gate-failed
      judge: same-worktree    # built in, spends nothing
    - when: findings
      judge: claude-code      # the one that thinks
    - when: conflict
      judge: claude-code
    - when: needs-input
      judge: ask-or-assume

  # Written out as `[]` rather than omitted, though 0061 §5 permits omitting
  # it. **Nothing holds here**, and that is the single most consequential fact
  # about this repository's configuration — the same argument the v1 file makes
  # for writing out `backoff` and `env: []`: this is the repository that has to
  # be able to read its own policy without opening its own source.
  #
  # ↑ v1's comment, unchanged — what is between an agent and `main` is
  # `proposed`, and neither half of it is a person.
  merge: []

  end:
    - name: close the ticket
      when: landed
      close: true
    - name: close the ticket a person ended
      when: closed
      close: true
      # ↑ v1's comment, unchanged — why this is a second action and not
      # `when: any` (0044)

# Beside `steps:`, because a discussion is started by a person, happens on a
# ticket no pass has claimed, and advances nothing — but it calls an agent and
# spends money, so it needs a plugin and a budget of its own (0061 §6).
#
# These three numbers are `discuss.ts:72` and `discuss.ts:80` today, where
# nobody can read them. `turns: 40` reaches the binary as `--max-turns`;
# `wall: 5m` is how long one turn may take before it is called hung.
discuss:
  - agent: claude-code
    turns: 40
    wall: 5m

# Off the log, and cannot change an outcome (0015's one real division, and the
# only one 0061 does not flatten).
subscribers:
  - name: desktop
    on: [ApprovalRequested, IntegrationRefused, RunAwaitingInput, WorkItemBlocked]
    run: node apps/cli/src/notify.ts
    env: []
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked, RunFailed, ApprovalRequested, RunAwaitingInput]
    run: node packages/telegram/src/cli.ts
    env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
  # ↑ v1's comment, unchanged — why `desktop` is the right first crossing of
  # the extension boundary, and why `telegram` names `WorkItemLanded` and
  # `desktop` deliberately does not
```

## 2. Every v1 key, and where it went

Nothing is dropped silently. **Six rows say *none*, and those six are the
finding** — §3 takes them one at a time.

### The file

| v1 | v2 |
|---|---|
| `version: 1` | `version: 2`, top-level. A v1 file is refused by name (0061 §7) |
| `extends:` | **none named.** §3.1 |
| `repo.base` | `admit:` → `worktree.base` |
| `repo.submodules` | `admit:` → `worktree.submodules` |
| `source.kinds` | `claim:` → `queue.kinds` |
| `source.exclude` | `claim:` → `queue.exclude` |
| `source.backoff` | `claim:` → `queue.backoff` |
| `env.allow` | top-level `env.allow`, unchanged |
| `env.deny` | top-level `env.deny`, unchanged |
| `env.required` | top-level `env.required`, unchanged |
| `env.refuseHosts` | top-level `env.refuseHosts`, unchanged |
| `env.plantAt` | top-level `env.plantAt`, unchanged |
| `subscribers[]` | top-level `subscribers:`, unchanged |

### The gates

| v1 | v2 |
|---|---|
| `gates.admit` | `steps.admit` — empty in v1, and it gains `worktree:`, which `repo:` was |
| `gates.prepared` | `steps.prepared` |
| `gates.proposed[0]` — the `run:` action | `steps.build` — its own step |
| `gates.proposed[1]` — the `agent:` action | `steps.review` |
| `gates.proposed` — the commented-out `watch:` block | **none named.** §3.2 |
| `gates.merge` | `steps.merge` |
| `gates.end` | `steps.end` |

### An action's keys

| v1 | v2 |
|---|---|
| `name:` | universal key, unchanged (0061 §2) |
| `timeout:` | universal key, unchanged |
| `when:` on `close:`/`labels:` | universal key, and its legal values are the step's (0061 §3) |
| `env:` on `run:` | **a field in the plugin's schema, not a universal key** (0061 §9) |
| `run:` | the `run:` plugin, at `prepared` and `build` |
| `agent:` — the string *is* the prompt | the `agent:` plugin, whose `prompt:` it becomes |
| `watch:` + `then:` | the `watch:` plugin — **no step named.** §3.2 |
| `human:` | the `human:` plugin — **no step named.** §3.2 |
| `close:` | the `close:` plugin, at `end` |
| `labels:` | the `labels:` plugin, at `end` |

### `runtime:`, which is where the ADR does its work

| v1 | v2 |
|---|---|
| `runtime.agent` | `implement:` → `agent:` — and `design`, `review`, `merge` and `discuss` each choose their own (0053, as a consequence of the shape) |
| `runtime.tier` | **none named.** §3.3 |
| `runtime.prompt` | **none, and it needs none.** §3.4 |
| `runtime.limits.turns` | `implement:` → `agent.turns` |
| `runtime.limits.wall` | `implement:` → `agent.wall` |
| `runtime.limits.rounds` | `implement:` → universal `rounds:` |
| `runtime.limits.restarts` | `claim:` → universal `restarts:` |
| `runtime.assignee.login` · `.take` | `claim:` → `assignee:` |
| `runtime.budget.evidence` | **none named.** §3.3 — it belongs on `implement`'s `agent:`, and this file puts it there |
| `runtime.budget.attempts` | **none named.** §3.3 — the same |
| `runtime.budget.findings` | `review:` → `agent.findings`, and §3.5 is the disagreement about that |
| `runtime.budget.diff` | `review:` → `agent.diff`, and it **flows** to `merge`'s conflict agent rather than being written twice (0061 §4) |

### New in v2, with no v1 key

| v2 | what it is |
|---|---|
| `steps.design` | the one genuinely new step. Omitted here: nothing writes a design today |
| `proposed` → `judge:` | `buyRound`'s decision (`run-once.ts:1761`), made sayable |
| `proposed` → `backlog:` | `acceptFinding` ([#137](https://github.com/steven-zhc/lingtai/issues/137)) — a severity stops being an opinion and becomes an outcome |
| `merge` → `merge:` | the merge lane, named |
| `discuss:` | `discuss.ts`'s two constants, made sayable |

## 3. The six rows that say *none*

### 3.1 `extends:` has no home, and the file shape makes the question sharper

0061 §4 lists what is top-level after the move — `version`, `env`, `steps`,
`discuss`, `subscribers` — and `extends:` is not among them. It is live:
`presets.ts:126` strips it and merges `PRESETS[name]` underneath, and
`resolve.ts:154` names it in a refusal. This repository does not use it, so
nothing here is lost, and **a project that does would have no way to write the
v2 file.**

It is not a simple rename. A preset today is a set of *gates*; under v2 it
would be a set of *steps*, and `originIn` (`local.ts:250`) already has to
answer *file, preset, or schema default* per section for the board's provenance
column ([#218](https://github.com/steven-zhc/lingtai/issues/218)). Ten sections
instead of one `gates` is more surface, not less.

**For T3:** either `extends:` is top-level in v2 and the preset table is
rewritten as `steps:`, or presets go. Deciding it by not mentioning it is the
one option that produces a silent drop.

### 3.2 `watch:` and `human:` are plugins with no step

[the-pipeline.md](the-pipeline.md)'s T2 names eleven plugins — `run:` `agent:`
`watch:` `human:` `close:` `labels:` `worktree:` `queue:` `judge:` `backlog:`
`merge:` — and 0061 §3's table places nine of them. `watch:` and `human:` have
no row.

Both have a knowable home in this repository:

- **`human:` at `merge`.** [CLAUDE.md](../../CLAUDE.md) says it in as many
  words: *declare a `human:` action there and the point runs it*, and
  `conductor/integration/run-once.test.ts`'s *holds at a human action at the
  merge point* is the test that pins it.
- **`watch:` at `proposed`, last.** That is where the commented-out block sits
  in the v1 file, and the reason it is last is written beside it: a watch placed
  first would ask a person about a diff that does not compile.

This matters for 0061 §8 rather than for this file. The rule is *a step refuses
a plugin it cannot run, at resolve time, by name* — so the matrix has a cell
for every step × plugin pair, and a pair nobody has placed is a cell nobody has
decided. T2 grows `gate-matrix.test.ts` from thirty cells to a hundred and ten;
these two plugins are twenty of them.

### 3.3 `tier`, `evidence` and `attempts` have an obvious home the ADR does not name

All three belong on `implement`'s `agent:`, and this file puts them there:

```
runtime.tier              → implement: agent.tier    — what `run-once.ts:477`
                            checks before it dispatches (`missingForTier`)
runtime.budget.evidence   → implement: agent.evidence — characters of an earlier
                            failure quoted into the next prompt (`attempts.ts:351`)
runtime.budget.attempts   → implement: agent.attempts — rows the attempt table
                            names before it says "and N earlier" (`attempts.ts:327`)
```

`tier` is not written in the v1 file — it is the schema default, `guarded` —
so it is not written above either; writing a default this file does not carry
would be inventing policy. `evidence: 10200` and `attempts: 5` **are** written
in v1 and are written above.

These three are the least interesting of the six, and they are still worth
naming: 0061 §4's mapping is five lines long and reads as exhaustive.

### 3.4 `runtime.prompt` has no home because nothing reads it

`recipe.ts:622` declares `prompt: z.string().optional()`. A search of every
`.ts` and `.tsx` in the workspace finds no reader: `schedule.ts:232` and
`run-once.ts:1214` carry an `options.prompt` that comes from the scheduler's
own arguments, not from the recipe, and neither `emit.ts` nor
`apps/board/src/lib/recipe.ts` mentions it at all.

So it is shape **2** of this repository's own review prompt — *a check that is
present, reported, and not looking at the thing you think it is* — in the
schema that prompt is written in. **It should be deleted at T3, not moved.**

### 3.5 `budget.findings` is placed at `review` and spent at `implement`

0061 §3's table puts `findings` on `review`'s `agent:`, beside `diff`. The two
are not the same kind of number:

```
budget.diff       agent-gate.ts:77   what the reviewer is shown   → review spends it
budget.findings   attempts.ts:272    how many of a review's findings the *next*
                                     attempt is told about        → implement spends it
```

§4's rule is *a setting moves to the step that owns it*, and by that rule
`findings` is `implement`'s. §4's other rule — *a setting has exactly one home
and the value flows* — permits `review`'s, since a value written once and
handed on is the shape `base` already has.

Either is defensible and **writing it at `review` without saying which way it
flows is not**, because a reader who has just been told the file is the
pipeline will read `findings: 5` under `review` as a bound on the review. This
file keeps 0061's placement and says it in a comment; T3 should decide it
rather than inherit it.

### 3.6 The one that is not a placement — `runtime:` is the block the two-file split is enforced on

This is the finding, and it is the reason the rows above are short.

Since [#180](https://github.com/steven-zhc/lingtai/issues/180) and
[0046](../decisions/0046-lingtai-is-personal.md) §3 a pass is configured by two
files, and **the recipe refuses three keys by name**:

```ts
// packages/recipe/src/local.ts:394
for (const key of ["agent", "limits", "assignee"]) {
  if (key in own) {
    refused.push(
      `runtime.${key}: moved to this machine (0046 §3) — write it in ${machineFile}, ` +
        `under \`runtime:\` or \`projects.${project}.runtime:\`. Nothing here was applied`,
    );
  }
}
```

`own` is `raw["runtime"]` (`local.ts:389`). **In a v2 file there is no
`runtime:` block**, so that loop reads an empty object, refuses nothing, and
the split is not enforced — it is silently gone. 0016 §4's rule is exactly the
one this breaks: *a key silently dropped and a key that does not exist are
different facts to whoever wrote it.*

And it runs the other way too. Today `local.ts:403` **writes** the machine's
values into the resolved recipe:

```ts
raw["runtime"] = { ...own, agent: agent.agent, limits, ...(assignee ? { assignee } : {}) };
```

Under v2 there is no `runtime` to write them into. They have to land in
`steps.implement[0]` (`agent`, `turns`, `wall`, `rounds`), `steps.claim[0]`
(`restarts`, `assignee`) and `steps.review[0]`/`steps.merge[0]`/`discuss[0]`
(each one's `agent:`) — **which is one machine-wide value arriving in six
places inside `steps:`, where it will then read as though the file said it.**

0061 §4 does not mention 0046. Its five-line mapping table moves
`runtime.limits.rounds` to `implement` as though the recipe file were where it
is written, and this repository's recipe cannot write it at all.

**Three ways out, and T3 picks one:**

| | what it costs |
|---|---|
| The machine file's values are merged into `steps:` at resolve, and a v2 file that writes `turns`, `wall`, `rounds`, `restarts` or an `agent:` runtime is refused by name | the refusal has to name six places instead of three, and `lingtai doctor`'s provenance column has to say *← machine* per step. Keeps 0046 §3 |
| 0046 §3 is revisited: the limits come home to the recipe, which is now the machine's own file at `~/.lingtai/<project>/recipe.yml` anyway | a superseding ADR. It is not obviously wrong — #180 moved the *file* to the machine, which is most of what §3 was protecting — but it is a decision, not a consequence |
| `runtime:` survives beside `steps:` as a sixth top-level node | 0061 §1's claim dies. The order is in the file and the numbers that cost money are not |

**The third is the one to refuse**, and naming it is why this section exists:
it is what happens by default if nobody chooses.

## 4. The two files, side by side

Structure only — the prose is the same prose in both.

```
v1 — 67 lines of structure, two files          v2 — 77 lines of structure, one file

version: 1                                     version: 2
repo:                                          env:
  base: main                                     required: [LINGTAI_TEST_DATABASE_URL]
  submodules: false                              refuseHosts: [eliwlauokdzgsqfgczkv]
source:                                          plantAt: .env.local
  kinds: [...]                                 steps:
  exclude: [7]                                   claim:
  backoff: 1h                                      - queue:
env:                                                   kinds: [...]
  required: [...]                                      exclude: [7]
  refuseHosts: [...]                                   backoff: 1h
  plantAt: .env.local                                restarts: 1
gates:                                           admit:
  admit: []                                        - worktree: { base: main, submodules: false }
  prepared:                                      prepared:
    - name: install                                - name: install
      run: pnpm install --frozen-lockfile            run: pnpm install --frozen-lockfile
      timeout: 10m                                   timeout: 10m
      env: []                                        env: []
  proposed:                                      implement:
    - name: build                                  - agent: claude-code
      run: pnpm typecheck && pnpm test                turns: 150
      timeout: 20m                                    wall: 1h
      env: []                                         evidence: 10200
    - name: review                                    attempts: 5
      agent: |                                        rounds: 3
        <36 lines>                               build:
  merge: []                                        - name: build
  end:                                                 run: pnpm typecheck && pnpm test
    - name: close the ticket                           timeout: 20m
      when: landed                                     env: []
      close: true                                  review:
    - name: close the ticket a person ended          - name: review
      when: closed                                       agent: claude-code
      close: true                                        diff: 400000
subscribers:                                             findings: 5
  - name: desktop                                        prompt: |
    on: [4]                                                <36 lines>
    run: node apps/cli/src/notify.ts             proposed:
    env: []                                        - when: findings
  - name: telegram                                   backlog: minor
    on: [5]                                        - when: red | gate-failed
    run: node packages/telegram/src/cli.ts           judge: same-worktree
    env: [2]                                       - when: findings
runtime:                                             judge: claude-code
  budget:                                          - when: conflict
    evidence: 10200                                  judge: claude-code
    attempts: 5                                    - when: needs-input
    findings: 5                                      judge: ask-or-assume
    diff: 400000                                 merge: []
                                                 end:
~/.lingtai/config.yml                              - name: close the ticket
runtime:                                               when: landed
  agent: claude-code                                   close: true
projects:                                          - name: close the ticket a person ended
  lingtai:                                             when: closed
    runtime:                                           close: true
      limits:                                    discuss:
        turns: 150                                 - agent: claude-code
        wall: 1h                                     turns: 40
        rounds: 3                                    wall: 5m
        restarts: 1                              subscribers:
                                                   - name: desktop … (unchanged)
                                                   - name: telegram … (unchanged)

                                                 ~/.lingtai/config.yml
                                                 — §3.6: this is the open question
```

`design:` is absent from the right-hand column on purpose and is not a
casualty: 0061 §5 lets a step with no plugins go unwritten, and nothing writes
a design in this repository today. It resolves to `[]` and is drawn — *skipped*
and *omitted* stay distinguishable in what a reader is **shown**, which is
where this repository has always put that distinction.

What moved, read across:

```
repo:                   → admit:       one line, and it says what cuts the worktree
source:                 → claim:       one plugin, and it says what picks the ticket
gates.proposed's two    → build: review:   two steps, and the ordering stops being
                                           a comment on a list
runtime.limits.turns/wall → implement: beside the agent that spends them
runtime.limits.rounds   → implement:  the ~31 turns and ~$3.40 are beside the step
runtime.limits.restarts → claim:      that buys them
—                       → proposed:   `buyRound` stops being visible to nobody
—                       → discuss:    `discuss.ts`'s two constants become readable
```

## 5. Is it easier to read? — 0061's own test

**Yes on shape, and the qualification is not about shape.**

Four things the v1 file cannot say and the v2 file says by existing:

1. **The order of the pass is in the file.** In v1 it is in no file. A reader
   assembles one pass from `repo:`, `source:`, `gates:` and `runtime:` and the
   sequence is nowhere — not in a comment, not in key order, not in the
   schema.
2. **The two numbers that cost money are beside the step that spends them.**
   `rounds: 3` sits under `implement`, where *~31 turns and ~$3.40 per round*
   is a sentence about the thing directly above it. In v1 it is
   `runtime.limits.rounds` in a second file, reading as a global setting, and
   it took a 40-line comment in `~/.lingtai/config.yml` to say what it bounds.
3. **`admit` and `build` stop being unnamed.** `repo.base` becomes *the branch
   `admit` cuts a worktree from*; the build stops being the first of two
   actions at a point named after neither of them.
4. **Two step names that exist today only in code get a line in a file** —
   `proposed`'s judge, which is `buyRound` at `run-once.ts:1761`, and
   `discuss`, which is two constants at `discuss.ts:72` and `:80`.

**The cost, counted rather than asserted.** 67 structural lines across two
files become 77 in one. Ten of those fifteen-odd extra lines are not overhead:

```
proposed:          11 lines   `buyRound`'s five directions. v1 has no way to
                              write any of it — it is code at run-once.ts:1761
discuss:            4 lines   discuss.ts:72 and :80. Neither file can say it
                             ───
                   15 lines   of new information
```

Take those two blocks out and the v2 file says everything v1's two files said
in **62 lines against 67**. `steps:` buys a level of indentation and ten names
where v1 wrote five keys, and it still comes out shorter, because `repo:` and
`source:` were section headers standing in for one plugin each.

**The one real regression** is that `prepared`, `build` and `review` are three
steps in three places where v1 had them in one list, so *what does this
repository run before it merges* takes three stops instead of one. That is a
fair trade for the ordering being true instead of implied, and it is the only
line in the comparison worth arguing about.

**What does not pass, and it is not the shape.** The ADR's claim is *read it
downward and you have read the pass.* Read the file in §1 downward and you have
read the pass **only if you already know that `agent: claude-code`, `turns`,
`wall`, `rounds` and `restarts` were not written there** — they are this
machine's, merged in from `~/.lingtai/config.yml`, and a reader who edits them
in the recipe gets, today, a refusal that names a `runtime:` block the v2 file
does not have.

So 0061 was not wrong, and it is not finished. **§4 is a mapping written as
though the recipe file were the only file, and this repository has had two
since #180.** That is §3.6, it is the one thing T3 cannot discover from the
ADR, and it is why this document exists before any code.

## 6. Related

- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) — the decision this
  draws. §2 is the shape, §4 the mapping, §5 the omitted step, §9 the schema.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) — the ten
  steps, and §3's *visible to nobody* about the two ceilings.
- [0046](../decisions/0046-lingtai-is-personal.md) §3 — the recipe is the
  machine's, and the two files. §3.6 is where it meets 0061 §4.
- [the-pipeline.md](the-pipeline.md) — this is T0b. T3 is the ticket that
  implements what is written here, and §3 is its input.
