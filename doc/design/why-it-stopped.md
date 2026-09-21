# Why it stopped, and what to do about it

**Status** proposed · 2026-09-20 · no implementation claimed by this document

A person opening a blocked item wants two things and the page gives neither:
**why did this stop**, and **what do I do now**. It gives *what happened*
(`BlockDiagnosis.what`), *what was already tried* (`done`), and *the failure as
it arrived* (`raw`).

```ts
// packages/domain/src/events.ts:185
what: z.string(),
done: z.string().nullable(),
raw:  z.string().nullable(),
```

There is no field for the remedy, and the remedy is the reason the page is
open.

## 1. The specification is four diagnoses that already happened

Between 2026-09-17 and 2026-09-20 four items reached a person. **Not one was a
judgement about a diff.** Each is a worked example of what this document is
for.

| | what stopped it | what the remedy was |
|---|---|---|
| `#176` `#177` | `ENOSPC` — 11.1 GB of `.bun-build` temp files | delete them |
| `#192` `#197` | `Session ID … is already in use` | **restart the daemon** — the fix had landed, the process predated it |
| `#187` | `You've hit your session limit · resets 4:20am` | wait 2 minutes |
| `#179` `#187` `#197` | `node: Single executable application is disabled` | `brew unlink node` |

They cost, in agent time alone, about **$4 of pure rediscovery** — three
agents independently establishing the same fact about the same machine — on top
of the passes they ended.

### What the diagnosis actually required

**No new information.** Every fact was already on the machine:

| the conclusion | where the fact already was |
|---|---|
| the daemon predates the fix | `doctor`'s `daemon: currency` — two commits behind, one of them the fix |
| the session id collides | the run log's `stderr` line |
| Homebrew's node has SEA off | the run log's build output, plus a two-file repro in `/tmp` |
| the quota resets on Sunday | **the message itself**, which `parseResetAt` could not read (#210) |

Three of the four were a **join**: the run log against the daemon's currency,
against what landed since, against whether other items failed the same way.
Only the fourth needed a command.

## 2. So most of this is rules, not prompts

An agent call is the expensive way to compute a join. The recognisable shapes
are finite and each already has its evidence in hand:

| shape | what says it | the remedy |
|---|---|---|
| zero turns, zero cost, a message naming a limit | [0031](../decisions/0031-a-run-that-never-started.md) classifies this already | wait — and say until when (#210) |
| `Session ID … is already in use` | the run log, and `daemon: currency` | restart, **if a fix landed after the daemon started** |
| a gate exits with no receipt | [#196](https://github.com/steven-zhc/lingtai/issues/196) | the tool broke; this is not a verdict about the diff |
| the same action fails the same way in N passes **across different items** | nothing today — see §3 | the machine, not the diff |

**A remedy is often a command, and then it should be a button.** *"Restart the
daemon"* is `lingtai restart`; *"delete the temp files"* is one `find`. The
difference between a diagnosis and a remedy is that a remedy can be pressed.

### The fourth field

`BlockDiagnosis` gains **`so`** — what to do — beside `what`, `done` and `raw`.
Null when nothing is known, which is honest and is the common case at first.

## 3. The signal Lingtai cannot see, because it looks at one pass

What made the Node diagnosis *certain* was not any one run. It was **three
different tickets failing identically**. Lingtai diagnoses a pass at a time, so
each of the three agents paid to rediscover the machine.

This is a fold, not a prompt: *the same action, failing with the same signature,
across items that share nothing else*. `finding_backlog` is already a
cross-item projection ([#137](https://github.com/steven-zhc/lingtai/issues/137));
this is the same shape one level down.

**It is the highest-value piece in this document**, because it is the one that
turns "three agents each spent $1.50" into "the second one is told".

## 4. The skill belongs to the fix agent, not to the reader

Three fix agents improvised the same procedure and all three were right:

```
1. is this failure mine?
2. can I reproduce it outside Lingtai?
3. reproduced → commit nothing, say so plainly, decline the round
```

They were right and they were **each inventing it**. Writing it down as a skill
is cheap, and the fix agent is the only role that can *verify* rather than
guess, because it is the only one that can run a command.

Its conclusion should become `so`, rather than ending in a run log nobody
reads.

## 5. The hard part: the reader cannot run anything, and that is deliberate

The obvious home for *"why did this stop"* is the discussion pane, which is
already on the page and already reads the log, the ticket and the code. It
cannot run commands, by decision.

[0033](../decisions/0033-the-third-kind-of-agent.md) §1 draws that line and the
argument is structural, not squeamish:

> The line is drawn there because a command is what makes a run a run. The
> worktree exists so an agent's writes are disposable; the hook exists so a tool
> call is refusable; the gates exist so nothing it produced reaches `main`
> unchecked. **An agent that only reads needs none of those, and an agent that
> executes needs all of them** — so allowing commands would not extend this
> shape, it would make it the first one under a different name.

And §5 anticipates precisely this document's use case:

> Proving the binary **accepts** the flag needs a command it does not have, and
> it must say so rather than conclude. … **An assistant that repeats that
> inference is worse than no assistant**, because it would launder a guess into
> an answer.

**0033 is right about what it argued.** The question this document raises is
whether it enumerated the space completely.

### What the diagnosis case actually needs

Every probe that settled a diagnosis this week was **about the machine, not
about the repository**:

```
node --build-sea /tmp/…/c.json      is this Node built with SEA
codex login status                  is this CLI signed in
node -e '<regex> against <message>' does the parser read this string
df -h ; find . -name '*.bun-build'  is the disk full, and with what
```

None writes to the repository. None produces a diff. None needs a worktree cut
from `origin/main`, and none needs a gate, because nothing it makes can reach
`main`.

**That is a third point in a space 0033 collapsed into two.** Its §1 says an
executing agent needs *the worktree, the hook and the gates*. A probe needs
**the hook and a scratch directory** — the hook because a tool call must stay
refusable, a scratch directory because a command writes somewhere. It needs
neither of the other two.

### What it would take, honestly

This is not a small change and it is not free:

- **An allowlist, not a sandbox.** *Read-only* is not the property — `node
  --build-sea` writes a file. The property is *nothing it does reaches the
  repository or the log*. The fail-closed hook already refuses tool calls
  ([0007](../decisions/0007-dual-runtime.md)); what is new is the list of what
  it may do.
- **[0054](../decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md)
  has to move with it.** It is eight days newer than 0033 and states the
  boundary as a capability the adapter must enforce: *"Discussion's boundary is
  enforced by runtime configuration and capability verification, never by a
  prompt asking it to behave. If an adapter cannot uphold that boundary, it
  cannot serve discussion."* Under Codex that is a native sandbox; under Claude
  Code it is the hook. **Two adapters, two enforcements, one boundary** — and
  the boundary would now be an allowlist rather than *nothing*.
- **[#205](https://github.com/steven-zhc/lingtai/issues/205) is named after the
  old line** — *"Discussion binds its configured agent while keeping every
  answer tool-free"*. It is `agent:hold` and unstarted, so it can be rewritten,
  but it must be rewritten deliberately rather than discovered mid-flight.
- **§4's meter becomes load-bearing.** A discussion that can run commands can
  spend in ways a reader cannot predict, and 0033's answer to spend is *the
  person is the control loop, and the meter is what makes that true*. A probe
  that loops is a person watching a number climb.
- **§5's rule survives and gets sharper.** *Say what you cannot do* does not go
  away when some commands are allowed; it moves to the edge of the allowlist.
  An agent that cannot run `codex login status` must still say so rather than
  infer from a config file.

### The alternative that costs nothing

**Give the remedy to the role that already has the powers.** The fix agent can
run commands today. If its diagnosis became `so`, three of this week's four
cases would already be answered on the page, with a verification behind them —
and 0033 would not move at all.

That is §4, and it is why §4 comes first in the build order below: it is the
cheap half of the same outcome, and it makes the expensive half easier to judge,
because the `so` field will exist and its quality will be visible.

## 6. Build order

```
1  BlockDiagnosis gains `so`, filled by rules only      small, no agent spend
2  the cross-item fold — same failure, different items  the one that stops rediscovery
3  the fix agent's skill, writing into `so`             cheap, and it verifies
4  the diagnosis probe, and the 0033 amendment it needs decide after 1–3 are visible
```

Steps 1–3 need no decision about 0033. **Step 4 needs an ADR that engages §1's
argument rather than deleting it**, and this document does not make that
decision — it states what the decision would have to cover.

## 7. What this does not decide

- **Whether a probe agent is worth its containment.** §5 sets out the cost; the
  measurement is steps 1–3, which will show how much is left over once rules and
  the fix agent have had their turn.
- **Cross-ticket discussion.** 0033 left it open and this leaves it open; the
  fold in §3 is a projection, not a conversation.
- **What `so` looks like when it is wrong.** A remedy that is confidently wrong
  is worse than none, and nothing here says how that is caught. It is the first
  thing step 1 should be tested against.
