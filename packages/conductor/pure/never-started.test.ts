/**
 * Reading a reset time out of prose — the one place
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) allows the
 * message to be read at all.
 *
 * The tests are shaped by §4's asymmetry rather than by coverage: **a parse
 * that misses costs efficiency and never correctness.** So a miss is asserted
 * to fall back rather than to throw or to guess, and the interesting cases are
 * the ones where a wrong answer would be indistinguishable from a right one —
 * a zone, midnight, a time that has already gone past today.
 *
 * Pure, under `vitest.pure.config.ts`. Nothing here reads a clock it was not
 * handed, which is why every assertion can be about a specific instant.
 */
import { describe, expect, it } from "vitest";
import { parseResetAt, standDown } from "../src/never-started.ts";

/** What the log actually held, six times, on the night 0031 is about. */
const QUOTA = "You've hit your session limit · resets 11pm (America/Chicago)";

describe("parseResetAt", () => {
  /**
   * The sentence itself. `11pm (America/Chicago)` on 9 September 2026 is
   * `04:00Z` the next morning — the zone is `-05:00` in September, and reading
   * the hour without it would have been five hours wrong.
   */
  it("reads a wall clock and the zone the sentence names", () => {
    // 2026-09-09 08:44 UTC — 03:44 in Chicago, which is when the first of the
    // six ran.
    const now = new Date("2026-09-09T08:44:14Z");
    expect(parseResetAt(QUOTA, now)?.toISOString()).toBe("2026-09-10T04:00:00.000Z");
  });

  /** Already gone past today means the next one, not the one this morning. */
  it("takes the next occurrence, not the one that has already been", () => {
    // 23:30 in Chicago is past 11pm, so the reset being described is tomorrow's.
    const now = new Date("2026-09-10T04:30:00Z");
    expect(parseResetAt(QUOTA, now)?.toISOString()).toBe("2026-09-11T04:00:00.000Z");
  });

  it("reads minutes, and `resets at`", () => {
    const now = new Date("2026-09-09T08:00:00Z");
    // 03:30 UTC has already gone by at 08:00, so the one being named is
    // tomorrow's.
    const at = parseResetAt("You've reached your limit — resets at 3:30am (UTC)", now);
    expect(at?.toISOString()).toBe("2026-09-10T03:30:00.000Z");
  });

  /** An unambiguous instant beats every reading of a wall clock, so it is first. */
  it("prefers an ISO instant when one is there", () => {
    const now = new Date("2026-09-09T08:44:14Z");
    const at = parseResetAt(
      '{"rate_limit_error":true,"resets_at":"2026-09-09T11:00:00Z"} resets 11pm (America/Chicago)',
      now,
    );
    expect(at?.toISOString()).toBe("2026-09-09T11:00:00.000Z");
  });

  /**
   * Every one of these is a fall-back to the recipe's backoff, and that is the
   * *designed* outcome rather than a gap. A quota message this build has never
   * seen must cost a longer wait and never a wrong decision.
   */
  it("says nothing rather than something, when there is nothing to read", () => {
    const now = new Date("2026-09-09T08:44:14Z");
    for (const said of [
      "You're out of usage credits",
      "Your org is out of usage · add funds to continue",
      "Not logged in · Please run /login",
      "resets 25pm",
      "resets 11:74pm",
      "resets 11pm (Nowhere/Nothing)",
      "",
    ]) {
      expect(parseResetAt(said, now), said).toBeNull();
    }
  });

  /**
   * A `seven_day` limit is the longest thing this can honestly be describing.
   * Past that the match is more likely a number that was never a time.
   */
  it("refuses a reset further out than a week", () => {
    const now = new Date("2026-09-09T08:44:14Z");
    expect(parseResetAt('resets_at":"2027-01-01T00:00:00Z', now)).toBeNull();
  });
});

describe("standDown", () => {
  const now = new Date("2026-09-09T08:44:14Z");

  it("waits for the time the message named", () => {
    const { until, reason } = standDown({ detail: QUOTA, backoffMs: 3_600_000, what: { of: "run" }, now });

    expect(until.toISOString()).toBe("2026-09-10T04:00:00.000Z");
    // The prose is on the chip, because the classification refused to read it
    // and this is the only place a person can find out what actually happened.
    expect(reason).toContain("You've hit your session limit");
    expect(reason).toContain("read from the message itself");
  });

  /**
   * The flat hour that outranked a fact the system had been handed — kept, as
   * the fallback it always should have been (0028).
   */
  it("falls back to the recipe's backoff, and says that is what it did", () => {
    const { until, reason } = standDown({
      detail: "You're out of usage credits",
      backoffMs: 3_600_000,
      what: { of: "run" },
      now,
    });

    expect(until.toISOString()).toBe("2026-09-09T09:44:14.000Z");
    expect(reason).toContain("the recipe's backoff");
    expect(reason).toContain("You're out of usage credits");
  });

  /**
   * **The pause is the same at both depths and the sentence is not** (0038 §3).
   *
   * A gate's agent that never started sits inside a run that *did* — the
   * implementer took turns and was paid, and produced the very diff the reviewer
   * was being asked about. 0031's opening is a claim about a run that spent
   * nothing, and this pause is what the board's chip and `lingtai doctor` show,
   * so writing it here would put `#133`'s false sentence one screen along from
   * the card it started on.
   */
  it("says which agent never started, and does not say a paid run spent nothing", () => {
    const { until, reason } = standDown({
      detail: QUOTA,
      backoffMs: 3_600_000,
      what: { of: "gate", gate: "proposed:review" },
      now,
    });

    // The time is read the same way whichever depth met the wall.
    expect(until.toISOString()).toBe("2026-09-10T04:00:00.000Z");
    expect(reason).toContain("the proposed:review gate's agent never started");
    expect(reason).toContain("nothing judged the diff");
    expect(reason).toContain("was paid for");
    expect(reason).not.toContain("nothing spent");
    expect(reason).not.toContain("no turns taken");
    // And still the account-wide half, which is the reason for pausing at all.
    expect(reason).toContain("Every queued item would meet the same thing");
    expect(reason).toContain("You've hit your session limit");
  });

  /** The run's own sentence, unchanged — 0031 §3 is not being restated. */
  it("keeps 0031's sentence for a run that never started", () => {
    const { reason } = standDown({
      detail: QUOTA,
      backoffMs: 3_600_000,
      what: { of: "run" },
      now,
    });

    expect(reason).toContain("a run ended without ever starting — no turns taken, nothing spent");
    expect(reason).toContain("The run said:");
  });
});
