/**
 * The upcasting hook.
 *
 * The invariant that matters is not "the registry is empty" — it was, until a
 * real field had to be added — but that **every type past version 1 has an
 * unbroken chain of steps from 1 up to its current version**. A bump without its
 * upcaster is the failure worth guarding: it makes every historical row of that
 * type unreadable, and it does so at the moment someone replays a year of them.
 */
import { describe, expect, it } from "vitest";
import {
  MissingUpcasterError,
  SCHEMA_VER,
  STEPS,
  UPCASTERS,
  type UpcastRegistry,
  parseStoredPayload,
  upcast,
} from "../src/index.ts";

describe("upcast", () => {
  it("is a no-op at the current version", () => {
    const data = { turn: 12 };
    expect(upcast("RunContextExhausted", 1, data)).toBe(data);
  });

  it("has an unbroken chain of steps for every type past version 1", () => {
    const bumped = (Object.keys(SCHEMA_VER) as (keyof typeof SCHEMA_VER)[]).filter(
      (type) => SCHEMA_VER[type] > 1,
    );

    for (const type of bumped) {
      for (let from = 1; from < SCHEMA_VER[type]; from++) {
        expect(
          UPCASTERS[type]?.[from],
          `${type} is at schemaVer ${SCHEMA_VER[type]} with no upcaster from ${from}`,
        ).toBeTypeOf("function");
      }
    }
  });

  it("has no upcaster for a type that never moved", () => {
    // A step for a type still at version 1 is dead code that will be trusted.
    for (const type of Object.keys(UPCASTERS) as (keyof typeof SCHEMA_VER)[]) {
      expect(SCHEMA_VER[type]).toBeGreaterThan(1);
    }
  });

  /**
   * The first real bump. `ProjectConfigured` v1 recorded the repository name but
   * not its owner, so `lingtai status` could not resolve a recipe for a project it
   * had itself registered.
   */
  it("walks a v1 ProjectConfigured all the way up, filling both fields with null", () => {
    const v1 = { project: "nextloom-ai-admin", configHash: "abc", fromSha: "def" };
    const upcasted = parseStoredPayload("ProjectConfigured", 1, v1);

    // Null, not a guess. A v1 event genuinely recorded neither.
    expect(upcasted).toEqual({ ...v1, owner: null, base: null });
  });

  it("adds only what a v2 ProjectConfigured is missing", () => {
    const v2 = { project: "p", owner: "steven-zhc", configHash: "abc", fromSha: "def" };
    expect(parseStoredPayload("ProjectConfigured", 2, v2)).toEqual({ ...v2, base: null });
  });

  it("leaves a v3 ProjectConfigured alone", () => {
    const v3 = { project: "p", owner: "steven-zhc", base: "develop", configHash: "a", fromSha: "d" };
    expect(parseStoredPayload("ProjectConfigured", 3, v3)).toEqual(v3);
  });

  it("refuses a payload written by a newer build", () => {
    // Not recoverable, ever: there is no downcasting, and guessing at a field
    // this build has never seen is how history gets misread.
    expect(() => upcast("RunContextExhausted", 2, {})).toThrow(MissingUpcasterError);
  });

  it("refuses a payload it has no step for", () => {
    expect(() => upcast("RunContextExhausted", 0, {})).toThrow(MissingUpcasterError);
  });

  describe("with a chain of steps", () => {
    // A hypothetical history for one event: v1 held `turn`, v2 renamed it to
    // `atTurn`, v3 added `reason`. This is the shape a real bump would take.
    const registry: UpcastRegistry = {
      RunContextExhausted: {
        1: (d) => ({ atTurn: (d as { turn: number }).turn }),
        2: (d) => ({ ...(d as object), reason: "compaction" }),
      },
    };
    const supported = 3;

    function upcastTo(stored: number, data: unknown): unknown {
      // `upcast` walks to `SCHEMA_VER[type]`, which is 1 here, so the chain is
      // driven directly to keep the shipped catalogue untouched.
      let current = data;
      for (let from = stored; from < supported; from++) {
        const step = registry.RunContextExhausted?.[from];
        if (!step) throw new MissingUpcasterError("RunContextExhausted", stored, supported);
        current = step(current);
      }
      return current;
    }

    it("walks a v1 payload all the way to v3", () => {
      expect(upcastTo(1, { turn: 41 })).toEqual({ atTurn: 41, reason: "compaction" });
    });

    it("starts mid-chain when the payload is already partway up", () => {
      expect(upcastTo(2, { atTurn: 41 })).toEqual({ atTurn: 41, reason: "compaction" });
    });

    it("throws by name when a step is missing", () => {
      const gappy: UpcastRegistry = { RunContextExhausted: { 2: registry.RunContextExhausted![2]! } };
      expect(() => {
        let current: unknown = { turn: 1 };
        for (let from = 1; from < supported; from++) {
          const step = gappy.RunContextExhausted?.[from];
          if (!step) throw new MissingUpcasterError("RunContextExhausted", 1, supported);
          current = step(current);
        }
      }).toThrow(/RunContextExhausted needs an upcaster from schemaVer 1/);
    });
  });
});

/**
 * The widening that made a run explainable (#88).
 *
 * Two types moved together for one reason: the log recorded *that* an agent was
 * given a prompt and *which* runtime took it, and neither the document nor the
 * command. Unlike the gate rename, a v1 payload here is not unparseable — it is
 * merely silent — so the step's whole job is to say `null` where a reader might
 * otherwise assume the field was empty.
 */
describe("the prompt and the invocation", () => {
  it("walks a v1 RunStarted up, with a null invocation", () => {
    const v1 = {
      workItemId: "wi-lingtai-59",
      runtime: "claude-code",
      model: "",
      promptVersion: "ticket@1911",
      baseSha: "base000",
      configHash: "cfg",
      worktree: "/tmp/wt",
    };
    // Null, not a reconstruction. The argv of a run that happened in August is
    // not recoverable from a payload that never held it, and a plausible guess
    // at "what command did we run" is worse than the gap.
    expect(parseStoredPayload("RunStarted", 1, v1)).toEqual({ ...v1, invocation: null });
  });

  it("walks a v1 RunPrompted up, keeping its length and admitting it has no text", () => {
    // #59's, verbatim: a template name and a byte count.
    const v1 = { promptVersion: "ticket@1911", bytes: 4593 };
    expect(parseStoredPayload("RunPrompted", 1, v1)).toEqual({ ...v1, prompt: null });
  });

  it("leaves a v2 of either alone", () => {
    const invocation = {
      command: "claude",
      args: ["-p", "<prompt: recorded as RunPrompted>"],
      tier: "guarded",
      limits: { turns: 150, wallMs: 3_600_000 },
    };
    const started = {
      workItemId: "wi-lingtai-88",
      runtime: "claude-code",
      model: "",
      promptVersion: "ticket@1932+a1b2c3d4",
      baseSha: "base000",
      configHash: "cfg",
      worktree: "/tmp/wt",
      invocation,
    };
    expect(parseStoredPayload("RunStarted", 2, started)).toEqual(started);

    const prompted = { promptVersion: "ticket@12", bytes: 12, prompt: "do the thing" };
    expect(parseStoredPayload("RunPrompted", 2, prompted)).toEqual(prompted);
  });
});

describe("parseStoredPayload", () => {
  it("validates after upcasting, so a bad step is caught by the schema", () => {
    expect(parseStoredPayload("RunContextExhausted", 1, { turn: 41 })).toEqual({ turn: 41 });
    expect(() => parseStoredPayload("RunContextExhausted", 1, { turn: "forty-one" })).toThrow();
  });
});

/**
 * The rename that made this file earn its keep: the `diff` point became
 * `proposed` (ADR 0018).
 *
 * Nine types carry a `Step`, and the enum no longer contains the old value —
 * so a stored row is not merely stale, it is unparseable without the step.
 * That is the good version of this failure and the reason the rename was
 * affordable: it cannot pass wrongly.
 *
 * **It outlives the vocabulary going to ten.**
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §7 spends
 * this history rather than upcasting it, and the thing that spends it is the
 * **reset** — `the-pipeline.md`'s T5, with T5b's fold before it, neither
 * landed. Until they are, the store holds `schemaVer: 1` rows of all nine, and
 * the step and the nine versions that depend on it stay. The tests below are
 * what fails if either comes down early.
 *
 * And at `GatePassed` it cannot come down at all while `2 → 3` stands: that
 * type is at 3, and *has an unbroken chain of steps for every type past
 * version 1* at the top of this file requires a step at 1. The argument in
 * full is on `gatePointRenamed` in `upcast.ts`.
 */
describe("the gate point rename", () => {
  const GATE_CARRYING = [
    "GateRequested",
    "GateStarted",
    "GatePassed",
    "GateFailed",
    "GateWaived",
    "ApprovalRequested",
    "ApprovalGranted",
    "ApprovalRevoked",
  ] as const;

  const base = { action: "build", runId: "run-01JX", onSha: "sha-a" };
  const extra: Record<(typeof GATE_CARRYING)[number], object> = {
    GateRequested: {},
    GateStarted: {},
    GatePassed: { evidence: "exit 0" },
    GateFailed: { evidence: "exit 1", findings: [] },
    GateWaived: { by: "human:steven", reason: "known flake" },
    ApprovalRequested: { question: "Merge?", artifacts: ["diff"] },
    ApprovalGranted: { by: "human:steven", note: "" },
    ApprovalRevoked: { by: "human:steven", reason: "force-push" },
  };

  /** What a later step adds on the way up; the rename touches nothing else. */
  const later: Partial<Record<(typeof GATE_CARRYING)[number], object>> = {
    GatePassed: { findings: [] },
  };

  it.each(GATE_CARRYING)("moves a v1 %s from diff to proposed", (type) => {
    const v1 = { ...base, ...extra[type], gate: "diff" };
    expect(parseStoredPayload(type, 1, v1)).toEqual({ ...v1, ...later[type], gate: "proposed" });
  });

  it.each(GATE_CARRYING)("leaves a v1 %s at another step alone", (type) => {
    const v1 = { ...base, ...extra[type], gate: "merge", action: "human" };
    expect(parseStoredPayload(type, 1, v1)).toEqual({ ...v1, ...later[type] });
  });

  /**
   * **The row today's log actually holds, and the one a lowered `SCHEMA_VER`
   * breaks.** Nothing on this log is below the current version of these nine
   * except by way of the rename, and everything at the current version has to
   * read back unchanged — so a build whose number is *under* what the writer
   * stamped takes `upcast`'s `schemaVer > supported` branch and throws
   * `the writer is newer than the reader` about a reader that was lowered.
   *
   * `toEqual` and not `not.toThrow`, which is the half the name promises and
   * the weaker assertion did not check: a step keyed at the current version —
   * or a `parsePayload` that drops a field on the way out — returns a mutated
   * payload without raising anything, and *unchanged* is the word this test
   * is here for. Its neighbours in this describe all compare.
   */
  it.each(GATE_CARRYING)("reads a %s stamped by this build back unchanged", (type) => {
    const current = { ...base, ...extra[type], ...later[type], gate: "proposed" };
    expect(parseStoredPayload(type, SCHEMA_VER[type], current)).toEqual(current);
  });

  /**
   * The nested one. `GatesResolved` is the event the board reads to show an
   * unconfigured step as `skipped`, so a half-upcast here would not throw — it
   * would render a run as having a step nobody has ever heard of.
   *
   * On the `1 → 2` step alone and not on `upcast`, because the chain's two
   * halves are separate facts: this step moves the point and keeps the list
   * the length it found it, and the `3 → 4` step below widens that list to
   * ten (the case after next). Walking the whole chain here would assert both
   * at once and hide which of them a regression broke.
   */
  it("moves the point inside a v1 GatesResolved and keeps every point, in order", () => {
    const v1 = {
      runId: "run-01JX",
      configHash: "abc",
      points: [
        { gate: "admit", actions: [] },
        { gate: "prepared", actions: ["install"] },
        { gate: "diff", actions: ["build", "review"] },
        { gate: "merge", actions: [] },
        { gate: "end", actions: ["close the ticket"] },
      ],
    };

    const up = UPCASTERS.GatesResolved![1]!(v1) as {
      points: { gate: string; actions: string[] }[];
    };
    expect(up.points.map((p) => p.gate)).toEqual(["admit", "prepared", "proposed", "merge", "end"]);
    expect(up.points[2]!.actions).toEqual(["build", "review"]);
  });

  /** All ten since 0058 §3; `.length(10)` is what the schema asserts. */
  const points = [
    "claim",
    "admit",
    "prepared",
    "design",
    "implement",
    "build",
    "review",
    "proposed",
    "merge",
    "end",
  ].map((gate) => ({ gate, actions: [] }));

  /**
   * #191, 0047 §3: the recipe was never recorded on a v1 or v2 event, and the
   * upcast does not pretend it was. Absent — not null, not `{}` — so a reader
   * can tell *not recorded* from *recorded, and empty*.
   */
  it("adds no recipe to a v1 or v2 GatesResolved, and absent is not empty", () => {
    const stored = { runId: "run-01JX", configHash: "abc", points };

    for (const ver of [1, 2]) {
      const up = parseStoredPayload("GatesResolved", ver, stored);
      expect("recipe" in up, `v${ver}`).toBe(false);
      expect(up.recipe).toBeUndefined();
    }

    const empty = parseStoredPayload("GatesResolved", SCHEMA_VER.GatesResolved, {
      ...stored,
      recipe: {},
    });
    expect("recipe" in empty).toBe(true);
    expect(empty.recipe).toEqual({});
  });

  /**
   * **The row this log is actually full of, at every version it holds one at.**
   *
   * Every `GatesResolved` appended before 2026-09-23 names the five steps the
   * vocabulary had, and the schema asserts ten. Without the `3 → 4` step the
   * `.length(10)` refuses all of them on read, and nothing catches it kindly:
   * `decodeRow` rethrows the `ZodError` bare, so the `task_view` and
   * `finding_backlog` projectors stop at the first such seq and never advance
   * past it — a rebuild included — and `reduceRun` dies on any pre-existing
   * run, which is `lingtai approve` and every task page.
   *
   * Parameterised over 1, 2 and 3 because a stored row is at any of them and
   * they all reach `parsePayload` through this one chain.
   */
  it.each([1, 2, 3])("widens a v%i five-step plan to all ten, keeping what it named", (ver) => {
    const stored = {
      runId: "run-01JX",
      configHash: "abc",
      points: [
        { gate: "admit", actions: [] },
        { gate: "prepared", actions: ["install"] },
        // The spelling that version actually wrote: `diff` until 0018.
        { gate: ver === 1 ? "diff" : "proposed", actions: ["build", "review"] },
        { gate: "merge", actions: [] },
        { gate: "end", actions: ["close the ticket"] },
      ],
    };

    const up = parseStoredPayload("GatesResolved", ver, stored);

    expect(up.points.map((p) => p.gate)).toEqual([...STEPS]);
    // What that run was given is untouched, and in the enum's order.
    expect(up.points.find((p) => p.gate === "prepared")?.actions).toEqual(["install"]);
    expect(up.points.find((p) => p.gate === "proposed")?.actions).toEqual(["build", "review"]);
    expect(up.points.find((p) => p.gate === "end")?.actions).toEqual(["close the ticket"]);
    // And the five the vocabulary did not have are empty, which is what that
    // recipe said about them: there was nothing there to configure.
    for (const step of ["claim", "design", "implement", "build", "review"] as const) {
      expect(up.points.find((p) => p.gate === step)?.actions, step).toEqual([]);
    }
  });

  /**
   * The count is the assertion 0047 rests on — *what a run was given is on the
   * log* — so a payload **stamped by this build** that records five steps or
   * eleven is refused rather than read as a run that was configured
   * differently. A *stored* five is not that payload: it is the case above,
   * and the step from 3 is what keeps the two apart.
   */
  it("refuses a plan that is not all ten steps", () => {
    const short = { runId: "run-01JX", configHash: "abc", points: points.slice(0, 5) };
    expect(() => parseStoredPayload("GatesResolved", SCHEMA_VER.GatesResolved, short)).toThrow();
  });

  it("moved all nine past v1, and none of them is still there", () => {
    for (const type of [...GATE_CARRYING, "GatesResolved"] as const) {
      expect(SCHEMA_VER[type], `${type} carries a Step and must be past v1`).toBeGreaterThanOrEqual(2);
      expect(
        UPCASTERS[type]?.[1],
        `${type} is past v1 with no step from 1 — the log's rows are at 1`,
      ).toBeTypeOf("function");
    }
  });
});

/**
 * A pass that carries its findings (#135).
 *
 * A `minor` does not refuse, so before this step a review's third tier was
 * recorded only as prose inside `evidence`. The step adds an empty array rather
 * than parsing that prose back: `evidence` is untouched and still says what it
 * said, and a severity read out of a string is a claim nobody recorded.
 */
describe("a pass with findings", () => {
  const v2 = {
    gate: "proposed",
    action: "review",
    runId: "run-01JX",
    onSha: "sha-a",
    evidence: "minor packages/actions/src/command.ts:313 — readResult treats every readFile failure as empty",
  };

  it("walks a v2 GatePassed up with an empty findings array and its prose intact", () => {
    expect(parseStoredPayload("GatePassed", 2, v2)).toEqual({ ...v2, findings: [] });
  });

  it("leaves a v3 GatePassed and its findings alone", () => {
    const v3 = {
      ...v2,
      findings: [
        {
          file: "packages/actions/src/command.ts",
          line: 313,
          claim: "readResult treats every readFile failure as empty",
          failureScenario: "a result file that exists but is unreadable is read as no result",
          severity: "minor",
        },
      ],
    };
    expect(parseStoredPayload("GatePassed", 3, v3)).toEqual(v3);
  });

  it("is at v3", () => {
    expect(SCHEMA_VER.GatePassed).toBe(3);
  });
});

/**
 * The step that removes a field ([0027](../../../doc/decisions/0027-the-lease-is-deleted.md)).
 *
 * Every other chain adds one and says `null` where history is silent. This one
 * goes the other way, and the reason it is a step rather than nothing at all is
 * that the log holds thousands of `leaseUntilMs` timestamps and **no event is
 * rewritten**. The reader is what stops believing them, and the tests here are
 * the ones a replay of that history depends on.
 */
describe("the lease, dropped on read", () => {
  const v1 = { runId: "run-1978cb64", worker: "local:71410" };

  it("walks a v1 claim all the way up: title and kind null, no lease", () => {
    expect(parseStoredPayload("WorkItemClaimed", 1, { ...v1, leaseUntilMs: 1_788_385_279_411 })).toEqual({
      ...v1,
      title: null,
      kind: null,
    });
  });

  it("drops the lease from a v2 claim and touches nothing else", () => {
    const v2 = { ...v1, leaseUntilMs: 1_788_385_279_411, title: "a ticket", kind: "bug" };
    expect(parseStoredPayload("WorkItemClaimed", 2, v2)).toEqual({
      ...v1,
      title: "a ticket",
      kind: "bug",
    });
  });

  it("reads a v2 claim that never had one, because a missing field is not an error", () => {
    // Nothing wrote such a row. The step is a delete, so it has to be a no-op
    // on a payload that does not carry the key rather than throwing on one.
    const v2 = { ...v1, title: null, kind: null };
    expect(parseStoredPayload("WorkItemClaimed", 2, v2)).toEqual(v2);
  });

  it("leaves a v3 claim alone", () => {
    const v3 = { ...v1, title: "a ticket", kind: "bug" };
    expect(parseStoredPayload("WorkItemClaimed", 3, v3)).toEqual(v3);
  });

  /** `worker` stays: it is what recovery is decided on now, not decoration. */
  it("keeps the worker, which is the field the lease's job moved to", () => {
    const up = parseStoredPayload("WorkItemClaimed", 2, {
      ...v1,
      leaseUntilMs: 1,
      title: null,
      kind: null,
    });
    expect(up.worker).toBe("local:71410");
  });
});

/**
 * The second step that removes a field, and the log it has to keep readable
 * (`#234`, [0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §4).
 *
 * `attempt` and `retrying` described a retry that never once ran: it recomputed
 * the crashed attempt's session id, so `claude` refused it in zero seconds
 * having reviewed nothing, and the second event then said the action did not
 * finish *twice* about a pass in which it was tried once. The retry is deleted
 * and the two fields with it — but the rows saying `attempt: 2, retrying: false`
 * are on the log and are not rewritten, so this step is what stops the reader
 * believing them.
 */
describe("the retry's two fields, dropped on read", () => {
  const stored = {
    gate: "proposed" as const,
    action: "review",
    runId: "run-f8dc341e",
    onSha: "b198b57",
    detail: "the reviewer did not finish (crash): Error: Session ID b99f35a0 is already in use.",
  };

  it("drops both fields from a v1 event and touches nothing else", () => {
    const v1 = { ...stored, attempt: 2, retrying: false };
    expect(parseStoredPayload("GateDidNotFinish", 1, v1)).toEqual(stored);
  });

  it("leaves a v2 event alone", () => {
    expect(parseStoredPayload("GateDidNotFinish", 2, stored)).toEqual(stored);
  });

  it("is at v2, which is the drop and not 0018's rename", () => {
    expect(SCHEMA_VER.GateDidNotFinish).toBe(2);
    // Nothing ever wrote one of these with the `diff` point — the type is
    // younger than that rename — so a v1 `gate` is already `proposed` and the
    // step must not be the renamer.
    expect(UPCASTERS.GateDidNotFinish?.[1]?.({ ...stored, gate: "proposed", attempt: 1 })).toEqual(stored);
  });
});

/**
 * The block that carried only a question (#83).
 *
 * Every `WorkItemBlocked` on the log at the time the field was added is a v1:
 * `{ question, needsFrom, runId }`, and the whole claim of the widening is that
 * those keep parsing. The upcaster is what makes that true, and this is the test
 * that would fail if `SCHEMA_VER` moved without it — which is the failure mode
 * the mechanism exists to prevent, since a v1 payload handed to a v2 schema
 * either fails naming the wrong problem or passes wrongly.
 */
describe("a block, widened past the question", () => {
  const v1 = {
    question: "conflict: agent/112 does not merge into develop: user-lookup-panel.tsx",
    needsFrom: "human" as const,
    runId: "run-1978cb64",
  };

  it("reads a v1 block, with no kind and no diagnosis", () => {
    expect(parseStoredPayload("WorkItemBlocked", 1, v1)).toEqual({
      ...v1,
      // Null, not a guess. The upcaster is handed a payload rather than a
      // stream, and the question's wording is a convention of the call sites
      // and not a field — `held at the …` and `conflict: …` are not evidence.
      needs: null,
      diagnosis: null,
    });
  });

  it("leaves a v2 block alone, diagnosis and all", () => {
    const v2 = {
      ...v1,
      needs: "acknowledgement" as const,
      diagnosis: {
        what: "agent/112 does not merge into develop.",
        done: "develop was merged in first and it still would not merge. No agent was bought: …",
        raw: "CONFLICT (content): Merge conflict in apps/web/src/components/users/user-lookup-panel.tsx",
        recommendation: { action: "requeue" as const, why: "the next attempt is cut from a base that has moved" },
      },
    };
    expect(parseStoredPayload("WorkItemBlocked", 2, v2)).toEqual(v2);
  });
});
