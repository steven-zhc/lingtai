# 0037 — An extension is a command, and the only question is whether the core waits

**Status** accepted · 2026-09-09 · supersedes
[0016](0016-the-settled-model.md) §5's "Plugins are trusted code"; keeps the
rest of §5 whole

## Context

0015 and 0016 both settled the taxonomy, in the same table:

> ## 5. Two extensions, and only two
>
> **The rule:** if the loop must wait for it, it is a gate action; if it cannot
> affect the outcome, it is a subscriber.

That table is right and this decision keeps it. What both documents then say is
what has stopped being true:

> The gate action contract already exists and needs no design — `Gate`, taking a
> `GateContext` (runId, `onSha`, cwd, filtered env).

```ts
// packages/actions/src/gate.ts:57
export interface GateContext { runId; onSha; cwd; env; signal }
```

Correct when written, because every action then was a check on a diff — build,
tests, a cold reviewer. It is not enough for an action that is a *policy*.
Take a real requirement: **a ticket carrying a particular label needs a
particular person's approval.**

- `when:` exists only on `close:` and `labels:`, and filters on the *outcome*
  (`landed | blocked | failed | any`), not on the ticket. So "only some tickets"
  cannot be said.
- `human:` is one string, the question. There is no room for who.
- **A gate action does not know which ticket it is judging.** Not the labels,
  not even the issue number: `agent-env` injects nothing about the item, so the
  fallback of shelling out to `gh issue view` is not available either.

The second gap is in the same file, and matters more once extensions are
third-party:

```ts
// packages/actions/src/gate.ts:130
try {
  result = await gate.run(context);
} catch (err) {
  // A gate that throws is a gate that failed. …
  result = { verdict: "failed", … };
}
```

**A throw becomes a refusal.** Today that is safe, because every action is
first-party and a throw is a bug. Once a user writes one, a throw is routine —
the network is down, the binary is missing, the API rate-limited — and "the scan
found a vulnerability" and "the scan could not start" become the same event
while wanting opposite handling.

And the subscriber side is a guarantee written in the wrong layer. The rule is
stated where it is implemented:

```ts
// packages/daemon/src/notify.ts:212
// Never rethrown. This is called from the daemon's subscription, and a
// notifier that could stop the log being followed would be a notifier
// that takes the board down.
```

but the boundary does not enforce it:

```ts
// packages/daemon/src/work-loop.ts:293
void options.notify?.(event);                                    // no .catch
void options.discuss?.(event).catch((err) => …);                 // has one
```

Safety depends on the implementation behaving. There is also no way to have a
second channel: `lingtai.ts:406` constructs `macNotifier()` by name.

## Decision

### 1. Two meanings of "untrusted", and only one of them is real

The words have been doing double duty and the two halves need separating,
because a policy extension that says "let it through" looks, under a single
reading, like a contradiction.

| | Trusted? | Because | So |
|---|---|---|---|
| the extension's **code** | **no** | it can hang, exit, leak, or read `LINGTAI_DATABASE_URL` | it runs in its own process, on a clock, with its own credentials |
| the extension's **verdict** | **yes** | the recipe named it, at a point, on purpose | the core does what it says |

**The trust boundary is the recipe, not the extension.** Anyone who can edit
`.lingtai/config.yaml` can already delete the gate outright, so an extension
deciding who may approve is not weaker than the core deciding it — both are
exactly as strong as write access to the recipe, which is
[0005](0005-config-in-target-repo.md)'s boundary and has not moved.

This replaces 0016 §5's last paragraph — *"Plugins are trusted code. There is no
plugin sandbox. They run in the daemon's process with the daemon's credentials,
including the GitHub App key."* That paragraph was written so nobody would later
assume otherwise, and it is retired by making the other thing true, not by
assuming it.

A ticket store is not covered by any of this. See
[0036](0036-the-core-takes-a-ticket.md) §6.

### 2. There is no plugin system. An extension is a command

`run:` already starts a process and reads its exit code. It is already
out-of-process, already declared in the recipe, already isolated. **The
extension mechanism is the one that exists**, and `use:`, a registry, a
manifest, a loader and a machine-level config are all deleted before being
built:

```yaml
merge:
  - name: security-approval
    run: npx @lingtai/label-approval
    timeout: 30m
```

`agent:`, `watch:` and `human:` stay built in — a cold reviewer needs the core's
agent runtime, globs against a diff are a pure function, and waiting for a person
is the `ApprovalRequested` path. **`run:` is the single extension point.**

### 3. A subscriber is the same command, and the core does not wait

```yaml
subscribers:
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked, RunFailed]
    run: npx @lingtai/telegram
```

The declaration of which events it wants is also the subscription — one
mechanism doing both jobs, which is what VS Code's activation events buy and the
reason to copy them.

> **The whole taxonomy is: a command, and whether the core waits for it.**

A gate action's exit code is a verdict, so the core waits. A subscriber's is
discarded, so it does not. That is 0016 §5's rule, unchanged, with the mechanism
filled in.

### 4. Context in on stdin; verdict out by exit code and a file

**In: JSON on stdin.** Not the environment — a real `RunPrompted` in this log
carried `bytes: 4555`, and an environment is both size-limited and visible in
`ps`. A command that does not read stdin ignores it, so every recipe that works
today still works.

**Out: the exit code, and optionally a file.** stdout is spoken for:

```ts
// packages/actions/src/command.ts:64
/** The last N lines, capped — a build log can be megabytes. */
export function tail(text: string, …)
```

Taking stdout for structured output would take the failure output of every
`pnpm test` with it. So the exit code carries pass/fail, and anything richer —
findings, `request-approval` — is written to the path the core names in
`LINGTAI_RESULT`. Plain commands never look at it; extensions do.

### 5. A failure is not a refusal, and the recipe says which

`gate.ts:130` conflates them (see Context). They separate, and the action
declares what its own failure means:

```yaml
    on-error: fail      # could not run ⇒ refuse. The default.
    on-error: skip      # could not run ⇒ this action had no opinion
```

`fail` is the default because it is the conservative one and because it is what
the code does today. The distinction is Kubernetes' `failurePolicy`, and it is
worth naming where it came from: an admission webhook that cannot be reached is
not a webhook that said no, and the cluster's operator is the one who knows
which of those matters here.

**And a subscriber has no such setting.** Its failure is always ignored,
structurally, because nothing reads its exit code — which is the same fact as
"it returns void", said in process terms.

### 6. Timeouts have a budget, and the budget is per point

Every `run:` already has its own `timeout`. That is not sufficient. Kubernetes
learned this in the open: **with every webhook set to `Ignore`, admission still
fails once their timeouts sum past the global one**
([kubernetes#128162](https://github.com/kubernetes/kubernetes/issues/128162)).
"A failure is ignored" is not the same guarantee as "a failure is bounded", and
only the second one keeps the loop moving.

So a point has a ceiling, and the actions at it spend against it.

### 7. A failed extension is an event

A subscriber whose failure is a console line is a notifier that has silently
stopped notifying — the one failure mode a notifier must not have. `PluginFailed`
is appended, so `lingtai doctor` and the board can say it, for the same reason
`GatesResolved` is an event and not a convention (0016 §4).

## Consequences

- **`GateContext` gains the ticket.** `TicketRef` (0036 §3) is *payload*, handed
  over with the invocation — an extension does not ask for it and does not need
  permission for it. The attempt history is not: it lives in the log, and reading
  the log is a **capability**, which an extension would have to be granted by
  name. That line is where the next argument will be.

- **`request-approval` and waiting are two different powers.** An extension that
  returns `request-approval` hands the decision to the core, whose approve button
  is open to whoever is looking at the board. An extension that wants to control
  *who* must wait itself and return pass/fail. Neither is wrong; the recipe
  author is choosing between "anyone may release this" and "I decide who does",
  and should be told so.

- **`work-loop.ts:293` gets its `.catch`,** and the guarantee moves out of
  `notify.ts`'s comment and into the boundary. A process boundary makes it
  structural; the `.catch` is what holds until then.

- **`macNotifier()` stops being named in `lingtai.ts:406`.** It becomes a
  subscriber declared like any other, and the first thing that proves this design
  is Lingtai's own notifications going through it.

## Open

- **One process per event.** Four event types for Telegram is nothing; a
  subscriber on every append would fork continuously. The answer when it arrives
  is a long-lived process fed a stream on stdin, or batching in the core. Not
  needed to ship, and recorded so the first person to hit it knows it was seen.

- **Protocol version.** The JSON on stdin becomes a public contract the moment
  an extension is written by somebody else. Events carry `schema_ver` and have
  upcasters; the extension payload has neither yet.

- **Credentials per extension.** §1 says an extension gets its own rather than
  the daemon's. Where they are declared, and how a Telegram bot token reaches the
  process without reaching every other one, is not designed. `~/.lingtai/env/`
  and [0021](0021-the-recipe-decides-the-environment.md)'s layers are where it
  should start.
