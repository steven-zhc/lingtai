/**
 * Reading a reset time out of prose — the one place
 * [0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) allows the
 * message to be read at all.
 *
 * The tests are shaped by §4's asymmetry rather than by coverage: **a parse
 * that misses costs efficiency and never correctness.** So a miss is asserted
 * to fall back rather than to throw or to guess, and the interesting cases are
 * the ones where a wrong answer would be indistinguishable from a right one —
 * a zone, midnight, a time that has already gone past today.
 *
 * Efficiency is not always a longer wait, though (#210): a miss waits longer
 * only while the true reset is sooner than the backoff. Behind a weekly wall it
 * resumes early and meets it again every hour, so the weekly wording is pinned
 * verbatim, and a miss is asserted to *say* it was a miss.
 *
 * Unit, under `--project unit`. Nothing here reads a clock it was not
 * handed, which is why every assertion can be about a specific instant.
 */
import { describe, expect, it } from "vitest";
import { parseResetAt, standDown } from "../src/never-started.ts";

/** What the log actually held, six times, on the night 0031 is about. */
const QUOTA = "You've hit your session limit · resets 11pm (America/Chicago)";

/**
 * The weekly limit's wording, verbatim as the runtime produced it at 12:35:13
 * Chicago time on 2026-09-17 (#210) — middle dot and all. A date between
 * `resets` and the time is the whole of what the session limit's form lacks.
 */
const WEEKLY = "You've hit your weekly limit · resets Sep 19 at 9am (America/Chicago)";
/** 12:35:13 in Chicago, when the weekly wall was first met. */
const WEEKLY_MET = new Date("2026-09-17T17:35:13Z");

/**
 * Codex's wording, verbatim from `run-1c087f2a`'s log at 22:23:12 Chicago
 * time on 2026-09-29 (#317) — URLs and all. The two URLs are the noise a
 * looser lead-in would trip on; the sentence names no zone, so the reading is
 * a guess, exactly as an unzoned `resets` sentence's is.
 */
const CODEX_USAGE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 30th, 2026 2:00 AM.";
/** 22:23:12 in Chicago on 2026-09-29, when the Codex wall was met. */
const CODEX_MET = new Date("2026-09-30T03:23:12Z");

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
   * The weekly limit (#210). `Sep 19 at 9am` in Chicago is `14:00Z` — forty-five
   * hours past the moment it was met, and read as `resets 9` it would have been
   * nothing at all.
   */
  it("reads the weekly limit's date, verbatim as the runtime writes it", () => {
    expect(parseResetAt(WEEKLY, WEEKLY_MET)?.toISOString()).toBe("2026-09-19T14:00:00.000Z");
  });

  /**
   * The neighbours, pinned because this is a regex and the risk is next door:
   * the session limit's own form, with minutes, must keep reading as a time of
   * day and never have its hour taken for a day of the month.
   */
  it("keeps reading the session limit's form beside the dated one", () => {
    const at = parseResetAt("You've hit your session limit · resets 4:20am (America/Chicago)", WEEKLY_MET);
    // 04:20 in Chicago has gone by at 12:35, so it is tomorrow's.
    expect(at?.toISOString()).toBe("2026-09-18T09:20:00.000Z");
    expect(parseResetAt(QUOTA, WEEKLY_MET)?.toISOString()).toBe("2026-09-18T04:00:00.000Z");
  });

  /**
   * A date names that day and no other. A bare time already gone by is
   * tomorrow's; a date already gone by is not next year's — it is a message
   * this cannot account for, and the week ceiling refuses the other reading.
   */
  it("does not roll a date that has gone by forward to the next one", () => {
    const after = new Date("2026-09-19T15:00:00Z");
    expect(parseResetAt(WEEKLY, after)).toBeNull();
  });

  /**
   * Codex's own wording (#317). `#210` taught this file Claude's `resets`;
   * the same night Codex said `try again at` instead, and the conductor
   * paused itself saying it named no reset time. The grammar after the
   * lead-in is unchanged — only the lead-in and the zone (Codex names none)
   * differ from the `resets`-led forms above.
   */
  it("reads Codex's `try again at`, in the zone it is handed", () => {
    expect(parseResetAt(CODEX_USAGE, CODEX_MET, "America/Chicago")?.toISOString()).toBe(
      "2026-09-30T07:00:00.000Z",
    );
  });

  it("reads a date across the turn of a year, and a year when one is written", () => {
    const now = new Date("2026-12-30T12:00:00Z");
    expect(parseResetAt("resets Jan 2 at 9am (UTC)", now)?.toISOString()).toBe("2027-01-02T09:00:00.000Z");
    expect(parseResetAt("resets January 2, 2027 at 9:15am (UTC)", now)?.toISOString()).toBe(
      "2027-01-02T09:15:00.000Z",
    );
    // A day the month does not have is not a date.
    expect(parseResetAt("resets Feb 30 at 9am (UTC)", new Date("2027-02-26T00:00:00Z"))).toBeNull();
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
   * **The pause is the same at both depths and the sentence is not** (0041 §3).
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
      what: { of: "step", step: "proposed:review" },
      now,
    });

    // The time is read the same way whichever depth met the wall.
    expect(until.toISOString()).toBe("2026-09-10T04:00:00.000Z");
    expect(reason).toContain("the proposed:review step's agent never started");
    expect(reason).toContain("nothing judged the diff");
    expect(reason).toContain("was paid for");
    expect(reason).not.toContain("nothing spent");
    expect(reason).not.toContain("no turns taken");
    // And still the account-wide half, which is the reason for pausing at all.
    expect(reason).toContain("Every queued item would meet the same thing");
    expect(reason).toContain("You've hit your session limit");
  });

  /** The weekly wall, stood down for until it lifts rather than for an hour (#210). */
  it("stands down until the weekly limit lifts", () => {
    const { until, reason } = standDown({
      detail: WEEKLY,
      backoffMs: 3_600_000,
      what: { of: "run" },
      now: WEEKLY_MET,
    });

    expect(until.toISOString()).toBe("2026-09-19T14:00:00.000Z");
    expect(reason).toContain("read from the message itself");
    expect(reason).toContain("You've hit your weekly limit");
  });

  /**
   * The night #317 is about: Codex named a reset and the conductor said it
   * named none, resuming 2h37m early. Reading it in the host's own zone
   * (nothing passed for `zone`) is what production does; `standDown`'s
   * fallback is `hostZone()`, so this only pins the sentence and the reason,
   * not the zone guess — that is `parseResetAt`'s own test above.
   */
  it("waits for Codex's named reset time rather than the recipe's backoff", () => {
    const { until, reason } = standDown({
      detail: CODEX_USAGE,
      backoffMs: 3_600_000,
      what: { of: "step", step: "review:review" },
      now: CODEX_MET,
      zone: "America/Chicago",
    });

    expect(until.toISOString()).toBe("2026-09-30T07:00:00.000Z");
    expect(reason).toContain("read from the message itself");
    expect(reason).not.toContain("it named no reset time");
    expect(reason).toContain("try again at Sep 30th, 2026 2:00 AM");
  });

  /**
   * **A reset that was named and not read is said as such** (#210). The chip
   * used to say *it named no reset time* in the same sentence that quoted the
   * time it named, which sent a reader away from the one string that answered
   * the question. Each of these named something; none of them named nothing.
   */
  it("says a reset was named and could not be read, distinctly from one never named", () => {
    for (const [detail, at] of [
      [WEEKLY, new Date("2026-09-19T15:00:00Z")],
      // Codex's date already gone by, same as WEEKLY above — named, refused,
      // never read as nothing. No zone is passed here (production passes
      // none either), so the instant is a day past the named date in every
      // zone `hostZone()` could name, not just the one the incident was in.
      [CODEX_USAGE, new Date("2026-10-01T00:00:00Z")],
      ["resets 25pm", now],
      ["resets 11:74pm", now],
      ["resets 11pm (Nowhere/Nothing)", now],
      ['resets_at":"2027-01-01T00:00:00Z', now],
      // Codex's wall (`packages/agent/unit/codex.test.ts`). A relative duration
      // is not read here, but it is not *no* time either.
      ["You have hit your usage limit. Try again in 3 hours.", now],
    ] as const) {
      const { until, reason } = standDown({ detail, backoffMs: 3_600_000, what: { of: "run" }, now: at });
      expect(until.getTime(), detail).toBe(at.getTime() + 3_600_000);
      expect(reason, detail).toContain("named a reset time");
      expect(reason, detail).toContain("could not read");
      expect(reason, detail).toContain("a bug in parseResetAt");
      expect(reason, detail).not.toContain("it named no reset time");
    }

    // And the fragment is quoted, so the reader is pointed at it.
    const { reason } = standDown({
      detail: WEEKLY,
      backoffMs: 3_600_000,
      what: { of: "run" },
      now: new Date("2026-09-19T15:00:00Z"),
    });
    expect(reason).toContain("(`resets Sep 19 at 9am (America/Chicago)`)");
  });

  /** And a message that named nothing still says so, and nothing more. */
  it("still says no reset was named when none was", () => {
    const { reason } = standDown({
      detail: "Not logged in · Please run /login",
      backoffMs: 3_600_000,
      what: { of: "run" },
      now,
    });
    expect(reason).toContain("it named no reset time, so this is the recipe's backoff");
    expect(reason).not.toContain("could not read");
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
