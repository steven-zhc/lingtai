# 0067 — A plugin is a declaration and an implementation, and only the implementation must be ours

**Status** accepted · **Date** 2026-09-28 · **Supersedes**
[0037](0037-an-extension-is-a-command.md) §2 — *there is no plugin system* — whose
premise expired when one was built · **Keeps**
[0037](0037-an-extension-is-a-command.md) §1's trust table, unchanged and now
load-bearing for a second reason · **Completes**
[0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 by letting the
declaration arrive from somewhere other than this repository

## 1. What 0037 §2 said, and what happened after it

0037 §2 is titled *There is no plugin system. An extension is a command*, and it
was specific about what it was refusing:

> `use:`, a registry, **a manifest**, a loader and a machine-level config are all
> deleted before being built … `agent:`, `watch:` and `human:` stay built in …
> **`run:` is the single extension point.**

That was correct when written. It named **three** built-ins and one extension
point, and it refused to build machinery for a plugin system that did not exist.

**A plugin system was then built, for other reasons.** 0064 §4 gave every plugin
an `at` and made that declaration what makes it legal at a step; 0065 made the
default at a step a plugin; `#241` finished the job. Today:

| | 0037, 2026-09-09 | today |
|---|---|---|
| built-in kinds | 3 (`agent:`, `watch:`, `human:`) | **12**, in a closed `PLUGINS` |
| what declares legality | a hand-written table | **each plugin's own `at`** (0064 §4) |
| what a step's main work is | core code, called directly | **a plugin** — all ten (`#241`) |
| a plugin's shape | — | `definePlugin`: a key, a schema, an `at` |

So the sentence *there is no plugin system* is no longer a description of this
codebase. There is one: `definePlugin` is its contract, `PLUGINS` is its registry,
and `at` is its legality rule. **What is true is narrower — the registry is
closed** — and that is a different claim, which this decision replaces rather
than contradicts.

## 2. What that closure costs, in one number

`runPlugin.at` is `{ prepared, build, proposed, merge }`. A `run:` command is
legal at four of the ten steps.

**So a user can extend four steps and a contributor can extend ten.** A third
party cannot write a plugin at `design`, `implement`, `claim`, `admit`, `review`
or `end` — including every destination
[0066](0066-a-large-answer-is-a-locator-on-the-log.md) describes, whose whole
point is that where a design lands should be somebody's choice.

## 3. The decision

**A plugin is two things and they separate cleanly:**

| | what it is | who may supply it |
|---|---|---|
| the **declaration** | a key, its fields and their schema, the steps it serves, what it returns | **anyone** |
| the **implementation** | the code that runs | see §4 |

The declaration is data. Nothing in it executes, and everything the core does with
a plugin *before* it runs — refuse a bad recipe when it resolves, draw the step on
the board, answer *may this kind run here*, say why not in the step's own terms —
reads only the declaration.

**So the registry opens and the trust boundary does not move.**

## 4. 0037 §1 survives, and it decides who may run in our process

0037 §1's table is unchanged and this decision leans on it harder than 0037 did:

| | trusted? | because | so |
|---|---|---|---|
| the extension's **code** | **no** | it can hang, exit, leak, or read `LINGTAI_DATABASE_URL` | it runs in its own process, on a clock, with its own credentials |
| the extension's **verdict** | **yes** | the recipe named it, at a step, on purpose | the core does what it says |

That is why §3's split works. An implementation may be:

- **in this process** — and then it is ours, in `PLUGINS`, reviewed here. The
  twelve are these, and they stay these.
- **a subprocess** — and then it may be anyone's, run the way 0037 §4 already runs
  one: JSON on stdin, the exit code and a file out, its own clock, and **not the
  conductor's environment**.

**In-process third-party code stays refused**, and the reason is the one 0037 gave
rather than a new one: it would hold the GitHub App key and
`LINGTAI_DATABASE_URL`. 0037 retired 0016 §5's *plugins are trusted code … they
run in the daemon's process with the daemon's credentials* **by making the other
thing true**, and this decision does not un-make it.

## 5. What a declaration has to be able to say

Whatever shape it takes, it says exactly what `definePlugin` says, because
anything less makes a third-party plugin second-class in a way a reader would
trip over:

- **a key**, and a word already taken is refused;
- **its fields and their types**, so a typo is refused *when the recipe resolves* —
  before a worktree, before an agent, before any money, which is the whole value
  and is what `run:` cannot do today;
- **which steps it serves**, so `whyNoKindAt` answers for it and a refusal names
  the step in that step's own terms;
- **what it returns**, so the pass knows whether it got a verdict, findings, a
  head or a locator.

## 6. What it costs

**`ActionKind` stops being derived from a compile-time array.** Today
`ActionKind` and `StepAction` are read off `PLUGINS` with `as const`, which is
what makes a twelfth kind free and a thirteenth cell automatic. A key that
arrives at runtime cannot be in that union, so the type has to become *the twelve,
or a string a declaration vouched for* — and every place that switches on a kind
has to keep working. **This is the real price and it is paid in the core's
types, not at the edges.**

**The step × kind matrix becomes two matrices.** `step-matrix.test.ts` walks
`STEPS × PLUGINS` and asserts every cell runs or refuses by name. A declared kind
is not in `PLUGINS`, so the property it asserts — *there is no third answer* —
needs its own test over declarations, or the guard `#61` bought covers only half
the world.

**A refusal has to name whose fault it is.** A first-party plugin that throws is
Lingtai's bug (0025). A third party's is not, and a card that says the same thing
for both teaches an operator to distrust the wrong component.

**And nothing gets cheaper.** `run:` stays exactly as it is, because most
extensions should still be a command with no declaration at all. This buys
expressiveness for the few that need it and adds a concept for everyone reading
the code.

## What this does not decide

- **Where a declaration comes from.** A file beside the recipe, a package, a
  directory the machine owns. It is a trust question before it is a loading one:
  [0005](0005-config-in-target-repo.md) makes the recipe the boundary, so a
  declaration the recipe points at is inside it and one the network fetches is not.
- **Whether a subprocess can honestly return everything a step wants.** A verdict
  and findings cross a process boundary easily; a `worktree:` that *makes* what the
  pass runs in may not. That may narrow which steps a third party can serve, and
  narrowing it is a better outcome than pretending.
- **A registry or a marketplace.** Distribution is after 1.0 (`#175`).

## Related

- [0037](0037-an-extension-is-a-command.md) — §2 superseded, §1 kept. Its
  *deleted before being built* instinct was right in 2026-09; what changed is that
  the thing a manifest would describe now exists.
- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin declares
  the steps it serves. This decision says that declaration need not live here.
- [0065](0065-the-default-is-a-plugin.md) and `#241` — what made 0037 §2's premise
  expire: every step's main work is a plugin now.
- [0066](0066-a-large-answer-is-a-locator-on-the-log.md) — the first thing a third
  party would want to write, and cannot.
- [0025](0025-a-failure-buys-one-agent.md) — whose failure it is, which §6 says a
  card must keep straight once a stranger's code can fail.
