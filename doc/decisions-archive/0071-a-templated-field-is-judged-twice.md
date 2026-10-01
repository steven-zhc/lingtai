# 0071 — A templated field is judged twice, and the second judgement is at execution

**Status** accepted · **Date** 2026-09-29 · **Narrows
[0061](0061-the-recipe-is-the-pipeline.md)'s premise** *a recipe has no
templating*, which was true when it was written and stopped being true with
[#310](https://github.com/steven-zhc/lingtai/issues/310) · **Keeps 0061's rule**
— *every plugin in the recipe is validated at resolve time* — as the rule about
**the string a person wrote** · **Depends on**
[0066](0066-a-large-answer-is-a-locator-on-the-log.md) §6, which is where the
cost of a late refusal was counted

## 1. What expired

0061 gave a reason for validating earlier than Ansible does, and the reason was
a fact about this file format:

> Ansible validates inside the module, at execution, on the target host — it
> has no choice, since a task's arguments may be Jinja that only resolves per
> host. **A recipe has no templating and is resolved in full before a work item
> is claimed.** So: every plugin in the recipe is validated at resolve time,
> before a claim — before a worktree, before an agent, before any money.

`#310` makes `file:` take `{{issue}}`. That is exactly Ansible's case, one field
wide: the value is a template, its validity depends on the expansion, and the
expansion does not exist until a work item has been claimed. `resolveRecipe` is
handed a ref and a file and no ticket, so a check written there is a check on a
string that is not the path.

**The rule survives; its justification does not, and only for the fields that
are templates.** Nothing else in the recipe has a placeholder in it, and every
other field is still refused in full before any money. What this ADR exists for
is the sentence 0061 no longer supports — *a recipe has no templating* — because
a reader who believes it draws exactly the wrong conclusion about where a
check goes.

## 2. The decision: two judgements, on two strings, at two times

> **A field that takes a placeholder is judged twice: once at resolve, on the
> string a person wrote, and once where the expansion exists, on what the
> ticket made of it. Neither judgement replaces the other.**

For `file:` both are `whyThePathEscapes`:

| | when | on what | what a failure is |
|---|---|---|---|
| the schema's `superRefine` | resolve — `lingtai add`, and the daemon at start | `doc/design/{{issue}}.md`, as written | a refusal before a claim, before a worktree, before any money (0066 §6) |
| `thePathForThisTicket` | when the action runs | `doc/design/310.md` | `did-not-finish` at `design`, on the card, nothing written |

The written string is still refused for everything that can be decided without a
ticket — a `..`, a leading `/`, a `~`, and a `{{…}}` this field does not take.
What is left for the second judgement is the part that is a fact about the
ticket and not about the recipe.

## 3. Why the second one cannot be moved earlier

Two reasons, and they point the same way.

**`configHash` forbids it.** `ResolvedRecipe.configHash` is *of the resolved
form rather than the file's bytes*, so that a replay asking *did results change
after I edited the pipeline?* can answer from it, and it is on every
`RunStarted` and on `ProjectConfigured`. A path expanded at resolve would make a
recipe nobody edited hash differently on every ticket, and the question that
hash exists to answer would stop having an answer. The recipe resolves once per
daemon; the path is one per pass.

**And substitute first, refuse second.** `whyThePathEscapes` reads the string it
is handed. Asked before the substitution it says yes to `doc/{{issue}}.md` and
never sees `doc/../../etc/passwd`, which is what that path is for a ticket whose
ref carries `..`. A check on the template is not a weaker version of a check on
the expansion; it is a check of a different string, and putting the expansion's
question on the written one is `#310`'s **Watch out** verbatim.

Today a GitHub ticket cannot reach that case — `options.issue` is a number and
`took.ticket.ref` is `String(issue.number)`. The guard is for
[0036](0036-the-core-takes-a-ticket.md)'s named evolution, *`{{issue}}` should
become `{{ref}}`*, where Jira's is `PROJ-123` and another store's may carry a
slash.

## 4. What this does not license

**It is not a general move of validation to execution.** 0061's rule is
unchanged for every field that is not a template, and a plugin that would rather
check at run time because it is easier there is refused by this ADR rather than
permitted by it. The exception is *a field whose value is not known until a
ticket is*, and nothing else.

**The list of templated fields is one name long, and lengthening it is a
decision somebody writes down.** `filePlugin`'s `THE_PLACEHOLDER` is `{{issue}}`
and any other `{{…}}` in a `file:` is refused at resolve by name, with a reason
about the placeholder that was written. A second templated field — `{{issue}}`
in a `run:`'s `env:`, or 0036's rename to `{{ref}}` — carries the obligation in
§2 with it: whatever refuses the written string must have a partner that refuses
the expansion, at the point the expansion exists.

**The cost is stated rather than discovered.** A refusal in the second column is
one claim, one clone and one drafting agent — 0066 §6's own arithmetic — spent
because the string being judged did not exist any earlier. That is the price of
templating one field, and it is the number to weigh before templating a second.

## 5. Consequences

- 0061 §9's *And the timing is changed* keeps its rule and loses its premise. A
  note at the top of that file and beside the paragraph points here; the
  argument itself is not edited (`doc/README.md` — append-only in spirit).
- `packages/recipe/src/recipe.ts` holds both halves: the `superRefine` on
  `filePlugin`'s `file:` field, and `thePathForThisTicket` exported beside
  `whyThePathEscapes`. Exported, so the escaping-expansion case is reachable
  from a unit test without a store that has such a ref.
- `packages/actions/src/file-action.ts` asks the second question before it
  writes anything, and answers `did-not-finish` — `design` is not one of
  `REFUSING_STEPS` (0058 §3) and this action writes rather than judges.

## Related

- [0061](0061-the-recipe-is-the-pipeline.md) — the rule this narrows, and the
  premise it retires. Everything else in that ADR stands.
- [0066](0066-a-large-answer-is-a-locator-on-the-log.md) §1 and §6 — why the
  path is per ticket at all (a fixed path keeps one document, the newest, under
  a name the log handed to every pass), and the count of what a late refusal
  costs.
- [0036](0036-the-core-takes-a-ticket.md) — where `{{issue}}` is named, and
  where its rename to `{{ref}}` is named. That rename is what makes §3's second
  judgement more than a formality.
- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin's
  fields are the plugin's own, which is why the placeholder is `filePlugin`'s
  business and not the recipe parser's.
