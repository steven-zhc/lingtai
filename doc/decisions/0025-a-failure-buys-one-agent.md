# 0025 — A failure buys one agent, and the person approves a diff

**Status** accepted · 2026-09-08 · extends [0016](0016-the-settled-model.md)
without opening its closed set

## Context

`nextloom-ai-admin#112` sat in **Waiting on you** for four days holding this,
and nothing else:

```
441 WorkItemBlocked  "conflict: agent/112 does not merge into develop:
                      apps/web/src/components/users/user-lookup-panel.tsx"
```

A git message with a colon in it. No diagnosis, no proposal, and — because the
board only offers Approve/Reject when a `headSha` is present — **no button**.
The operator was being asked to diagnose a merge conflict, in an interface with
no diagnosis in it.

Three things converge on that card.

**The vocabulary has one shape for two opposite things.** `WorkItemBlocked` is
`{ question, needsFrom: "human" }`, and the same item carries both of these:

```
137 WorkItemBlocked  "held at the merge gate: agent/112 into develop"
441 WorkItemBlocked  "conflict: agent/112 does not merge into develop: …"
```

The first is a real question — a `human:` action asking for judgement that is
genuinely the person's. The second is a failure nobody has looked at. The word
`question` is the tell: the model can ask, and cannot report.

**A retry cannot learn.** `prompts/ticket.md` contains no mention of a previous
attempt — grep it for `attempt`, `previous`, `fail`, `conflict` and it returns
nothing. `attempts: 2` on a card therefore means *we paid twice*, not *we
learned once*. The loop is already braced against the cost of that: `runQueue`
refuses the same item twice in one pass and stops with `exhausted` rather than
`empty`. Machinery exists because blind retries are expensive; the cheaper fix
is to stop them being blind.

**And the operator asked for the general case**, not the conflict: when the
managed system errors at any step, Lingtai should spend one agent on
understanding it, and come back with a recommendation rather than a question.

## The decision

**The five points stay closed. A failure gains an outcome.**

0016 says *"No sixth point will ever be added."* A repair is therefore not a new
point, and not a new action kind. It is what happens after a failure:

> a failure releases the item with its reason → the next attempt is **told what
> went wrong** → it produces a commit → the person approves **that diff**

Everything this needs already exists — claim, worktree, agent, gates, integrate,
`ApprovalRequested` bound to `onSha`, Approve and Reject on the card. Nothing
new is introduced into the loop; a repair attempt is a run, and the only thing
that distinguishes it is what its prompt was told.

**The repair acts. It does not advise.** This is the load-bearing half. An
approval in this system already means *merge what the held run actually
produced*, and a verdict is bound to one commit so a force-push invalidates it
by arithmetic. A proposal with a commit behind it is approvable in the existing
vocabulary. A proposal without one is not — it would need a second round trip, a
second kind of approval, and a way to execute advice, none of which exist. So an
agent that only writes a recommendation is the more expensive design, not the
cheaper one.

## What it rests on

Four decisions, taken by the operator on 2026-09-08.

### 1. Lingtai's own failures never reach an agent

| whose failure | examples | analysed |
|---|---|---|
| the managed repository's | build red, tests fail, merge conflict, lint | **yes** — the agent holds the worktree and can act |
| **Lingtai's own** | no GitHub App, a recipe that will not parse, a required env value missing, no hook binary, an unreachable database | **never** |

An agent pointed at the second class has no access to the thing that is broken
and nothing it could change. It would spend money to report that it cannot see
anything, and the report would be addressed to the one person who did not need
it. The seam is already in the code: project-level refusals are Lingtai's
(`conduct.ts`, `outcome.refused`), gate verdicts and `IntegrationRefused` are
the repository's.

### 2. The default is the recipe's, and it is rendered

0016 §7 deleted the policy the core guessed at on behalf of a repository it
cannot see, and this is the same shape. So *whether this project repairs* is a
recipe field with a default value, not a behaviour compiled into Lingtai — and
like a `skipped` point, **it is shown**. A repository must be able to see
whether it repairs without reading Lingtai's source.

### 3. "Once" is structural, not aspirational

Three bounds, all of them needed:

- one analysis per **distinct** failure, not one per pass
- a ceiling on attempts, in the recipe
- **an analysis that fails does not trigger an analysis of the analysis**

Drop any one and a single bad ticket spawns an agent per lap. This is the only
part of the design where the failure mode is unbounded spend rather than a
wrong answer.

### 4. The mechanical remedy first; the agent is the fallback

A merge conflict is staleness, not a defect, and the integrator already tries
the mechanical fix: merge the base in, verify, merge out. `#112` conflicted
*after* that ran, which is what makes an agent the right next step **there** —
not what makes it the right first step anywhere. The order is fixed: mechanical,
then agent only once the mechanical path is exhausted and that exhaustion is on
the log. A conflict must not cost money by default.

## What this is not

- **Not a sixth gate point.** The set stays five and stays closed.
- **Not an advisory agent.** See above: advice is not approvable.
- **Not a retry loop.** The bounds in §3 are the difference, and they are the
  part to review hardest.
- **Not a summariser.** The raw failure stays reachable. A summary that hides
  the git output is worse than the git output, which is the whole complaint
  about `#112` inverted.

## Consequences

- **Cost becomes a line an operator reads.** A repair's spend is recorded and
  shown separately from the work's, because a default-on agent is otherwise an
  invisible bill.
- Three tickets carry it: `#82` feeds the failure into the next attempt's prompt
  and depends on nothing here; `#83` gives a block a diagnosis and a
  recommendation so the board's default action can be Approve; `#84` is the
  repair itself and the four decisions above.
- `WorkItemBlocked` widens rather than splits. Every block currently on the log
  has only a question and must keep rendering exactly as it does today.
- **The reversal condition.** If repair attempts are rejected more often than
  they are approved, the agent is guessing rather than diagnosing, and the
  design should fall back to advising — accepting the second round trip that
  choice costs. Reject-versus-approve on repair attempts is the number to watch,
  and it is already on the log.
- If a recipe says a project repairs and it does not, that is Lingtai's bug and
  `doctor` should say so. This is `#58`'s shape and the one thing this feature
  must not reintroduce.
