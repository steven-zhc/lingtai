/**
 * Read-time schema evolution.
 *
 * Every event carries `schemaVer` from the first row on purpose — the cost of
 * adding it later comes due exactly when there is a year of history worth
 * replaying (doc/decisions-archive/0001-event-sourcing.md). This is the other half:
 * the thing that reads it.
 *
 * The rule the catalogue states is *bump `SCHEMA_VER` for a type and add an
 * upcaster rather than changing a payload in place*. An upcaster takes one
 * version to the next, and a chain of them takes any stored payload up to what
 * this build understands. A missing step throws — the alternative is handing a
 * v2 payload to a v1 schema, which either fails a validation that names the
 * wrong problem or, worse, passes.
 *
 * It was here before it was needed, on purpose: the first upcaster is written
 * under time pressure against real history, which is the worst moment to also be
 * designing the mechanism.
 */
import { type EventType, type PayloadOf, SCHEMA_VER, parsePayload } from "./events.ts";

/** Takes a payload at version *n* and returns it at version *n + 1*. */
export type Upcaster = (data: unknown) => unknown;

/** `type → fromVersion → upcaster`. Steps must be contiguous. */
export type UpcastRegistry = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * **The nine steps that were here are gone, and the reset is what spent them**
 * (`#247`). One upcaster, `pointRenamed`, moved ADR 0018's `diff` point to
 * `proposed` on the nine types that carried a point when that landed, and
 * `#227` could not delete it: `StepPassed` sat at `schemaVer: 3` with
 * `findings` above the rename, and the invariant this file opens by naming —
 * *an unbroken chain of steps for every type past version 1* — makes a hole at
 * 1 as loud as a missing upcaster.
 *
 * What removed it was not a better argument but an empty store. 0061 §7 spends
 * that history by resetting the log rather than migrating it; `the-pipeline`'s
 * T5b folded the old one into
 * [013](../../../doc/experiments/013-the-log-before-the-third-reset.md) and T5
 * cut it. A log with no rows holds none at version 1, so the nine versions in
 * `SCHEMA_VER` and the nine steps beneath them came down in one commit rather
 * than one type at a time — which is the shape that was never available while
 * a single `schemaVer: 1` row stood.
 *
 * `StepsResolved` lost all three of its steps for the same reason and one
 * more: the two that were not the rename are written in the payload's old
 * spelling — `points` of `gate` — which `#247` renamed to `steps` of `step`.
 * Rewriting them in the new words would have been the log claiming a history
 * in language that history never used.
 */

/**
 * Add a step here in the same commit that bumps that type's `SCHEMA_VER`, never
 * separately.
 */
export const UPCASTERS: UpcastRegistry = {
  ProjectConfigured: {
    /**
     * 1 → 2: `owner` was added because the repository name alone was not enough
     * to reach GitHub again. A v1 event did not record one, and null says that
     * rather than guessing — every other field is untouched.
     */
    1: (data) => ({ ...(data as object), owner: null }),
    /**
     * 2 → 3: `base` was added because falling back to the repository's default
     * branch is only correct by convention, and `nextloom-ai-admin`'s default
     * was a feature branch. A v2 event did not record one; null means "ask
     * GitHub", which is exactly what those runs did.
     */
    2: (data) => ({ ...(data as object), base: null }),
  },
  Reconciled: {
    /**
     * 1 → 2: each finding gained `action`. Nothing had appended one of these
     * when the field was added, so this step exists for the rule rather than
     * for any event — `reported` is the honest reading of a v1 finding, which
     * recorded that something diverged and not what became of it.
     */
    1: (data) => ({
      findings: ((data as { findings?: object[] }).findings ?? []).map((f) => ({
        ...f,
        action: "reported",
      })),
    }),
  },
  WorkItemClaimed: {
    /**
     * 1 → 2: `title` and `kind` were added when the queue left the log (0012).
     * A v1 claim recorded neither, and null says so — the upcaster is handed a
     * payload and not a stream id, so it could not recover them even in
     * principle. The projection falls back to the issue number.
     */
    1: (data) => ({ ...(data as object), title: null, kind: null }),
    /**
     * 2 → 3: `leaseUntilMs` is dropped
     * ([0027](../../../doc/decisions-archive/0027-the-lease-is-deleted.md)). The first
     * of the two steps here that remove a field rather than add one — the other
     * is `StepDidNotFinish` 1 → 2 below (`#234`) — and the direction is why it
     * is an upcaster at all: the log holds thousands of these timestamps and
     * **no event is rewritten**, so the reader is what has to stop believing
     * them. There is nothing to recover and nothing to guess —
     * exclusion is the unique constraint and liveness is the conductor's
     * advisory lock, and neither was ever read off this number.
     */
    2: (data) => {
      const { leaseUntilMs: _dropped, ...rest } = data as { leaseUntilMs?: unknown };
      return rest;
    },
  },
  WorkItemBlocked: {
    /**
     * 1 → 2: `needs` and `diagnosis` were added, because the whole vocabulary a
     * block had was a question (#83) — so a `human:` gate asking for a decision
     * and a conflict nobody had looked at were the same event with a different
     * string on it.
     *
     * Both are null, and the first one is the interesting null. Every block on
     * the log is *either* a judgement or an acknowledgement, and this upcaster
     * is handed a payload rather than a stream — it cannot tell which, and the
     * question's own wording is not evidence: `held at the merge step: …` and
     * `conflict: …` are conventions of the three call sites, not a field. Null
     * says the event did not record it, which is true; a regex over the question
     * would say something stronger and sometimes wrong.
     */
    1: (data) => ({ ...(data as object), needs: null, diagnosis: null }),
  },
  RunStarted: {
    /**
     * 1 → 2: `invocation` was added because the log said *which* runtime and
     * nothing about *how* it was called (#88). A v1 event recorded no argv, no
     * tier and no limits, and null says so — the argv could not be
     * reconstructed from the payload even in principle, and a plausible
     * reconstruction of the one field that answers "what command did we run"
     * would be worse than the gap.
     */
    1: (data) => ({ ...(data as object), invocation: null }),
  },
  RunPrompted: {
    /**
     * 1 → 2: the prompt text was added (#88). A v1 event recorded its length
     * and nothing else, and the document is gone — the ticket body it was
     * filled from lives on GitHub and can have been edited since. Null is the
     * only honest reading; `bytes` is untouched and still answers what it
     * always answered.
     */
    1: (data) => ({ ...(data as object), prompt: null }),
  },
  PromptEdited: {
    /**
     * 1 → 2: `hash` and `basedOn` were added when the board grew the box that
     * writes these (#104). Both null, and neither is guessable from the payload:
     * the digest could be recomputed from `text`, but recomputing it and
     * recording it are different claims — one says *this is what that text
     * hashes to now*, the other says *this is the number the writer put on the
     * log* — and only the second is what the field is for.
     *
     * Written for the rule rather than for any row, like `Reconciled`'s: the
     * type is one commit old and nothing has appended a v1 one.
     */
    1: (data) => ({ ...(data as object), hash: null, basedOn: null }),
  },
  FixRequested: {
    /**
     * 1 → 2: `of` was added — the `rounds` ceiling the round is counted against
     * — because a projection may not read a recipe and a card showing *round 2*
     * with no denominator cannot say which arm an item is on (`#146`).
     *
     * Zero, meaning *not recorded*, and it is not guessable: the ceiling is the
     * recipe's at the moment of that round, the recipe is read from the base
     * branch every pass (0005), and the value it had in September is not the
     * value it has now. Reading today's number back onto a v1 event would be
     * the log claiming a bound nobody applied.
     */
    1: (data) => ({ ...(data as object), of: 0 }),
  },
  StepPassed: {
    /**
     * 1 → 2: `findings` was added (#135). An empty array, and unlike the nulls
     * above it is not a guess: a v1 pass's findings exist only as prose inside
     * `evidence`, which is untouched, and parsing that string back into
     * structure would be the log claiming a severity and a line nobody recorded
     * as such. Empty says *none recorded here*; the prose still says the rest.
     */
    1: (data) => ({ ...(data as object), findings: [] }),
  },
  StepDidNotFinish: {
    /**
     * 1 → 2: `attempt` and `retrying` are dropped with 0057 §4's retry (`#234`).
     * The second step in this file that removes a field rather than adding one,
     * and it is a step for `WorkItemClaimed`'s `leaseUntilMs` reason: no event is
     * rewritten, so the reader is what stops believing them. There is nothing to
     * recover — the retry those two numbers described reused the crashed
     * attempt's session id and so ran nothing, which is why it is gone.
     *
     * This type is younger than 0018's rename, so 1 is the shape that carried
     * the two fields and never the one that said `diff`.
     */
    1: (data) => {
      const { attempt: _n, retrying: _more, ...rest } = data as { attempt?: unknown; retrying?: unknown };
      return rest;
    },
  },
};

export class MissingUpcasterError extends Error {
  override readonly name = "MissingUpcasterError";
  readonly type: EventType;
  readonly stored: number;
  readonly supported: number;

  constructor(type: EventType, stored: number, supported: number) {
    super(
      stored > supported
        ? `${type} is stored at schemaVer ${stored} but this build reads ${supported} — ` +
            "the writer is newer than the reader"
        : `${type} needs an upcaster from schemaVer ${stored} to reach ${supported}`,
    );
    this.type = type;
    this.stored = stored;
    this.supported = supported;
  }
}

/**
 * Walks a stored payload up to the version this build understands.
 *
 * A payload *ahead* of this build is not upcastable and never will be — there is
 * no downcasting, and guessing is how history gets misread. It throws.
 */
export function upcast(
  type: EventType,
  schemaVer: number,
  data: unknown,
  registry: UpcastRegistry = UPCASTERS,
): unknown {
  const supported = SCHEMA_VER[type];
  if (schemaVer === supported) return data;
  if (schemaVer > supported) throw new MissingUpcasterError(type, schemaVer, supported);

  let current = data;
  for (let from = schemaVer; from < supported; from++) {
    const step = registry[type]?.[from];
    if (!step) throw new MissingUpcasterError(type, schemaVer, supported);
    current = step(current);
  }
  return current;
}

/** Upcast, then validate. What a reader should call instead of `parsePayload`. */
export function parseStoredPayload<T extends EventType>(
  type: T,
  schemaVer: number,
  data: unknown,
  registry: UpcastRegistry = UPCASTERS,
): PayloadOf<T> {
  return parsePayload(type, upcast(type, schemaVer, data, registry));
}
