/**
 * The Project aggregate: `prj-{project}`, alive as long as the project is
 * managed.
 *
 * It holds what is Lingtai's rather than the repository's: where to reach the
 * repository — owner and base branch — and the last **resolved configuration**,
 * which is the hash the recipe came out as and the commit it came from.
 *
 * The recipe itself is not here. It lives in the managed repository and is
 * re-read from `origin/<base>` for every run, because a snapshot of it would be
 * a second source of truth (doc/decisions/0005-config-in-target-repo.md). The
 * hash is kept instead: it says *whether the configuration changed* between two
 * runs, which is what a reader of the log needs, without pretending to be the
 * configuration.
 */
import type { Envelope, ToAppend } from "./envelope.ts";
import type { PayloadOf, Tier } from "./events.ts";

export interface ProjectState {
  /** Null until the first event; a stream can be read before it exists. */
  project: string | null;
  /**
   * The GitHub owner. Null for a project registered before `ProjectConfigured`
   * carried one — re-run `lingtai add` to record it.
   */
  owner: string | null;
  /**
   * The branch this project's recipe is read from and merged into. Null for a
   * project registered before it was recorded — re-run `lingtai add` to record it.
   */
  base: string | null;

  /** The last resolved recipe hash, and the commit it was resolved from. */
  configHash: string | null;
  fromSha: string | null;

  /**
   * The refusal a conductor's pass last recorded, while nothing has recovered
   * from it (#148). Null is *not refusing*, whether nothing ever was or a
   * `ProjectRecovered` followed. The seq and time are the event's, so a reader
   * can say *since when* without the fold reading a clock (0027).
   */
  refused: RecordedRefusal | null;

  version: number;
  lastSeq: bigint | null;
}

/** A `ProjectRefused` as the fold keeps it: the payload, and when it was recorded. */
export type RecordedRefusal = PayloadOf<"ProjectRefused"> & { seq: bigint; at: Date };

export const emptyProject: ProjectState = {
  project: null,
  owner: null,
  base: null,
  configHash: null,
  fromSha: null,
  refused: null,
  version: 0,
  lastSeq: null,
};

export function applyProject(state: ProjectState, event: Envelope): ProjectState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {

    case "ProjectConfigured": {
      const d = event.data as PayloadOf<"ProjectConfigured">;
      return {
        ...state,
        ...at,
        project: d.project,
        owner: d.owner ?? state.owner,
        base: d.base ?? state.base,
        configHash: d.configHash,
        fromSha: d.fromSha,
      };
    }

    case "ProjectRefused": {
      const d = event.data as PayloadOf<"ProjectRefused">;
      return { ...state, ...at, refused: { ...d, seq: event.seq, at: event.at } };
    }

    case "ProjectRecovered":
      return { ...state, ...at, refused: null };

    default:
      // See the note in work-item.ts: ignored, not rejected.
      return { ...state, ...at };
  }
}

export function reduceProject(events: readonly Envelope[]): ProjectState {
  return events.reduce(applyProject, emptyProject);
}

/** Whether this stream has ever been configured. */
export function isRegistered(state: ProjectState): boolean {
  return state.project !== null && state.configHash !== null;
}

/** What one pass saw of a project: refused, and why — or looked at and not refused. */
export type PassObservation =
  | { refused: true; detail: string; ref: string | null; codeSha: string | null }
  | { refused: false; ref: string | null; codeSha: string | null };

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
export function passTransition(
  state: ProjectState,
  seen: PassObservation,
): ToAppend<PayloadOf<"ProjectRefused"> | PayloadOf<"ProjectRecovered">> | null {
  const project = state.project;
  if (project === null) return null;
  const last = state.refused;

  if (!seen.refused) {
    if (last === null) return null;
    return { type: "ProjectRecovered", actor: "conductor", data: { project, ref: seen.ref, codeSha: seen.codeSha } };
  }

  if (
    last !== null &&
    last.ref === seen.ref &&
    last.codeSha === seen.codeSha &&
    refusalText(last.detail) === refusalText(seen.detail)
  ) {
    return null;
  }
  return {
    type: "ProjectRefused",
    actor: "conductor",
    data: { project, detail: seen.detail, ref: seen.ref, codeSha: seen.codeSha },
  };
}

/**
 * A refusal's message for comparison only — the event keeps the text as caught.
 *
 * What changes from one request to the next is nearly always a number: GitHub's
 * request ID (`8C3A:1F2B:3D4E5F`), the address a name resolved to, the time a
 * rate limit resets. Compared verbatim, each would be a new refusal on every
 * sweep. So every whole word of hex characters and the `-:.` between them that
 * contains a digit is one token.
 */
export function refusalText(detail: string): string {
  return detail.replace(/\b[0-9a-f][0-9a-f:.-]*\b/gi, (m) => (/\d/.test(m) ? "#" : m));
}
