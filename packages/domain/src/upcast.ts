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
import { type EventType, type PayloadOf, SCHEMA_VER, parsePayload } from "./events.ts";

/** Takes a payload at version *n* and returns it at version *n + 1*. */
export type Upcaster = (data: unknown) => unknown;

/** `type → fromVersion → upcaster`. Steps must be contiguous. */
export type UpcastRegistry = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * **The step that is not here any more, and why its absence is not a hole.**
 *
 * `gatePointRenamed` moved ADR 0018's `diff` to `proposed` on the eight gate
 * and approval types, and it is deleted (#227). Its subject is gone: the
 * vocabulary those events name is `Step`, and
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §7 spends
 * this log rather than carrying it across the five-to-ten change — so there is
 * no stored row spelling a step `diff` for it to walk up. **Seven of those
 * eight went back to schemaVer 1 with it**, because a version that counts a
 * step this build does not have is a version nothing can be read at.
 *
 * `GatePassed` is the eighth and did **not**: its other step, `findings`
 * (`#135`), outlived the rename and moved down to key `1`, so that type keeps
 * one step and is at 2. A field added to it is `SCHEMA_VER` 3 and an upcaster
 * keyed `2` — keying a new one `1` would replace the `findings` fill rather
 * than follow it, and the chain would stay unbroken while every stored
 * `GatePassed` lost its `findings: []`.
 *
 * **Deleting one upcaster is not deleting the mechanism.** Everything below
 * stays, and it stays for the reason it was built before it was needed
 * ([0001](../../../doc/decisions/0001-event-sourcing.md)): the first upcaster
 * is written under time pressure against real history, which is the worst
 * moment to also be designing the machinery. A Lingtai whose log nobody may
 * reset will want this file exactly as it is.
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
     * 1 → 2: the nested one. The point called `diff` is called `proposed` (ADR
     * 0018), inside the `points` array rather than on a `gate` field, so it has
     * always been its own step rather than the shared one the other eight
     * carried.
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
  },
  GatePassed: {
    /**
     * 1 → 2: `findings` was added (#135). An empty array, and unlike the nulls
     * above it is not a guess: an earlier pass's findings exist only as prose
     * inside `evidence`, which is untouched, and parsing that string back into
     * structure would be the log claiming a severity and a line nobody recorded
     * as such. Empty says *none recorded here*; the prose still says the rest.
     *
     * It was keyed `2` while the rename above it was `1`. The rename is gone
     * and this is the only step left, so it is the first one — the key is the
     * version it walks *from*, and a gap there is what the chain test catches.
     */
    1: (data) => ({ ...(data as object), findings: [] }),
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
