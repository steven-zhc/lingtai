/**
 * Read-time schema evolution.
 *
 * Every event carries `schemaVer` from the first row on purpose — the cost of
 * adding it later comes due exactly when there is a year of history worth
 * replaying (doc/decisions/0001-event-sourcing.md). This is the other half:
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
import { STEPS, type EventType, type PayloadOf, SCHEMA_VER, parsePayload } from "./events.ts";

/** Takes a payload at version *n* and returns it at version *n + 1*. */
export type Upcaster = (data: unknown) => unknown;

/** `type → fromVersion → upcaster`. Steps must be contiguous. */
export type UpcastRegistry = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * 1 → 2 for the nine types that carried a gate point when ADR 0018 renamed it:
 * the point called `diff` is called `proposed`. (`GateNeverRan` and
 * `GateDidNotFinish` carry a `Step` too and are younger than the rename, so
 * nothing ever wrote one of those with the old name.)
 *
 * A pure rename, and the only one of these steps that could have been skipped
 * by leaving the old value in the enum. It was not, because the enum is what a
 * reader is shown: two spellings of one point would mean the board, `status`
 * and every recipe had to know both forever, and the run that wrote `diff`
 * would look like a different kind of run from the one that wrote `proposed`.
 *
 * It is written as a conditional rather than an unconditional overwrite so that
 * a v1 event from one of the other points is returned untouched — the
 * upcaster's job is to move the one value that moved, not to assert what the
 * rest were.
 *
 * **It goes when the log goes and not before, and `GatePassed` is why it
 * cannot go alone.** `#227` asked for this constant deleted while leaving the
 * mechanism, its tests and the other upcasters untouched. At eight of the nine
 * types that is a deletion; at `GatePassed` it is not. That type is at
 * `schemaVer: 3` — `1 → 2` is this rename, `2 → 3` adds `findings` (#135) —
 * and the invariant this file opens by naming, pinned by *has an unbroken
 * chain of steps for every type past version 1*, is that every version below
 * the current one has a step. Removing `1 → 2` leaves a hole at 1, and the
 * ways out are all worse than the constant: lowering the version deletes the
 * `findings` step, editing the invariant removes the guard that makes the
 * mechanism worth having, and a do-nothing step in its place is a lie about a
 * version that moved.
 *
 * The other half, which expires where that one does not: 0061 §7 spends this
 * history by *resetting* the log — `the-pipeline.md`'s T5, with T5b's fold of
 * it before that. Until those land the store holds `schemaVer: 1` rows this
 * walks, and deleting the step (or lowering the nine `SCHEMA_VER`s that depend
 * on it) makes every one of them throw.
 *
 * **So T5 is where this dies**, and it dies as one commit: a reset log holds no
 * row of any version, so the nine versions and every step beneath them come
 * down together rather than one type at a time.
 */
const gatePointRenamed: Upcaster = (data) => {
  const d = data as { gate?: string };
  return d.gate === "diff" ? { ...d, gate: "proposed" } : data;
};

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
     * ([0027](../../../doc/decisions/0027-the-lease-is-deleted.md)). The one
     * step here that removes a field rather than adding one, and the direction
     * is why it is an upcaster at all: the log holds thousands of these
     * timestamps and **no event is rewritten**, so the reader is what has to
     * stop believing them. There is nothing to recover and nothing to guess —
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
     * question's own wording is not evidence: `held at the merge gate: …` and
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
  GatesResolved: {
    /**
     * 1 → 2: the point called `diff` is called `proposed` (ADR 0018), and here
     * it is nested — this is the event the board reads to show an unconfigured
     * step as `skipped`, so a half-upcast would not throw; it would render a
     * run as having a step nobody has ever heard of.
     *
     * The list's *length* is untouched here, and deliberately: this step moves
     * the one value that moved. Widening a five-step plan to ten is the
     * `3 → 4` step below, which every stored row reaches whatever version it
     * was written at.
     */
    1: (data) => ({
      ...(data as object),
      points: ((data as { points?: { gate: string }[] }).points ?? []).map((p) =>
        p.gate === "diff" ? { ...p, gate: "proposed" } : p,
      ),
    }),
    /**
     * 2 → 3: `recipe` was added (0047) — and this step adds **nothing**. Not
     * null, not `{}`: absent, which is what a reader must already handle for a
     * run whose stream has no `GatesResolved` at all.
     *
     * `FixRequested`'s argument, with *recipe* for *number*: the recipe is read
     * from the base branch every pass (0005), the one it had then is not the one
     * it has now, and reading today's back onto a v2 event would be the log
     * claiming a configuration nobody ran. `configHash` is untouched and still
     * says which recipe it was; only the body was never recorded.
     */
    2: (data) => data,
    /**
     * 3 → 4: the plan names all ten steps, where it named the five the
     * vocabulary had (0058 §3).
     *
     * **The step the widening could not be done without.** 0061 §7 spends this
     * history by resetting the log, and that reset — `the-pipeline.md`'s T5 —
     * has not run, so every `GatesResolved` the store holds names five steps
     * and `.length(10)` refuses all of them. There is no quiet version of that
     * refusal: `decodeRow` rethrows the `ZodError` bare, so a projector stops
     * at the first such seq and never advances past it, and `reduceRun` dies
     * on any run that has one. `parsePayload` is reached through this chain by
     * every stored row whatever version it carries, which is why one step here
     * covers v1, v2 and v3 alike.
     *
     * **`[]` is a reading and not a guess**, which is the line every other step
     * in this file is drawn on. A run resolved before 2026-09-23 was given a
     * vocabulary with no `claim`, `design`, `implement`, `build` or `review` in
     * it — nothing could have been configured at one, so empty is what that
     * recipe said and not a shrug about what it might have said. It is the same
     * empty a run today gets at those five, so the board draws them `skipped`
     * and `landedWithoutSteps` cannot accuse them: its guard is an `actions`
     * list with something in it.
     *
     * Rebuilt from `STEPS` rather than appended to, so the order is the enum's
     * however the stored row was written, and a stored `gate` that is not a
     * step at all is dropped rather than carried into a payload the schema
     * would refuse for a second reason. `diff` is already `proposed` by the
     * time this runs — the `1 → 2` step above moved it, and this one is
     * downstream of it.
     */
    3: (data) => {
      const stored = (data as { points?: { gate?: string; actions?: string[] }[] }).points ?? [];
      const byStep = new Map(stored.map((p) => [p.gate, p.actions ?? []]));
      return {
        ...(data as object),
        points: STEPS.map((gate) => ({ gate, actions: byStep.get(gate) ?? [] })),
      };
    },
  },
  GateRequested: { 1: gatePointRenamed },
  GateStarted: { 1: gatePointRenamed },
  GatePassed: {
    1: gatePointRenamed,
    /**
     * 2 → 3: `findings` was added (#135). An empty array, and unlike the nulls
     * above it is not a guess: a v2 pass's findings exist only as prose inside
     * `evidence`, which is untouched, and parsing that string back into
     * structure would be the log claiming a severity and a line nobody recorded
     * as such. Empty says *none recorded here*; the prose still says the rest.
     */
    2: (data) => ({ ...(data as object), findings: [] }),
  },
  GateFailed: { 1: gatePointRenamed },
  GateWaived: { 1: gatePointRenamed },
  ApprovalRequested: { 1: gatePointRenamed },
  ApprovalGranted: { 1: gatePointRenamed },
  ApprovalRevoked: { 1: gatePointRenamed },
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
