/**
 * The project fold's refusal, and what a pass appends from it (#148).
 *
 * A sweep runs on a loop, so what is worth pinning is what is **not** appended:
 * the same refusal seen again says nothing new. And what must not be needed is
 * a clock (0027) — every answer here comes from the stream alone.
 */
import { describe, expect, it } from "vitest";
import {
  type PassObservation,
  isPending,
  isRegistered,
  passTransition,
  reduceProject,
  refusalText,
} from "../src/project.ts";
import { makeStream } from "./support.ts";

const REFUSAL = 'lingtai: .lingtai/config.yaml on main is not valid:\n  env: Unrecognized key: "refuseHosts"';
const OLD = "cc6e856".padEnd(40, "0");
const NEW = "be9fd26".padEnd(40, "0");

/** A configured project, and a pass that appends what it decides and folds again. */
function project() {
  const event = makeStream("prj-lingtai");
  const events = [
    event("ProjectConfigured", { project: "lingtai", owner: "steven-zhc", base: "main", configHash: "h", fromSha: "s" }),
  ];
  const pass = (seen: PassObservation) => {
    const next = passTransition(reduceProject(events), seen);
    if (next) events.push(event(next.type as "ProjectRefused", next.data as never));
    return next?.type ?? null;
  };
  return { events, pass, types: () => events.map((e) => e.type) };
}

const refused = (codeSha = OLD, detail = REFUSAL): PassObservation => ({ refused: true, detail, ref: "main", codeSha });
const worked = (codeSha = NEW): PassObservation => ({ refused: false, ref: "main", codeSha });

describe("a pass's refusal, on the project stream", () => {
  it("is appended once, however many sweeps meet it", () => {
    const p = project();
    expect(p.pass(refused())).toBe("ProjectRefused");
    for (let i = 0; i < 20; i++) expect(p.pass(refused())).toBeNull();
    expect(p.types()).toEqual(["ProjectConfigured", "ProjectRefused"]);

    const state = reduceProject(p.events);
    expect(state.refused).toMatchObject({ project: "lingtai", detail: REFUSAL, ref: "main", codeSha: OLD });
    expect(state.refused?.seq).toBe(p.events[1]!.seq);
  });

  it("is recovered from once, and a refusal after the recovery is on the log again", () => {
    const p = project();
    p.pass(refused());
    expect(p.pass(worked())).toBe("ProjectRecovered");
    expect(p.pass(worked())).toBeNull();
    expect(reduceProject(p.events).refused).toBeNull();

    expect(p.pass(refused())).toBe("ProjectRefused");
    expect(p.types()).toEqual(["ProjectConfigured", "ProjectRefused", "ProjectRecovered", "ProjectRefused"]);
  });

  it("appends nothing for a project that was never refused and still is not", () => {
    const p = project();
    expect(p.pass(worked())).toBeNull();
    expect(p.types()).toEqual(["ProjectConfigured"]);
  });

  /**
   * The same text from a restarted process is a different fact: it says the
   * recipe is broken, where the first said the process might be old. Folding
   * them together erases the distinction the event carries its commit to make.
   */
  it("treats the same message from another commit, or another ref, as a new refusal", () => {
    const p = project();
    p.pass(refused(OLD));
    expect(p.pass(refused(NEW))).toBe("ProjectRefused");
    expect(p.pass({ ...refused(NEW), ref: "develop" } as PassObservation)).toBe("ProjectRefused");
    expect(p.pass(refused(NEW, "something else entirely"))).toBe("ProjectRefused");
    expect(reduceProject(p.events).refused?.detail).toBe("something else entirely");
  });

  /** GitHub's 403 names a new request ID on every call. */
  it("does not count what changes per request as a new refusal", () => {
    const p = project();
    for (let i = 0; i < 10; i++) {
      const id = crypto.randomUUID().toUpperCase();
      p.pass(refused(OLD, `API rate limit exceeded for installation ID ${4000 + i}. Request ID ${id} at 140.82.1.${i}:443`));
    }
    expect(p.types()).toEqual(["ProjectConfigured", "ProjectRefused"]);
    expect(refusalText(REFUSAL)).toBe(REFUSAL);
  });

  /** A reset time, a retry-after, a measured duration: digits with letters attached. */
  it("does not count a timestamp or a duration as a new refusal", () => {
    const p = project();
    for (let i = 0; i < 10; i++) {
      p.pass(
        refused(
          OLD,
          `rate limited, reset at 2026-09-12T1${i}:0${i}:00Z; retry after ${40 + i}s; timed out after ${30000 + i}ms`,
        ),
      );
    }
    expect(p.types()).toEqual(["ProjectConfigured", "ProjectRefused"]);
    expect(refusalText("reset at 2026-09-12T10:00:00Z")).toBe(refusalText("reset at 2026-09-12T11:30:00Z"));
    expect(refusalText("retry after 42s")).toBe(refusalText("retry after 7s"));
    expect(refusalText("timed out after 30012ms")).toBe(refusalText("timed out after 1ms"));
  });

  it("keeps the refusal across a reconfiguration, which says nothing about the pass", () => {
    const p = project();
    p.pass(refused());
    const event = makeStream("prj-lingtai");
    p.events.push({
      ...event("ProjectConfigured", { project: "lingtai", owner: "steven-zhc", base: "main", configHash: "h2", fromSha: "s2" }),
      version: p.events.length + 1,
    });
    expect(reduceProject(p.events).refused?.detail).toBe(REFUSAL);
  });
});

/**
 * Pending, which is one side of a line that was already drawn (#163).
 *
 * `isRegistered` reads `configHash`, and `configHash` only ever arrives with a
 * recipe that was read — so a repository the wizard has recorded and whose
 * recipe has not landed is *not registered* without anything new being asked.
 * What these pin is that the new event does not accidentally make it one, and
 * that the two questions never both answer yes.
 */
describe("a repository on its way in", () => {
  const started = () => {
    const event = makeStream("prj-esctest");
    const events = [
      event("ProjectOnboardingStarted", {
        slug: "steven-zhc/esctest",
        base: "develop",
        by: "human:steven",
      }),
    ];
    return { event, events };
  };

  it("is named, owned and pointed at a branch, and is not registered", () => {
    const state = reduceProject(started().events);

    expect(state.project).toBe("esctest");
    expect(state.owner).toBe("steven-zhc");
    expect(state.base).toBe("develop");
    // The one field that decides it, and the one the wizard cannot supply:
    // there is no recipe to hash yet.
    expect(state.configHash).toBeNull();
    expect(isRegistered(state)).toBe(false);
    expect(isPending(state)).toBe(true);
  });

  it("becomes live through ProjectConfigured, and stops being pending in the same fold", () => {
    const { event, events } = started();
    events.push(
      event("ProjectConfigured", {
        project: "esctest",
        owner: "steven-zhc",
        base: "develop",
        configHash: "h",
        fromSha: "s",
      }),
    );
    const state = reduceProject(events);

    expect(isRegistered(state)).toBe(true);
    expect(isPending(state)).toBe(false);
  });

  /** Nothing has been recorded at all: neither question says yes. */
  it("is neither, on a stream nothing has been appended to", () => {
    const state = reduceProject([]);
    expect(isRegistered(state)).toBe(false);
    expect(isPending(state)).toBe(false);
  });
});
