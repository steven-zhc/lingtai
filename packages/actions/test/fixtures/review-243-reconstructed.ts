/**
 * **A reconstruction of `#243`'s fourth review, `run-06145376`, 2026-09-30
 * 01:05:04 — not the real output** (`#318`).
 *
 * The real bytes are not on this machine. `~/.lingtai/runs/lingtai/` keeps a
 * run's log only while the item is still owed an explanation (0034); `#243`
 * landed long before this ticket was opened, and an agent here cannot read
 * production `events` to recover it from there either. What survives is the
 * ticket's own description of the shape: a `major` and two `minor`s, with the
 * third finding's `"failureScenario"` key followed by a full-width colon
 * (U+FF1A) instead of `:` — the only non-ASCII byte the real answer had, going
 * by hundreds of ordinary ASCII quotes around it.
 *
 * **This is that shape, reconstructed, not that transcript retyped.** A
 * retyped "real" fixture that quietly drifted from the bytes it claims to be
 * would be worse than this file saying plainly that it is not them — ticket
 * #318's own `Watch out`. `review-269-attempt-3.ts` is kept byte-for-byte
 * because that one *was* recovered from `StepFailed`'s evidence; this one
 * could not be, and the `Done when` box that wanted it byte-for-byte is left
 * unchecked for exactly that reason.
 *
 * It exists to pin two things together that the first fixture does not: the
 * full-width colon standing *where the real one belongs* is repaired, and a
 * full-width colon quoted *inside* a `claim` — the Chinese comment in the first
 * finding below — is copied through untouched, because `readTolerantJson`'s
 * string scanner never consults the repair table.
 */

const FULL_WIDTH_COLON = "：";

interface ReconstructedFinding {
  file: string;
  line: number;
  severity: "major" | "minor";
  claim: string;
  failureScenario: string;
}

/** `JSON.stringify`, with the key/value colon before `failureScenario` swapped for the full-width one, same as the real review's third finding. */
function asText(finding: ReconstructedFinding, breakColon: boolean): string {
  const whole = JSON.stringify(finding);
  if (!breakColon) return whole;
  return whole.replace('"failureScenario":', `"failureScenario"${FULL_WIDTH_COLON}`);
}

const MAJOR: ReconstructedFinding = {
  file: "packages/conductor/src/conduct.ts",
  line: 212,
  severity: "major",
  claim:
    "`askTheAgent` never checks a judge plugin's own `at` against the step the recipe resolved it for — the docblock's own note, `whyThatPair` 的分支：未实现, names the gap but nothing enforces it.",
  failureScenario:
    "An operator writes `judge: claude-code` at `build:` instead of `proposed:`. `conduct.ts` still calls `askTheAgent` because nothing checked the plugin's `at` against `build`, the agent is dispatched and spends a turn, and it answers a judgement for a step the plugin table says is refused there — silently, because `step-matrix.test.ts` never exercises this call path.",
};

const MINOR_DOC: ReconstructedFinding = {
  file: "doc/design/the-plugin-body.md",
  line: 58,
  severity: "minor",
  claim:
    "The *code, restart, paste* sequence is described for a judge plugin, but the doc never says what happens to a pass already between `build` and `review` when the daemon restarts mid-pass.",
  failureScenario:
    "A reader restarts the daemon mid-pass expecting a newly pasted judge plugin to apply to the run already in flight, and the doc has no sentence telling them it will not.",
};

const MINOR_ORDER: ReconstructedFinding = {
  file: "packages/conductor/src/judge.ts",
  line: 41,
  severity: "minor",
  claim:
    "`judgeDeclaredAt` returns the first entry whose `when:` matches, but two entries sharing one `when:` silently prefer declaration order, and nothing asserts that order is meaningful.",
  failureScenario:
    "An operator declares two `human:` actions at `proposed:` both with `when: red`, meaning the second as a fallback for the first. The first always answers; reordering the list silently changes which one runs, and nothing documents that the list is ordered rather than a set.",
};

export const REVIEW_WITH_FULL_WIDTH_COLON =
  '{"findings":[' +
  [asText(MAJOR, false), asText(MINOR_DOC, false), asText(MINOR_ORDER, true)].join(",") +
  "]}";
