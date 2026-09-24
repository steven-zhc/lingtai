# 0063 — Every setting is the recipe's, on the step that uses it

**Status** accepted · **Date** 2026-09-24 · **Implements**
[0053](0053-the-recipe-chooses-the-agent-for-each-role.md) in
[0061](0061-the-recipe-is-the-pipeline.md)'s shape · **Revises** 0061 §§2–3's
`assignee:` · **Built by** [#231](https://github.com/steven-zhc/lingtai/issues/231)

`~/.lingtai/config.yml` holds where the log is. Everything else — which runtime
does the work, what a run may spend, whose issues are taken — is the recipe's,
written on the step that uses it.

## 0. This is not a new decision, and that is the finding

[#231](https://github.com/steven-zhc/lingtai/issues/231)'s agent stopped and
asked which of three exits to take, because
[`the-v2-recipe.md`](../design/the-v2-recipe.md) §3.6 presents the placement of
`runtime.limits` as open and names *revisiting 0046 §3* as one exit, "needs a
superseding ADR".

**That ADR exists and is accepted.** 0053, 2026-09-17:

> **Status** accepted · implementation pending · **supersedes
> [0046 §3](0046-lingtai-is-personal.md)'s placement of agent selection and run
> limits in the machine file**; keeps its personal topology and recipe location

§3.6 does not mention 0053 once — checked. It was written on 09-23, six days
after. So the question was not undecided; it was decided and then asked again by
a document that had not read the answer.

What is left for this ADR is the half 0053 could not state: **where in
`steps:` each value lands**, which is a shape 0061 invented afterwards.

## 1. `~/.lingtai/config.yml` holds the log, and nothing else

```yaml
# Which store this machine runs — 0056 §1.
database:
  store: postgres
  url: …
```

`runtime:` and `projects:` are gone from this file.

**0046 §3 never put limits here, and its own table says so:**

> | `~/.lingtai/` | my gates, **my limits**, my agent, my log | me, before I push |

`~/.lingtai/` is the whole directory, and the recipe is
`~/.lingtai/<project>/recipe.yml`. **The line 0046 §3 draws is `~/.lingtai/`
against the managed repository** — not `config.yml` against `recipe.yml`. That
second, finer split arrived with #180 and was never argued for.

**The machine file's own contents are the evidence against it.** It holds
`projects.lingtai.runtime.limits` and `projects.nextloom-ai-admin.runtime.limits`
— per-project configuration in the file for things that are true of the laptop.
And under `rounds: 3` sits a page of argument about *what a refusal means*,
citing [011](../experiments/011-patching-versus-starting-over.md), `#51` and
`#148`; under `restarts: 1`, *"this is not settled and is not being claimed as
settled… whoever changes this next writes the run into `doc/experiments/`
first."*

That is not a fact about a laptop. In 0046 §3's own words it is *how I want this
repository's work judged*, which is the recipe's half of the sentence.

**No list of installed runtimes replaces them.** A `runtimes: [claude-code]` key
would be written, believed, and connected to nothing on the day it was added —
this project's most-repeated bug class. Whether a runtime is installed and
signed in is **looked at, not written down**: `doctor.ts:687`'s
`runtime: signed in` asks the runtime itself, and asks it in the one way that
distinguishes *the operator is signed in* from *the run's environment is
missing the credential*.

## 2. The recipe says which runtime, per step

0053's argument, unchanged:

> Installed CLIs and their authentication are machine capabilities. Which of
> those CLIs should do a project's work is a recipe decision. Keeping gate
> prompts in one file and their agents in another would **split one decision
> across two sources**.

Under `steps:` that argument gets stronger rather than weaker: `turns` and
`wall` bound the agent at `implement`, and that agent is declared three lines
above them.

```yaml
implement:
  - name: the work
    agent:  claude-code
    prompt: |
      …
    turns:  150
    wall:   1h
    rounds: 3
```

**`agent:`'s value is the runtime, and it is an enum.** Today it is the prompt
(`recipe.ts:105`, `definePlugin("agent", { agent: z.string() })`), so this
reinterprets an existing key — and a free string would accept a paragraph of
prose as a runtime name and fail only when the agent was started. `z.enum` makes
it a refusal at resolve, by name. That is 0016 §4, and it is the failure
[#230](https://github.com/steven-zhc/lingtai/issues/230) hit when a leftover
`gates:` was silently dropped by a `z.object` and the suite stayed green.

`model:` and `prompt:` are siblings, so the scalar stays a single value. This
repository has exactly one `agent:` action to rewrite — `review`, at line 181 of
its recipe.

**`rounds` and `restarts` stay where 0061 §3 put them** — carried by the plugin,
at the step they bound: `rounds` on `implement`'s `agent:`, `restarts` on
`claim`'s `queue:`. Not at a step-level key above the list, and not at
`proposed`, which is the step that counts them. 0061 §2 settles this and this
ADR does not reopen it:

> `timeout:` is written on the plugin that may run too long, never on the runner
> that stops it… **The one that counts and the one that is counted are not the
> same step**, and the file follows the second, because that is where a reader
> looks.

**So a step stays a plain list.** No `plugins:` node, no union of list-and-map.
Which plugin an entry is remains Ansible's module-as-key — the entry carries
exactly one key that is a plugin name, and `pluginNaming` / `pluginsNamed`
already refuse zero or two of them (#228).

## 3. `assignee` is `queue:`'s, and this revises 0061

0061 §3 lists `assignee:` as its own plugin at `claim`, and §2 uses the pair as
its worked example of *a step's plugins run in the order written, the first that
yields a work item wins*. **That is revised here: `assignee` is a field of
`queue:`.**

```yaml
claim:
  - name: the queue
    queue:
      kinds:    [bug, tech-debt, feature, documentation]
      exclude:  [blocked, in-progress, agent:hold, …]
      backoff:  1h
      assignee: { take: both }
    restarts: 1
```

Three reasons, and the first is the one that decides it.

**They answer one question.** `kinds` orders the listing, `exclude` filters it,
`assignee` filters it. All three are applied in one pass over one GitHub
response in `discover.ts`. Two plugins that must both be present and must agree
is 0053's *one decision across two sources*, one level down.

**0046 §3's argument for `assignee` being the machine's does not survive the
move.** It reads: *whether one person's Lingtai leaves a colleague's tickets
alone is that person's setting, not the repository's.* But the recipe **is** that
person's setting — it is on their machine, written by them, and not in the
managed repository. That sentence distinguishes `~/.lingtai/` from the
repository, and cannot distinguish two files inside `~/.lingtai/`.

**The machine file shows the same tell as `limits`.** `assignee` lives there as
`projects.<name>.runtime.assignee` — per-project again.

`PLUGINS` goes from twelve to eleven. `AssigneeRule` moves into `QUEUE_FIELDS`
with its refinement intact: `take: mine` without a `login` still matches no
issue at all, and an empty queue reads exactly like a repository with nothing to
do.

## 4. Both refusals invert, and neither may be dropped

Today `local.ts:394` refuses `runtime.agent`, `runtime.limits` and
`runtime.assignee` written in a recipe, naming the machine file; `local.ts:403`
writes the machine's values into `raw["runtime"]`.

After this:

- **The machine file refuses `agent`, `limits` and `assignee` by name**, naming
  the recipe and the step each belongs on.
- **The write-back is deleted.** There is no `runtime:` block to write into, and
  nothing to write.

**A v2 recipe has no `runtime:` block, so the old refusal loop reads an empty
object and refuses nothing.** Left as it is, the split is not enforced — it is
silently gone, which is the exact shape of the defect this project keeps
repeating and 0016 §4 exists to stop. The refusal is not a courtesy; it is the
only thing that makes the move visible to whoever typed the old key.

## 5. What this costs

**A runtime the recipe names and the machine does not have must be refused
before a pass starts**, not when the agent is spawned. Today `doctor` runs one
`runtime: signed in` check; it needs one per runtime the recipe names across its
ten steps. That is `the-pipeline.md`'s **T8**, and this ADR is a reason for it
rather than a duplicate of it.

**0053's recipe-side code is on the Codex epic's branch, not on `main`.**
[#199](https://github.com/steven-zhc/lingtai/issues/199) — *the recipe chooses
an agent, model and limits for each role* — is closed, and `main`'s schema has
no per-role runtime. Whether #231 takes that work or redoes it is an
implementation question this ADR does not settle, but it is not free either way.

**Two of the six landing sites are unwritten here.** `merge:`'s agent and
`design:`'s agent are not in this repository's recipe at all, so a write-back
built from the sites that exist would put values where they should have been
refused. Absent and empty are different, and the resolve must keep them
different.

## Related

- [0053](0053-the-recipe-chooses-the-agent-for-each-role.md) — the decision this
  implements. Accepted 2026-09-17, implementation pending since.
- [0046](0046-lingtai-is-personal.md) §3 — the personal topology and the recipe's
  location, both kept. Its *placement* of agent and limits was already superseded.
- [0061](0061-the-recipe-is-the-pipeline.md) §§2–3 — universal keys, module-as-key
  and the plugin table. Kept, except `assignee:`.
- [0016](0016-the-settled-model.md) §4 — a key silently dropped and a key that
  does not exist are different facts to whoever wrote it. §4 above is that rule.
- [`the-v2-recipe.md`](../design/the-v2-recipe.md) §3.6 — the open question this
  closes, and the document to correct: it does not know 0053 exists.
