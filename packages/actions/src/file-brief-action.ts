/**
 * The file-brief action: **the other end of the file destination**, and the
 * first thing anywhere that reads a locator
 * ([0066](../../../doc/decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4, [0069](../../../doc/decisions-archive/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
 * §4, `#301`).
 *
 * `createFileAction` keeps a document at a path and answers with that path.
 * This is what reads it back at `implement` and hands the text to the agent —
 * so a `file:` design and a `confluence:` design differ in **two plugins**
 * rather than in anything the core knows, which is the whole of what makes the
 * locator opaque worth having (0066 §4).
 *
 * ## Why this is a plugin and not a field on `agent:`
 *
 * The pairing is the point (0066 §5). A `file:` design and a file-reading
 * `implement` work together; a `confluence:` design needs a Confluence-reading
 * one. Making `agent:` able to read both means `agent:` grows a `destination:`
 * field — the trap 0066 §5 is about, and the one `#268` and `#269` both sprang.
 * So there is **no branch per destination in here**: this action understands a
 * path in the worktree and nothing else, and a locator it does not recognise is
 * reported rather than guessed at.
 *
 * ## It reads, and it does not decide
 *
 * `implement` is not one of `REFUSING_STEPS` (0058 §3b), so every way this
 * fails is a `did-not-finish`: the pass stops for a person, no fix round is
 * bought, and nothing has been judged. That is the second row of the three a
 * destination fails by ([doc/writing-a-plugin.md](../../../doc/writing-a-plugin.md),
 * 0066 §7 as corrected by `#299`) — **start every run-time failure there**, and
 * move one to the asking row only when the person it reached answered it with
 * something only they knew.
 *
 * ## It wraps and does not reimplement
 *
 * The read is the caller's, handed over as `FileBriefActionDeps.read` for
 * `FileActionDeps.keep`'s reason: a filesystem is a thing only a caller with a
 * machine under it has, and an action built without one is refused by name
 * rather than quietly briefing the agent with nothing (`from-recipe.ts`).
 *
 * ## What it changes, and who then owns the disagreement
 *
 * It answers with `document` and `locator`, so `runActionPipeline` advances
 * `ActionContext.design` and the `agent:` written after it in the same list is
 * briefed with **what was read back** rather than with the copy the pass has
 * been carrying. 0069 §4 says that in as many words: *if a plugin at `implement`
 * ever does resolve a locator and work from what comes back, that plugin owns
 * the disagreement — nothing here will tell it.* This is that plugin. The two
 * can differ where a destination reformatted what it kept or where somebody
 * edited the file between the two steps, and **this action prefers what it
 * read**, because the point of declaring it is to make the kept copy the one
 * the implementer works from.
 *
 * `evidence` says the size and the path it read, so a person comparing the two
 * cards can see whether `design` wrote what `implement` was given.
 */
import { whyThePathEscapes } from '@lingtai/recipe'

import type { Action, ActionContext, ActionResult } from './action.ts'
import { sizeOf } from './file-action.ts'

/**
 * What the read answers — two branches, `KeptAnswer`'s mirror, and no `asked`
 * one for its reason: a path in the worktree needs no credential, no space and
 * no permission a pass does not already hold, so every way this fails is 0066
 * §7's second row.
 */
export type ReadAnswer =
  /** The document, exactly as the destination kept it. */
  | { readonly document: string }
  /** Why it could not be read, in words a person reads (0043). */
  | { readonly notRead: string }

/**
 * The read, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `FileActionDeps` and `WorktreeActionDeps` and a reader meets one convention.
 */
export interface FileBriefActionDeps {
  read(spec: {
    /** Relative to the worktree, and `whyThePathEscapes` has already refused anything else. */
    readonly path: string
  }): Promise<ReadAnswer>
}

export interface FileBriefActionSpec {
  name: string
}

/**
 * **The sentence a locator this destination does not understand is refused
 * with**, and it names the destination it expected rather than guessing at the
 * one it was given.
 *
 * It is the only thing in this file that looks at the string at all, and it
 * looks at it the way `filePlugin` does — `whyThePathEscapes`, the *same*
 * function the schema refuses a bad `file:` with, so the two halves of one
 * destination cannot disagree about what a file locator is.
 *
 * **0069 §3 is about the other plugin.** *A `confluence:` locator handed to a
 * file-reading `implement` is not a failure — the plugin does not recognise the
 * string, ignores it, and works from `document`* is true of a plugin that does
 * not read locators, which is every plugin at `implement` that existed when
 * that was written, the built-in dispatch included. A plugin **declared** to
 * read one has nothing to do with a locator it cannot read, and passing would
 * be an entry in the recipe that bought nothing and said so nowhere (`#61`).
 * §4 is the paragraph that covers this one, and it hands it the disagreement.
 */
function notThisDestination(locator: string, why: string): string {
  return (
    `the design was not read back: \`${locator}\` is not somewhere a \`file-brief:\` can read — ${why}. ` +
    'This action reads what a `file:` at `design` kept, which is a path inside the worktree and nothing ' +
    "else; a design kept anywhere else is read by that destination's own plugin at `implement` (0066 §4)"
  )
}

export function createFileBriefAction(spec: FileBriefActionSpec, deps: FileBriefActionDeps): Action {
  return {
    name: spec.name,
    kind: 'file-brief',

    async run(context: ActionContext): Promise<ActionResult> {
      const design = context.design
      if (design === undefined) {
        // A context nothing filled in, which is one built by hand: `runStep`
        // sets `design` on every verdicts pipeline, off the last `design` visit.
        // Reported rather than read as an empty brief, because *nobody handed
        // this a design* and *the design step answered that none was needed* are
        // different facts and only the second is an answer (0058 §3).
        return {
          verdict: 'did-not-finish',
          evidence:
            `nothing handed "${spec.name}" a design to read — a \`file-brief:\` reads what a ` +
            'destination at `design` kept, and no pipeline filled `ActionContext.design` in',
          findings: [],
        }
      }

      // **Silent where nothing was kept.** No locator is *no destination was
      // declared at `design`, or the drafter answered that this change needs
      // none* (0069 §5) — and both of those are one brief to `implement`, which
      // works from the issue either way (0058 §3). So this changes no fact: no
      // `document` and no `locator` on the result, and the design the pass came
      // in carrying is the one the agent after this is dispatched with.
      if (design.locator === undefined) {
        return {
          verdict: 'passed',
          evidence: 'nothing to read back — no destination at `design` kept a document',
          findings: [],
        }
      }

      const why = whyThePathEscapes(design.locator)
      if (why !== null) {
        return {
          verdict: 'did-not-finish',
          evidence: notThisDestination(design.locator, why),
          findings: [],
        }
      }

      const answer = await deps.read({ path: design.locator })
      if ('notRead' in answer) {
        return {
          verdict: 'did-not-finish',
          evidence: `the design was not read back from \`${design.locator}\`: ${answer.notRead}`,
          findings: [],
        }
      }

      return {
        verdict: 'passed',
        // The mirror of the keep's sentence, and the fact a person reads the
        // card for: the implementing agent was briefed with *this*, off *there*.
        evidence: `read a ${sizeOf(answer.document)} design back from \`${design.locator}\``,
        findings: [],
        // **Both, off one result** (0069 §5). The locator is the one it was
        // handed, unchanged — this action kept nothing, so it has no new place
        // to report — and the document is what came back, which is what the
        // agent written after this is briefed with.
        document: answer.document,
        locator: design.locator,
      }
    },
  }
}
