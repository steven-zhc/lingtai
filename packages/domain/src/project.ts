/**
 * The Project aggregate: `prj-{project}`, alive as long as the project is
 * managed.
 *
 * It holds every fact about a project that is Lingtai's rather than the
 * repository's (0128): where to reach the repository — owner and base branch —
 * the last resolved configuration (a hash and the commit it came from, which is
 * not the recipe), the **declared recipe** — the text a person wrote and its
 * hash, from `ProjectRecipeChanged` — and the sandbox state its runs last met,
 * from `ProjectSandboxObserved`.
 *
 * Both of those two are appended on the transition, never the state: see
 * `recipeChange` and `sandboxObservation`. `ProjectRecipeChanged` does not set
 * `project`, so a stream holding only it is neither registered nor pending.
 */
import type { Envelope, ToAppend } from './envelope.ts'
import type { PayloadOf } from './events.ts'

export interface ProjectState {
  /** Null until the first event; a stream can be read before it exists. */
  project: string | null
  /**
   * The GitHub owner. Null for a project registered before `ProjectConfigured`
   * carried one — re-run `lingtai add` to record it.
   */
  owner: string | null
  /**
   * The branch this project's recipe is read from and merged into. Null for a
   * project registered before it was recorded — re-run `lingtai add` to record it.
   */
  base: string | null

  /** The last resolved recipe hash, and the commit it was resolved from. */
  configHash: string | null
  fromSha: string | null

  /**
   * The refusal a conductor's pass last recorded, while nothing has recovered
   * from it (#148). Null is *not refusing*, whether nothing ever was or a
   * `ProjectRecovered` followed. The seq and time are the event's, so a reader
   * can say *since when* without the reducer reading a clock (0027).
   */
  refused: RecordedRefusal | null

  /**
   * Set while a person's `ProjectPaused` stands with no `ProjectResumed` after
   * it (0126). The seq and time are the first pause's event's, so *since when*
   * needs no clock.
   */
  paused: { by: string; seq: bigint; at: Date } | null

  /**
   * The declared recipe on record. Null is *not recorded yet*, never an empty
   * recipe. The seq and time are the event's, so *since when* needs no clock.
   */
  recipe: (PayloadOf<'ProjectRecipeChanged'> & { seq: bigint; at: Date }) | null

  /** The sandbox state the project's runs last met, and the run that met it. */
  sandboxObserved: (PayloadOf<'ProjectSandboxObserved'> & { seq: bigint; at: Date }) | null

  /**
   * The highest PR number the project has recorded (`ProjectPrNumbered`), the highest PR a reader may name. Null is
   * *none recorded*, which for a project whose PRs predate the record is not *no PRs* — a writer finds the highest
   * once and records it (ADR 0131 §1).
   */
  highestPr: number | null

  version: number
  lastSeq: bigint | null
}

/** A `ProjectRefused` as the reducer keeps it: the payload, and when it was recorded. */
export type RecordedRefusal = PayloadOf<'ProjectRefused'> & { seq: bigint; at: Date }

export const emptyProject: ProjectState = {
  project: null,
  owner: null,
  base: null,
  configHash: null,
  fromSha: null,
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  highestPr: null,
  version: 0,
  lastSeq: null,
}

export function reduceProjectEvent(state: ProjectState, event: Envelope): ProjectState {
  const at = { version: event.version, lastSeq: event.seq }

  switch (event.type) {
    /**
     * The stream's first event, and the whole of *pending* (#163).
     *
     * It records everything a `Recheck` needs and deliberately not
     * `configHash`: that field is what `isRegistered` reads, and it may only
     * arrive with a recipe that was actually read. So the reducer that follows
     * this event is a project the board can name, list and act on, and one
     * `loadProjects()` does not return.
     */
    case 'ProjectOnboardingStarted': {
      const d = event.data as PayloadOf<'ProjectOnboardingStarted'>
      const [owner, repo] = splitSlug(d.slug)
      return { ...state, ...at, project: repo, owner, base: d.base }
    }

    case 'ProjectConfigured': {
      const d = event.data as PayloadOf<'ProjectConfigured'>
      return {
        ...state,
        ...at,
        project: d.project,
        owner: d.owner ?? state.owner,
        base: d.base ?? state.base,
        configHash: d.configHash,
        fromSha: d.fromSha,
      }
    }

    case 'ProjectRefused': {
      const d = event.data as PayloadOf<'ProjectRefused'>
      return { ...state, ...at, refused: { ...d, seq: event.seq, at: event.at } }
    }

    case 'ProjectRecipeChanged': {
      const d = event.data as PayloadOf<'ProjectRecipeChanged'>
      return { ...state, ...at, recipe: { ...d, seq: event.seq, at: event.at } }
    }

    case 'ProjectSandboxObserved': {
      const d = event.data as PayloadOf<'ProjectSandboxObserved'>
      return { ...state, ...at, sandboxObserved: { ...d, seq: event.seq, at: event.at } }
    }

    case 'ProjectRecovered':
      return { ...state, ...at, refused: null }

    case 'ProjectPaused': {
      // A second pause changes nothing: the first `since` stands.
      if (state.paused !== null) return { ...state, ...at }
      const d = event.data as PayloadOf<'ProjectPaused'>
      return { ...state, ...at, paused: { by: d.by, seq: event.seq, at: event.at } }
    }

    case 'ProjectResumed':
      return { ...state, ...at, paused: null }

    case 'ProjectPrNumbered': {
      const d = event.data as PayloadOf<'ProjectPrNumbered'>
      return { ...state, ...at, highestPr: Math.max(state.highestPr ?? 0, d.n) }
    }

    default:
      // See the note in ticket.ts: ignored, not rejected.
      return { ...state, ...at }
  }
}

export function reduceProject(events: readonly Envelope[]): ProjectState {
  return events.reduce(reduceProjectEvent, emptyProject)
}

/**
 * `owner/repo` as two, keeping the repository name whatever precedes it.
 *
 * The stream is named for the repository (`prj-{repo}`), so the half after the
 * slash is the half that has to be right; a slug with no slash is a repository
 * name with no owner recorded, which is the state a project registered before
 * `ProjectConfigured` carried one is already in.
 */
function splitSlug(slug: string): [owner: string | null, repo: string] {
  const cut = slug.lastIndexOf('/')
  return cut === -1 ? [null, slug] : [slug.slice(0, cut), slug.slice(cut + 1)]
}

/** Whether this stream has ever been configured. */
export function isRegistered(state: ProjectState): boolean {
  return state.project !== null && state.configHash !== null
}

/**
 * Whether this repository is on its way in — recorded, and no recipe read yet.
 *
 * What it waits for is `Recheck` (#182), and not an installation: the wizard
 * writes the recipe on this machine and records the project only through the
 * App's installation on the repository, refusing without one. What can still
 * keep it here is what `lingtai add` checks — the installation's permissions,
 * the recipe, an installation removed since. The reducer cannot know which, and
 * does not have to — it only draws the line.
 *
 * The complement of `isRegistered` over the streams that exist, and it is that
 * rather than a flag on purpose (#163): the two are one line drawn once, so a
 * project cannot be both and cannot be neither. The daemon asks the first
 * question and the board asks both.
 */
export function isPending(state: ProjectState): boolean {
  return state.project !== null && state.configHash === null
}

/** What one pass saw of a project: refused, and why — or looked at and not refused. */
export type TurnObservation =
  | { refused: true; detail: string; ref: string | null; codeSha: string | null }
  | { refused: false; ref: string | null; codeSha: string | null }

/**
 * What a pass appends about a project, given what its stream already says.
 *
 * **The transition, never the state** (#148). A sweep runs on a loop, so the
 * question is not *is it refusing* — asked every few seconds that writes the
 * same row for ever — but *is this different from what is on record*. The
 * stream holds what is on record, so the answer needs no clock (0027) and no
 * memory in the process: a restarted daemon reads the same stream and reaches
 * the same answer.
 *
 * - not refused, and nothing on record: nothing;
 * - not refused, with a refusal on record: `ProjectRecovered`;
 * - refused, and the same as the refusal on record: nothing;
 * - refused otherwise: `ProjectRefused`.
 *
 * *The same* is the ref, the commit and the message, compared without its
 * digits (`refusalText`). The commit is compared because it is the fact the
 * event exists to carry: a restart into new code that still refuses the same
 * way says the recipe is broken, where the first said the process might be old.
 */
export function turnTransition(
  state: ProjectState,
  seen: TurnObservation,
): ToAppend<PayloadOf<'ProjectRefused'> | PayloadOf<'ProjectRecovered'>> | null {
  const project = state.project
  if (project === null) return null
  const last = state.refused

  if (!seen.refused) {
    if (last === null) return null
    return { type: 'ProjectRecovered', actor: 'conductor', data: { project, ref: seen.ref, codeSha: seen.codeSha } }
  }

  if (
    last !== null &&
    last.ref === seen.ref &&
    last.codeSha === seen.codeSha &&
    refusalText(last.detail) === refusalText(seen.detail)
  ) {
    return null
  }
  return {
    type: 'ProjectRefused',
    actor: 'conductor',
    data: { project, detail: seen.detail, ref: seen.ref, codeSha: seen.codeSha },
  }
}

/**
 * What to append when a recipe was read, given what the stream already holds.
 * Null when the hash on record is the one seen. Needs no registered project.
 * The envelope's actor is the person, or `conductor` for a file read.
 */
export function recipeChange(
  state: ProjectState,
  seen: PayloadOf<'ProjectRecipeChanged'>,
): ToAppend<PayloadOf<'ProjectRecipeChanged'>> | null {
  if (state.recipe?.sourceHash === seen.sourceHash) return null
  return {
    type: 'ProjectRecipeChanged',
    actor: seen.by === 'file' ? 'conductor' : seen.by,
    data: { sourceHash: seen.sourceHash, source: seen.source, by: seen.by },
  }
}

/** What to append when a run met a sandbox state; null when it is the kind on record. */
export function sandboxObservation(
  state: ProjectState,
  seen: PayloadOf<'ProjectSandboxObserved'>,
): ToAppend<PayloadOf<'ProjectSandboxObserved'>> | null {
  if (state.sandboxObserved?.kind === seen.kind) return null
  return {
    type: 'ProjectSandboxObserved',
    actor: 'conductor',
    data: { kind: seen.kind, runId: seen.runId },
  }
}

/**
 * A refusal's message for comparison only — the event keeps the text as caught.
 *
 * What changes from one request to the next is nearly always a number: GitHub's
 * request ID (`8C3A:1F2B:3D4E5F`), the address a name resolved to, the time a
 * rate limit resets (`2026-09-12T10:00:00Z`), a retry-after or a duration
 * (`42s`, `30012ms`). Compared verbatim, each would be a new refusal on every
 * sweep. So every run of word characters and the `-:.` between them that
 * contains a digit is one token — whatever letters the digits are attached to.
 */
export function refusalText(detail: string): string {
  return detail.replace(/[\w:.-]+/g, (m) => (/\d/.test(m) ? '#' : m))
}
