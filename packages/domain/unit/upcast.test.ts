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
 * The rename that made this file earn its keep, and the one place it survives:
 * the `diff` point became `proposed` (ADR 0018).
 *
 * **The eight gate and approval types no longer have it.** `gatePointRenamed`
 * was one upcaster shared by all of them, and #227 deleted it along with the
 * five-name enum it moved a value inside of: `GatesResolved.points` went from
 * five entries to ten with no upcaster, because
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §7 resets
 * this log rather than carrying it — so there is no stored row spelling a step
 * `diff` for that step to walk up. The eight went back to schemaVer 1 with it,
 * and the chain invariant at the top of this file is what forced that.
 *
 * `GatesResolved` keeps its own, because it never shared one: the value it
 * moves is nested inside `points` rather than on a `gate` field. It is
 * exercised through `upcast` rather than `parseStoredPayload` below, which is
 * the whole of what the log being spent looks like from here — the steps still
 * run, and what they produce is a five-entry payload this build's schema no
 * longer accepts.
 */
describe("the gate point rename", () => {
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

  /** The chain, driven as `parseStoredPayload` drives it but without the parse. */
  function walk(stored: number, data: unknown): { gate: string; actions: string[] }[] {
    return (upcast("GatesResolved", stored, data) as { points: { gate: string; actions: string[] }[] })
      .points;
  }

  it("moves the point inside a v1 GatesResolved and keeps all five, in order", () => {
    const points = walk(1, v1);
    expect(points.map((p) => p.gate)).toEqual(["admit", "prepared", "proposed", "merge", "end"]);
    expect(points[2]!.actions).toEqual(["build", "review"]);
  });

  /**
   * #191, 0047 §3: the recipe was never recorded on a v1 or v2 event, and the
   * upcast does not pretend it was. Absent — not null, not `{}` — so a reader
   * can tell *not recorded* from *recorded, and empty*.
   */
  it("adds no recipe to a v1 or v2 GatesResolved, and absent is not empty", () => {
    for (const ver of [1, 2]) {
      const up = upcast("GatesResolved", ver, v1) as Record<string, unknown>;
      expect("recipe" in up, `v${ver}`).toBe(false);
      expect(up["recipe"]).toBeUndefined();
    }

    const ten = STEPS.map((gate) => ({ gate, actions: [] }));
    const current = { runId: "run-01JX", configHash: "abc", points: ten, recipe: {} };
    const empty = parseStoredPayload("GatesResolved", SCHEMA_VER.GatesResolved, current);
    expect("recipe" in empty).toBe(true);
    expect(empty.recipe).toEqual({});
  });

  /**
   * **The log is spent, and this is where that is said in code** (0061 §7).
   *
   * `points` asserts ten (0058 §5) and no upcaster pads a stored five to it, so
   * an event written before #227 is not stale — it does not parse. That is the
   * good version of this failure, and the same one ADR 0018's rename had: it
   * cannot pass wrongly.
   */
  it("refuses a GatesResolved that names five steps, at any version", () => {
    for (const ver of [1, 2, SCHEMA_VER.GatesResolved]) {
      expect(() => parseStoredPayload("GatesResolved", ver, v1), `v${ver}`).toThrow();
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

  it("walks a v1 GatePassed up with an empty findings array and its prose intact", () => {
    expect(parseStoredPayload("GatePassed", 1, v2)).toEqual({ ...v2, findings: [] });
  });

  it("leaves a current GatePassed and its findings alone", () => {
    const current = {
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
    expect(parseStoredPayload("GatePassed", SCHEMA_VER.GatePassed, current)).toEqual(current);
  });

  // 2 and not 3: the step below it was 0018's rename, which #227 deleted along
  // with the log it read. This one is the only step `GatePassed` has left.
  it("is at v2", () => {
    expect(SCHEMA_VER.GatePassed).toBe(2);
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
