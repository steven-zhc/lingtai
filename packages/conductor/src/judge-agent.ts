import type { ActionFinding } from '@lingtai/actions'
/**
 * **An agent, paid for a judgement** — the prompt a runtime judge is given and
 * the reading of what it answers (`#277`).
 *
 * `judge.ts` is the decision and the bound; this is the half that costs money,
 * and the two are separate files for the reason that one says so at its head:
 * *a rule about spending money that lives inside an `if` in a 3,000-line file is
 * a rule nobody can check.* Neither function here decides anything — the
 * destination comes back from the model and is held to the offer by `judged` in
 * `pass-steps.ts`, which is where every other route is held to it too.
 *
 * **Why an agent at all, for one of the five directions.** 0061 §3 measured
 * `findings` at 231 refusals in fourteen days and calls it *the one judgement
 * worth an agent*, because it is the only arrival where the two answers are
 * different work: *these lines are wrong* is another round in the worktree that
 * is already cut, and *this approach is wrong* is a fresh one
 * ([#223](https://github.com/steven-zhc/lingtai/issues/223)). A `switch` cannot
 * tell those apart from a findings array; reading the findings is the whole of
 * the job, and it is what the run buys.
 *
 * **The vocabulary here is the pass's** — `Destination` is `Step | "waiting"` —
 * and not `judge.ts`'s three. That is deliberate and is the same split
 * `MECHANICALLY` is on the other side of: the loop offers `build` from `merge`
 * and the asking step back to itself, neither of which `implement | claim |
 * human` can say, so an agent told the three would be told a set the workflow
 * never computed. What it is shown is `Judging.offering`, verbatim.
 *
 * **No ceiling reaches this file**, which is `JudgeBrief`'s property kept where
 * the money is: the prompt is built from `Judging`, which carries the set and no
 * count, so there is no number here for a prompt to leak and no arithmetic for
 * one to argue with. A judge cannot widen what it cannot see.
 */
import { STEPS } from '@lingtai/domain'

import type { Judging } from './pass-steps.ts'
import type { Destination } from './pass.ts'

/**
 * What each offered destination *is*, in the words the agent is asked to choose
 * between.
 *
 * Partial on purpose, and the fallback below is the honest reading of the rest:
 * the destinations with a meaning worth spelling out are the four the router can
 * offer for a refusal, and a `needs-input` arrival offers the step that asked —
 * `admit`, `design` or `implement` — where *that step again* is the whole of it
 * (0058 §3c). A total record would need an invented sentence for six steps
 * nothing offers, which is six sentences nobody would ever check.
 */
const MEANS: Partial<Record<Destination, string>> = {
  waiting: 'stop the pass and put this to a person, with your reasoning on the card',
  implement:
    'another round in the worktree that is already cut, with what refused — for when the diff ' +
    'is the right approach and some of its lines are wrong',
  claim:
    'release the ticket and start over from the base, in a fresh worktree — for when the ' +
    'approach itself is wrong and patching these lines would be patching the wrong thing',
  build:
    'back through the build and the cold reviewer, against the base as it now stands — for a ' +
    'conflict somebody has resolved',
}

/** A finding as a judge is shown it: the claim, the scenario behind it, and where. */
function said(finding: ActionFinding): string {
  const at = finding.line === null ? finding.file : `${finding.file}:${finding.line}`
  return `- **${finding.severity}** ${at} — ${finding.claim}\n  _${finding.failureScenario}_`
}

/**
 * **The whole of what a runtime judge is asked**, and it asks one question.
 *
 * The shape is `buildReviewPrompt`'s, deliberately: what refused, what it said,
 * and a JSON answer with a named key, because a model asked for JSON usually
 * gives JSON and `chosenIn` is defensive about the times it does not. What is
 * different is that the answer is a *choice from a list the caller wrote*, so the
 * list is in the prompt verbatim and the instruction not to invent one is in it
 * twice — once as a rule and once as what happens if it is broken, which is the
 * only thing that makes the rule worth anything to a model.
 *
 * **It is told the cost of each destination and never the budget.** *Another
 * round* and *start over* are what the choices mean; how many of either are left
 * is the workflow's arithmetic and is already spent in building `offering`. So a
 * judge that reasons *I should be careful, there may be only one round left* is
 * reasoning about something it was not told and cannot get wrong: the set it is
 * choosing from is what is left.
 */
export function judgePrompt(on: Judging): string {
  const offered = on.offering.map((to) => `- \`${to}\` — ${MEANS[to] ?? `run the \`${to}\` step again`}`).join('\n')
  return `# Which step is next

A pass over one ticket did not pass. You decide where it goes.

## What refused, and why

The reason the step gave is **\`${on.when}\`**.

${
  on.findings.length > 0
    ? `The cold reviewer's findings, verbatim:\n\n${on.findings.map(said).join('\n')}`
    : 'The cold reviewer raised no findings.'
}

${
  on.evidence.trim() === ''
    ? 'The step printed nothing beyond that.'
    : `What the step printed:\n\n\`\`\`\n${on.evidence.slice(0, 8_000)}\n\`\`\``
}

## The choices

These are the only destinations on offer. The list is the workflow's: it has
already counted what this pass may spend, so anything not on it is not a thing
you can ask for.

${offered}

## What to weigh

The question is **whether the lines are wrong or the approach is**. Findings that
name specific lines, with failure scenarios an edit would answer, are the lines.
Findings that say the shape of the change is wrong — the wrong seam, the wrong
data structure, a rule in the wrong module — are the approach, and another round
patching those lines spends money to arrive back here.

Read only what is above. You have no worktree and nothing to run; this is a
judgement about what has already been said, not a fresh investigation.

## Answer

One JSON object, and nothing else that could be read as one:

\`\`\`json
{"next": "<one of the destinations above, spelled exactly>", "why": "<one or two sentences>"}
\`\`\`

\`next\` must be one of ${on.offering.map((to) => `\`${to}\``).join(', ')}. An answer
naming anything else is refused and the pass is held for a person — you will not
be asked again, so a destination you are unsure of is worth less than
\`waiting\` with your reason on it.`
}

/** A destination the pass has a name for — not necessarily one that was offered. */
function isDestination(value: unknown): value is Destination {
  return value === 'waiting' || (typeof value === 'string' && (STEPS as readonly string[]).includes(value))
}

/**
 * **The choice, from whatever the judge actually said** — or null, where it said
 * nothing that is a destination.
 *
 * `parseFindings`' shape and for its reason (`#272`): every brace is a candidate,
 * tried last first, because the object is what the answer *ends* in and the first
 * brace in the text is the prose's whenever the model quoted anything. A fenced
 * block is tried before either.
 *
 * **Null is the answer that costs nothing, and it is not the same as `waiting`.**
 * A judge that answered nothing readable has not judged, exactly as a reviewer
 * whose answer will not parse has not reviewed (`agent-action.ts`), and the
 * caller says so in the words on the card rather than filing it as a choice
 * somebody made. What it must not do is retry: an agent that cannot answer the
 * question twice costs twice and terminates no sooner.
 *
 * **A destination it was not offered is returned, not dropped**, and that is the
 * one case where being permissive here is the safe thing. The refusal a person
 * reads names what the judge asked for and which entry of the recipe to edit —
 * `judged` in `pass-steps.ts` builds it — and a null here would lose that,
 * leaving *the judge said nothing* on the card for a judge that said `implement`
 * with every round spent.
 */
export function chosenIn(text: string | null): { readonly next: Destination; readonly why: string } | null {
  if (!text) return null

  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? []
  for (const block of fenced) candidates.push(block.replace(/```(?:json)?/g, '').replace(/```/g, ''))
  for (let i = text.length - 1; i >= 0; i--) if (text[i] === '{') candidates.push(text.slice(i))
  candidates.push(text)

  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    const next = (value as { next?: unknown })?.next
    if (!isDestination(next)) continue
    const why = (value as { why?: unknown })?.why
    return {
      next,
      // Its own words are what `waiting` displays (0043), so a judge that chose
      // and explained nothing still leaves a sentence rather than an empty card.
      why: typeof why === 'string' && why.trim() !== '' ? why.trim() : 'it gave no reason',
    }
  }

  return null
}
