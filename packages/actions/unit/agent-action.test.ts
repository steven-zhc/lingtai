/**
 * The agent action.
 *
 * Everything here is about the three properties experiment 001 said the action
 * lives or dies by: the reviewer is cold, a finding without a failure scenario
 * is not a finding, and severity is not the reviewer's to soften.
 */
import type { RunOutcome, RunRequest, Runtime } from "@lingtai/agent";
import { sessionIdFor } from "@lingtai/agent";
import { describe, expect, it } from "vitest";
import { REFUSED_ABOUT, REVIEW_ANSWER_JSON_SCHEMA, SEVERITIES, parsePayload } from "@lingtai/domain";
import {
  buildDesignPrompt,
  buildReviewPrompt,
  createAgentAction,
  createDraftAction,
  parseDraft,
  parseFindings,
  verdictFor,
} from "../src/agent-action.ts";
import { NEEDS_INPUT, type Action, type ActionEvent, type ActionFinding, runActionPipeline } from "../src/action.ts";
import { REVIEW_THAT_DID_NOT_PARSE } from "../test/fixtures/review-269-attempt-3.ts";
import { REVIEW_WITH_FULL_WIDTH_COLON } from "../test/fixtures/review-243-reconstructed.ts";

const ISSUE = { ref: "58", title: "alias-aware skill merging", body: "merge skills by alias" };

/** The recipe's default, written here rather than imported: this file is about
 *  the action's behaviour at *a* bound, not about which bound the schema picks. */
const DIFF_BYTES = 400_000;

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 0,
  turns: 7,
  durationMs: 1234,
  costUsd: 0.42,
  text: null,
  failure: null,
  sessionId: "s",
  ...over,
});

/** Records what it was asked, so the test can assert on the prompt and the id. */
function reviewer(reply: RunOutcome): Runtime & { seen: RunRequest[] } {
  const seen: RunRequest[] = [];
  return {
    seen,
    capabilities: {
      id: "claude-code",
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      providesTier: "guarded",
      enforces: ["turns", "wall"],
    },
    async run(request) {
      seen.push(request);
      return reply;
    },
  };
}

const actionWith = (reply: RunOutcome, diff = "diff --git a/x b/x\n+1", prompt = "") =>
  createAgentAction(
    { name: "review", prompt },
    {
      runtime: reviewer(reply),
      issue: async () => ISSUE,
      diff: async () => diff,
      settingsPath: "/tmp/settings.json",
      limits: { turns: 40, wallMs: 60_000, diffBytes: DIFF_BYTES },
    },
  );

const context = { runId: "run-abc", onSha: "a".repeat(40), cwd: "/tmp/wt", env: {} };

const finding = (over: Record<string, unknown> = {}) => ({
  file: "src/x.ts",
  line: 42,
  severity: "blocker",
  claim: "the guard is not asserted in the write",
  failureScenario: "two writers interleave and the second overwrites the first",
  ...over,
});

describe("the review prompt", () => {
  it("carries the ticket and the diff and nothing from the implementer", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "THE-DIFF", DIFF_BYTES);

    expect(prompt).toContain("#58 — alias-aware skill merging");
    expect(prompt).toContain("THE-DIFF");
    // The structural guarantee is the signature: `buildReviewPrompt` takes the
    // spec, the ticket and the diff, and there is no parameter through which
    // the implementer's output could arrive. Asserting the *word* "transcript"
    // is absent was the first version of this test and it was wrong — the
    // prompt says "no transcript", so the assertion failed on the sentence that
    // makes the guarantee. The real risk is the session id, and that is tested
    // against the action rather than the prompt.
    expect(prompt).toMatch(/nothing else/i);
  });

  it("fixes the severity rubric rather than leaving it to judgement", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES);

    // 001 rated silent corruption `major`. The rubric exists to stop that, so
    // the words that correct it have to actually be in the prompt.
    expect(prompt).toContain("blocker");
    expect(prompt).toMatch(/silent corruption is a blocker/i);
    expect(prompt).toMatch(/take the higher one/i);
  });

  it("names concurrency and check-then-write first", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES);

    // All four known defects in 001 were this one shape, and the experiment is
    // explicit that naming it is part of what was tested.
    expect(prompt).toMatch(/check-then-write/i);
    expect(prompt).toMatch(/no failure scenario, no finding/i);
  });

  it("appends a recipe's prompt without letting it replace the brief", () => {
    const spec = { name: "review", prompt: "watch the RLS policies" };
    const prompt = buildReviewPrompt(spec, ISSUE, "d", DIFF_BYTES);

    expect(prompt).toContain("watch the RLS policies");
    // A recipe adds strictness and never removes it — the same rule everywhere.
    expect(prompt).toMatch(/silent corruption is a blocker/i);
  });

  it("truncates a diff rather than sending an unbounded one", () => {
    const huge = "x".repeat(DIFF_BYTES + 5_000);
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, huge, DIFF_BYTES);

    expect(prompt).toContain("[diff truncated at");
    expect(prompt.length).toBeLessThan(huge.length);
  });

  /**
   * **The one line `#293` adds to the contract**, and it is in the prompt or the
   * field is one nothing ever fills. The two words are `REFUSED_ABOUT`'s, read
   * from the array rather than spelled again, so a third value added there is a
   * red test here and not a reviewer answering a word the parser drops.
   */
  it("asks a refusing reviewer which kind of refusal it is, in the two words", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES);

    expect(prompt).toMatch(/say what your findings are about/i);
    for (const word of REFUSED_ABOUT) expect(prompt).toContain(`"${word}"`);
    // And that not answering is a real answer — a reviewer told to pick one
    // anyway is a reviewer inventing the number this field exists to measure.
    // The schema (`#369`) makes that answer an explicit `null` rather than an
    // omitted key, so the prompt now says so in those words.
    expect(prompt).toMatch(/answer `null` whenever you cannot say which/i);
  });

  it("says nothing about a re-review when there is nothing to re-check", () => {
    // Every review before a fix is this one, and it has to be the prompt it was
    // — the block below is an addition and never a rewrite.
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES);

    expect(prompt).not.toContain("must no longer happen");
  });
});

/**
 * The re-review, which is the acceptance contract of the fix loop
 * ([0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
 *
 * **The reviewer and the fixer are both agents**, so a fix that makes a
 * finding's *text* go away — the line deleted, the symbol renamed, a suppression
 * added — passes a review that is asked whether it still has the same complaint.
 * The guard is that it is asked something else: whether the sequence still
 * produces the outcome, against a scenario written before anybody knew what the
 * fix would be.
 */
describe("asking the reviewer again after a fix", () => {
  const scenario =
    "call deliver() while the log file is unreadable; readFile throws, the catch\n" +
    "swallows it, and the promise resolves as a success";
  const refused = [finding({ failureScenario: scenario })] as never[];

  it("quotes every failure scenario verbatim, because the fixer cannot author it", () => {
    const prompt = buildReviewPrompt(
      { name: "review", prompt: "" },
      ISSUE,
      "THE-FIXED-DIFF",
      DIFF_BYTES,
      refused,
    );

    // Verbatim, line for line. A paraphrase here is a looser criterion than the
    // one the fixer was held to, which is worse than having none.
    for (const line of scenario.split("\n")) expect(prompt).toContain(line.trim());
    expect(prompt).toContain("src/x.ts:42");
    expect(prompt).toContain("blocker");
  });

  it("asks whether the sequence still happens, not whether the finding is still reported", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES, refused);

    expect(prompt).toMatch(/does that sequence still produce that outcome/i);
    // The Goodhart move, named: deleting the code is the cheap way to make a
    // finding's text go away, and the prompt has to refuse it in as many words.
    expect(prompt).toMatch(/deleted, renamed, moved or suppressed is not, on its own, a\s+fix/i);
    expect(prompt).toMatch(/still reachable by \*any\* path is still a finding/i);
  });

  it("keeps the rubric, the checklist and the diff exactly as they were", () => {
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "THE-DIFF", DIFF_BYTES, refused);

    // Not a second kind of action. A re-review that lost the rubric would rate the
    // fix's own defects the way 001's reviewer rated silent corruption.
    expect(prompt).toMatch(/silent corruption is a blocker/i);
    expect(prompt).toMatch(/check-then-write/i);
    expect(prompt).toContain("THE-DIFF");
  });

  it("runs under an id of its own, so it is not asked whether it still agrees with itself", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "a diff",
        settingsPath: "/tmp/s.json",
        limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
      },
    );

    await action.run(context);
    await action.run({ ...context, onSha: "b".repeat(40), recheck: refused });

    // The session id is a function of the run id, so a re-review sharing the
    // first review's id would resume that session — warm, and agreeing with
    // itself by construction.
    expect(runtime.seen[1]?.runId).not.toBe(runtime.seen[0]?.runId);
    expect(runtime.seen[1]?.prompt).toContain("Scenarios that must no longer happen");
    expect(runtime.seen[0]?.prompt).not.toContain("Scenarios that must no longer happen");
  });

  /**
   * **The round the id forgot** (`#195`).
   *
   * The test above sends findings, and findings were the only path that carried
   * the commit. A refusal that has none — a red build, an answer that would not
   * parse, a reviewer that did not finish — buys a round all the same and sends
   * `recheck` empty, and that round's review used to run under the id round 1
   * had already used. Claude Code refuses a `--session-id` it has been given
   * before, so it died in one second with no receipt, the round was spent, and
   * `wi-lingtai-192` reached a person with no verdict about its diff at all.
   *
   * The runtime here refuses a repeat the way the binary does, through the same
   * `sessionIdFor` the adapter derives it with — so what is pinned is the UUID
   * and not the shape of the string it is made from.
   *
   * **And the assertion is that the second review produced a verdict**, not
   * that the two ids differ: two ids that differ and a review that never ran is
   * the bug, wearing the fix's clothes.
   */
  it("reviews the round after a refusal that carried no findings, under a session of its own", async () => {
    const taken = new Set<string>();
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    runtime.run = async (request) => {
      runtime.seen.push(request);
      const session = sessionIdFor(request.runId);
      if (taken.has(session)) {
        // `run-9e510ffc`, verbatim: one second, exit 1, nothing on the stream.
        return outcome({
          exitCode: 1,
          turns: 0,
          costUsd: null,
          text: null,
          failure: { kind: "crash", detail: `Error: Session ID ${session} is already in use.` },
        });
      }
      taken.add(session);
      return outcome({ text: '{"findings":[]}' });
    };
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "a diff",
        settingsPath: "/tmp/s.json",
        limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
      },
    );

    // One run, two rounds. The head moves because a round is only bought when
    // the fixer committed, and nothing else about the context changes.
    const first = await action.run({ ...context, onSha: "a".repeat(40) });
    const second = await action.run({ ...context, onSha: "b".repeat(40), round: 2 });

    expect(first.verdict).toBe("passed");
    expect(second.verdict).toBe("passed");
    expect(second.evidence).not.toContain("already in use");
  });
});

describe("reading the reviewer's answer", () => {
  it("takes findings out of a fenced block, which is what models actually emit", () => {
    const { findings, parsed } = parseFindings(
      "Here is what I found:\n\n```json\n" + JSON.stringify({ findings: [finding()] }) + "\n```\n",
    );

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.claim).toContain("not asserted in the write");
  });

  it("drops a finding with no failure scenario", () => {
    const { findings, parsed } = parseFindings(
      JSON.stringify({
        findings: [finding(), { file: "a.ts", line: 1, severity: "major", claim: "this feels wrong" }],
      }),
    );

    expect(parsed).toBe(true);
    // An observation without a scenario is an opinion, and opinions are what
    // made the old review queue unworkable. The rule is in the prompt; this is
    // what makes it true rather than aspirational.
    expect(findings).toHaveLength(1);
  });

  it("treats an empty list as a real answer, not as a failure to answer", () => {
    const { findings, parsed } = parseFindings('{"findings":[]}');

    expect(parsed).toBe(true);
    expect(findings).toEqual([]);
  });

  it("reads an unrecognised severity as the highest, not the lowest", () => {
    const { findings } = parseFindings(JSON.stringify({ findings: [finding({ severity: "meh" })] }));

    // The rubric exists because severity ran *low*. Guessing downwards on a
    // malformed answer would reintroduce exactly that.
    expect(findings[0]?.severity).toBe("blocker");
  });

  /**
   * **And *unrecognised* is decided by `SEVERITIES`, which is where a second
   * copy of the ladder goes red** (`#237`).
   *
   * The check above held its own `"blocker" | "major" | "minor"`, linked to
   * nothing, so a severity added to the enum was unrecognised here and
   * recorded as `blocker` by the line directly above — the gentlest new rung
   * arriving as the harshest, refusing the action and buying a fix round. That
   * is the failure a reader of `SEVERITIES`' comment would have walked into,
   * and walking the array rather than naming three members is what makes it a
   * failing test rather than a claim.
   */
  it("keeps every severity that is on the ladder, whatever the ladder is", () => {
    for (const severity of SEVERITIES) {
      const { findings } = parseFindings(JSON.stringify({ findings: [finding({ severity })] }));

      expect(findings[0]?.severity, severity).toBe(severity);
    }
  });

  it("says it could not parse rather than reporting no findings", () => {
    // The difference matters: "nothing wrong" and "I could not read the answer"
    // must not both render as a green action.
    expect(parseFindings("I looked at it and it seems fine to me.")).toEqual({
      findings: [],
      parsed: false,
    });
    expect(parseFindings(null).parsed).toBe(false);
  });

  /**
   * **`#262`'s answer, prose and all** (`#272`).
   *
   * The reviewer verified every citation in the diff — `endingOf`, `StepWork`,
   * `StepBody`, the package graph, the twelve plugins' `notBuiltYet` values,
   * that the commit avoided GitHub's closing verbs — and said `{"findings":[]}`.
   * `indexOf("{")` found the brace in `` `{ending:"passed"}` `` instead, so the
   * candidate was that fragment followed by a paragraph of English; there was no
   * fence to fall back to, and a clean review was refused with *the reviewer's
   * answer was not readable as findings*. A person had to waive it.
   *
   * **This punished exactly the behaviour the prompt asks for**: the more
   * precisely a reviewer quotes the code, the more braces its prose carries.
   */
  it("reads an answer whose prose quotes a brace, because it ends in findings", () => {
    const answer = [
      "I checked every citation in the diff against the files.",
      "",
      '- `endingOf` at `pass.ts:1473` maps each event to what the table says: `StepPassed` = `{ending:"passed"}`,',
      '  `StepFailed` = `{ending:"failed"}`. Both hold.',
      "- `StepWork` is at `440` and `StepBody` at `532`, as the diff claims.",
      "- The package graph holds: nothing new is imported across the seam.",
      "- All twelve plugins carry a `notBuiltYet` value.",
      "- The commit body mentions `#231` with no closing verb beside it.",
      "",
      "Nothing to report.",
      "",
      '{"findings":[]}',
    ].join("\n");

    const { findings, parsed } = parseFindings(answer);

    // `parsed` is the whole point: an empty list is an answer, and this one was
    // read as a refusal for want of knowing where it started.
    expect(parsed).toBe(true);
    expect(findings).toEqual([]);
  });

  it("reads a finding under prose that quotes a brace, nested braces and all", () => {
    // And this is why it is *every* brace rather than `lastIndexOf` alone: the
    // last brace in a non-empty answer opens the last finding, not the object.
    const { findings, parsed } = parseFindings(
      `The ending table says \`{ending:"passed"}\`, which is where this goes wrong.\n\n` +
        JSON.stringify({ findings: [finding()] }),
    );

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(1);
  });

  it("still refuses an answer truncated mid-object, even once the tolerant reader can run", () => {
    // `#253`'s attempt 1, where the answer was cut off mid-JSON and was readable
    // only by luck. Scanning every brace must not turn *cannot be read* into a
    // green action: no position in a truncated object parses strictly, and the
    // tolerant reader (`#318`) does not guess the end of an unterminated string
    // either — it has nothing complete to close around. That is the whole of
    // the difference the refusal downstream is for.
    const text = `Here is what I found.\n\n{"findings":[{"file":"pass.ts","line":1473,"severity":"major","claim":"the ending is`;

    const { findings, parsed, unreadableAt } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    // Points at the end of input, inside the string that never closed — not at
    // the position the value started, which would be a long way back for a
    // reviewer who had written most of a paragraph by then.
    expect(unreadableAt).toMatchObject({ offset: text.length, char: null, context: "string" });
  });

  /**
   * **`#269` attempt 3's own answer, and what it cost** (`#279`, recovered by `#318`).
   *
   * Four findings — a `major` with a failure scenario and three minors — ending one
   * closing brace short of valid JSON, with `stop_reason: end_turn`: the model
   * believed it had finished. 61 turns, $8.97, and the pass then parked as though
   * the reviewer had held an opinion not worth a round, because `parsed` stopped at
   * this function.
   *
   * **The assertion is a repair now, and not a refusal.** Every strict candidate
   * still fails exactly as before — no fence to strip, and the outer `{` is
   * followed by the rest of the array rather than by its own close. What is new is
   * the tolerant reading reached only once every strict one has: every value in the
   * object is complete, only the outer `}` is missing, and `readTolerantJson` closes
   * it. All four findings kept every one of `Finding`'s five keys, so none was
   * dropped by `findingProblem`, and the `major` among them makes the verdict
   * `failed` — the two conditions that let a repaired reading count at all.
   */
  it("recovers the answer that was dropped whole, a truncation and not a fence", () => {
    // Not a fenced block and not prose around a brace: there is no fence to strip,
    // an inner `{` is followed by the rest of the array, and the outer one never
    // closes. So every *strict* candidate fails.
    expect(REVIEW_THAT_DID_NOT_PARSE).not.toContain("```");
    expect(REVIEW_THAT_DID_NOT_PARSE.startsWith('{"findings":[')).toBe(true);
    expect(REVIEW_THAT_DID_NOT_PARSE.endsWith("}]")).toBe(true);

    const { findings, parsed } = parseFindings(REVIEW_THAT_DID_NOT_PARSE);

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(4);
    expect(findings.map((f) => f.severity)).toEqual(["major", "minor", "minor", "minor"]);
    expect(findings[0]).toMatchObject({ file: "packages/recipe/src/recipe.ts", line: 1413 });

    // And the fixture is only worth keeping while the strict reading alone still
    // fails on it: one more brace and step 2 is never reached.
    expect(parseFindings(`${REVIEW_THAT_DID_NOT_PARSE}}`)).toMatchObject({ parsed: true });
  });

  /** `#243`'s own failure mode — a full-width colon, not a truncation — recovered the same way. */
  it("recovers a full-width colon in a key separator, and leaves one quoted inside a claim alone", () => {
    expect(() => JSON.parse(REVIEW_WITH_FULL_WIDTH_COLON)).toThrow();

    const { findings, parsed } = parseFindings(REVIEW_WITH_FULL_WIDTH_COLON);

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["major", "minor", "minor"]);
    // The repair table only ever answers a question the string scanner never
    // asks, so the colon quoted inside this claim survives character for character.
    expect(findings[0]?.claim).toContain("的分支：未实现");
  });

  /**
   * **A prose answer with no JSON in it at all must not report the first letter
   * of the first sentence as an "unexpected character"** (`#318`, round one's
   * own regression). Without the `startsWith("{")` gate, the whole-text
   * candidate's syntax failure at offset 0 would win `furthest` by default,
   * which turned *there is nothing here to repair* into a sentence that reads
   * exactly like a one-byte repair gone wrong.
   */
  it("reports no JSON object was found, rather than the first letter of the prose, when there is none to find", () => {
    const { unreadableAt } = parseFindings("I looked at it and it seems fine to me.");

    expect(unreadableAt).toBeUndefined();
  });

  /**
   * **`#262`'s own shape, one step worse** (`#318` finding 1). That reviewer's
   * clean `{"findings":[]}` was waived by a person only once `#272` stopped
   * reading the prose's own quoted brace as the answer's start. Here there is
   * no trailing `{"findings":[]}` at all — the quoted brace is every `{` in the
   * text — so every per-brace candidate the tolerant reader tries is cut from
   * prose that was never attempting JSON, and the `startsWith("{")` a
   * per-candidate gate once checked is true of every one of them by
   * construction. The fix is that a failure one character past the open brace
   * (never getting to a key's opening quote) does not count as evidence either.
   */
  it("reports no JSON object was found, rather than the byte right after a quoted code brace", () => {
    const answer =
      "**Refusal is about `lines`**\n\n" +
      '- The `merge` point renders `{ending:"passed"}` and executes nothing.\n';

    const { unreadableAt, parsed } = parseFindings(answer);

    expect(parsed).toBe(false);
    expect(unreadableAt).toBeUndefined();
  });

  it("reports the offending character and its offset when the text does look like JSON", () => {
    const { unreadableAt } = parseFindings('{"a":1："b":2}');

    expect(unreadableAt).toMatchObject({ offset: 6, char: "：" });
  });

  /**
   * **A repaired reading that read fine and was then refused must say so**
   * (`#318` finding 1, the round-one review). Before this, `unreadableAt` was
   * only ever set from a candidate the tolerant reader failed *syntactically*
   * on — so a repair that parsed in full and was then refused by
   * `findingProblem` or the minors-only guard left `furthest` untouched, and
   * the sentence either claimed no JSON was found at all or pointed at an
   * unrelated syntax failure elsewhere in the text (a quoted brace, or prose
   * ahead of the real object).
   */
  it("says a repaired reading was rejected, not that nothing was found, when an entry is incomplete", () => {
    // One finding earlier than `#269`'s own truncation: the second entry stops
    // right after `severity`, so it closes complete but with no `claim` or
    // `failureScenario` at all — incomplete by `findingProblem`, and the object
    // it sits in read fine.
    const text =
      '{"findings":[{"file":"a.ts","line":1,"severity":"blocker","claim":"c1","failureScenario":"s1"},' +
      '{"file":"b.ts","line":2,"severity":"major"';

    const { findings, parsed, unreadableAt } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(unreadableAt).toMatchObject({ char: null, reason: "finding 2 of 2 has no `claim`" });
  });

  it("says a repaired reading was rejected rather than naming the first letter of a prose preamble", () => {
    // Prefixing the same truncation with prose used to make `furthest` the
    // whole-text candidate's syntax failure at offset 0 — the one place
    // nothing went wrong, because the object candidate behind it parsed fine
    // and was correctly refused for its incomplete entry.
    const text =
      "Here is what I found.\n\n" +
      '{"findings":[{"file":"a.ts","line":1,"severity":"blocker","claim":"c1","failureScenario":"s1"},' +
      '{"file":"b.ts","line":2,"severity":"major"';

    const { unreadableAt } = parseFindings(text);

    expect(unreadableAt).toMatchObject({ reason: "finding 2 of 2 has no `claim`" });
  });

  it("says a repaired reading of only minors was rejected, not that nothing parsed", () => {
    // A full-width colon repaired fine, and the only finding in it is a minor
    // — refused by the bar in `verdictFor`, not because reading it failed.
    const text = '{"findings":[{"file":"a.ts","line":1,"severity":"minor","claim":"c1","failureScenario"："s1"}]}';

    const { unreadableAt } = parseFindings(text);

    expect(unreadableAt).toMatchObject({
      char: null,
      reason: "nothing in it was a blocker or a major, and a repaired reading may not pass",
    });
  });

  /**
   * **A truncation landing between `failureScenario` and `severity` must not
   * invent a severity** (`#318` finding 3). The old dropped-entry guard only
   * counted entries, so an entry complete enough to keep its `claim` and
   * `failureScenario` but cut off before `severity` used to pass that guard
   * unchanged and a stale implementation filled in `SEVERITIES[0]` —
   * `blocker` — for a finding the reviewer never classified at all.
   * `findingProblem` requires the key to be present, so this is refused
   * instead.
   */
  it("refuses a repaired reading rather than invent a severity for a finding truncated before it", () => {
    const text =
      '{"findings":[{"file":"a.ts","line":1,"claim":"c1","failureScenario":"s1","severity":"minor"},' +
      '{"file":"b.ts","line":2,"claim":"c2","failureScenario":"the real second scenario"';

    const { findings, parsed, unreadableAt } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(unreadableAt).toMatchObject({ char: null, reason: "finding 2 of 2 has no `severity`" });
  });

  /** `findingProblem`'s other half of scenario 3: a truncation before `file` must not return `file: "(unknown)"`. */
  it("refuses a repaired reading rather than invent a file for a finding truncated before it", () => {
    const text =
      '{"findings":[{"file":"a.ts","line":1,"claim":"c1","failureScenario":"s1","severity":"minor"},' +
      '{"line":2,"claim":"c2","failureScenario":"the real second scenario","severity":"major"';

    const { findings, parsed, unreadableAt } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(unreadableAt).toMatchObject({ char: null, reason: "finding 2 of 2 has no `file`" });
  });

  /**
   * **An empty `claim` or `failureScenario` is not a complete finding, even
   * though both keys are present and correctly typed** (`#318` finding 4). The
   * strict path drops such an entry via `normaliseAnswer`'s `!f?.claim` check,
   * so the same bytes with an ASCII colon return `findings: []`; before this,
   * `findingProblem` only checked `typeof`, so the full-width-colon repair
   * that reaches this same entry kept it — a `major` with nothing in either
   * field — as though the reviewer had written one.
   */
  it("refuses a repaired reading whose finding has an empty claim and failure scenario", () => {
    const text = '{"findings":[{"file":"","line":null,"severity"："major","claim":"","failureScenario":""}]}';

    const { findings, parsed, unreadableAt } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(unreadableAt).toMatchObject({ char: null, reason: "finding 1 of 1 has no `claim`" });
  });

  /** A severity that is not on the ladder at all — not merely missing — gets its own sentence, naming the value seen. */
  it("names the invalid severity it saw, rather than just saying one was missing", () => {
    const text = '{"findings":[{"file":"a.ts","line":1,"claim":"c1","failureScenario":"s1","severity"："critical"}]}';

    const { unreadableAt } = parseFindings(text);

    expect(unreadableAt).toMatchObject({
      char: null,
      reason: "finding 1 of 1's `severity` is `critical`, not one of blocker, major, minor",
    });
  });

  /**
   * **The blocker found in attempt 1's own round-one review: a candidate must
   * use up its whole extent, exactly as `JSON.parse` does** (`#318`). Without
   * this, a findings-shaped example quoted in the reviewer's prose — to
   * illustrate the shape it was about to answer in — would read as a complete
   * value in its own right, and the agent's real (and broken) answer after it
   * would never be reached. Fabricated findings off the example would come
   * back as the reviewer's own.
   */
  it("rejects a reading that parsed but left trailing content, so a quoted example is never read as the answer", () => {
    const text =
      'For example, a clean answer looks like {"findings":[{"file":"x.ts","line":1,"severity":"major",' +
      '"claim":"example","failureScenario":"example"}]}.\n\n' +
      'Here is my real answer, but it breaks: {"findings":[{"file":"a.ts","line":2,"severity":"blocker",' +
      '"claim":"c","failureScenario":"the real';

    const { findings, parsed } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(findings.some((f) => f.claim === "example")).toBe(false);
  });

  /**
   * **The same blocker, where the example is fenced rather than quoted inline**
   * (`#318` finding 3). A fenced candidate's `text` used to be only the
   * interior of the ```json block — stopping at the closing fence rather than
   * running to the end of the answer the way an unfenced candidate already
   * does — so it never saw the real answer that followed it, read as a
   * complete value on its own, and won before the real (broken) answer was
   * ever tried.
   */
  it("rejects a fenced example followed by a broken real answer, so the example is never read as the answer", () => {
    const text =
      "For example:\n\n```json\n" +
      JSON.stringify({ findings: [{ file: "x.ts", line: 1, severity: "major", claim: "example", failureScenario: "example" }] }) +
      "\n```\n\n" +
      'My real answer: {"findings":[{"file":"a.ts","line":2,"severity":"blocker","claim":"c","failureScenario":"the real';

    const { findings, parsed } = parseFindings(text);

    expect(parsed).toBe(false);
    expect(findings).toEqual([]);
    expect(findings.some((f) => f.claim === "example")).toBe(false);
  });

  /**
   * **A well-formed fenced answer plus an ordinary closing sentence must
   * still parse exactly as it did before `readTolerantJson` existed** (`#318`
   * round-two finding 1). Gluing the fenced block's own trailing text onto
   * its candidate unconditionally — the fix for the test right above this
   * one — made `JSON.parse`'s own extent check see "That is all I found." as
   * leftover content after the value, for every fenced answer with a closing
   * remark, which is the ordinary case and not the exceptional one. Kept on
   * only when the trailing text itself has a `{` in it: a plain sentence
   * never does, and this is the regression that pins it.
   */
  it("parses a fenced answer with an ordinary closing sentence after it, same as a bare fenced block", () => {
    const text =
      "Answer:\n\n```json\n" +
      JSON.stringify({
        findings: [{ file: "a.ts", line: 1, severity: "major", claim: "a real claim", failureScenario: "a real scenario" }],
      }) +
      "\n```\n\nThat is all I found.\n";

    const { findings, parsed } = parseFindings(text);

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("major");
  });

  /**
   * **A complete, well-formed object read out of surrounding prose must never
   * be described by the unrelated byte that happens to sit after it** (`#318`
   * round-two finding 2). The existing test two above this one only exercises
   * the unquoted-key shape, `{ending:"passed"}`, which fails one character
   * past the brace and was already suppressed for that reason. A quoted key
   * reads the whole object fine and only then meets the trailing backtick —
   * a different code path (the extent check on a *completed* value, not a
   * mid-object syntax failure), and the one this regression pins.
   */
  it("reports no JSON object was found, rather than the byte after a quoted object with a quoted key", () => {
    const answer =
      "**Refusal is about `lines`**\n\n" +
      '- The `merge` step renders `{"ending":"passed"}` and executes nothing.\n';

    const { unreadableAt, parsed } = parseFindings(answer);

    expect(parsed).toBe(false);
    expect(unreadableAt).toBeUndefined();
  });

  /**
   * **A character that looks like a mangled quote, not a bare identifier,
   * must be reported rather than swallowed into "no JSON object was found"**
   * (`#318` round-two finding 3). The `offset > 1` check this replaced
   * suppressed every failure one character past the brace regardless of what
   * that character was, so a full-width quote standing in for `"` — the same
   * full-width-punctuation family as `#243`'s colon — was hidden exactly like
   * the unquoted-key case, even though there genuinely is a JSON object on
   * the next line.
   */
  it("reports a mismatched quote character rather than claiming no JSON object was found", () => {
    const { unreadableAt, parsed } = parseFindings("{＂findings＂:[]}");

    expect(parsed).toBe(false);
    expect(unreadableAt).toMatchObject({ offset: 1, char: "＂" });
  });

  /**
   * **A fenced candidate's own offsets must name the byte they claim to**
   * (`#318` round-two finding 4). `start` is the stripped interior's position,
   * but the interior's own trailing newline — proven to be nothing but
   * whitespace once the object has read in full — was still being counted as
   * part of the value's extent, so the reported offset landed one byte short
   * of where the object actually ends, inside the closing fence rather than
   * on the character immediately after `}`.
   */
  it("names the offset right after a fenced object's own close, not inside the fence that follows it", () => {
    const text = "Answer:\n\n```json\n" + JSON.stringify({ result: "ok" }) + "\n```\n\nThat is all I found.\n";
    const closingBrace = text.indexOf("}");

    const { unreadableAt } = parseFindings(text);

    expect(unreadableAt).toMatchObject({ offset: closingBrace + 1, char: null, reason: "it had no `findings` array" });
    expect(text[closingBrace + 1]).not.toBe("`");
  });

  /**
   * **The reviewer's own classification of its refusal, taken as it was said**
   * (`#293`, for `#223`).
   *
   * Both words, off `REFUSED_ABOUT` rather than spelled here, for the reason the
   * severity walk above reads `SEVERITIES`.
   */
  it("takes the two words the reviewer may classify its refusal with", () => {
    for (const about of REFUSED_ABOUT) {
      expect(parseFindings(JSON.stringify({ about, findings: [finding()] }))).toMatchObject({
        parsed: true,
        about,
      });
    }
  });

  /**
   * **Absent is the third state, and nothing here invents a value for it.**
   *
   * A `severity` off the ladder is raised to the worst, because the rubric is
   * something the reviewer was told and under-rating it is the failure 001
   * measured. There is no safe direction here: `lines` and `approach` are
   * opposite answers, and a repaired one would be counted as a reviewer's when
   * the whole point of the field is the count (0031 §1, `#223`'s own rule).
   */
  it("leaves the classification absent where the reviewer did not give one of the two", () => {
    const answers = [
      JSON.stringify({ findings: [finding()] }),
      JSON.stringify({ about: "the lines", findings: [finding()] }),
      JSON.stringify({ about: "Lines", findings: [finding()] }),
      JSON.stringify({ about: null, findings: [finding()] }),
      JSON.stringify({ about: ["lines"], findings: [finding()] }),
    ];

    for (const answer of answers) {
      const read = parseFindings(answer);
      expect(read.parsed).toBe(true);
      expect(read.findings).toHaveLength(1);
      // Absent, not `undefined` under a key: the spread is what carries *did not
      // say* through to the event, and a present key would survive a schema.
      expect(read).not.toHaveProperty("about");
    }
  });
});

describe("the verdict", () => {
  it("refuses on a blocker or a major, and allows a minor", () => {
    expect(verdictFor([{ ...finding(), severity: "minor" } as never])).toBe("passed");
    expect(verdictFor([{ ...finding(), severity: "major" } as never])).toBe("failed");
    expect(verdictFor([{ ...finding(), severity: "blocker" } as never])).toBe("failed");
    expect(verdictFor([])).toBe("passed");
  });
});

describe("the action", () => {
  it("runs the reviewer under its own id, never the implementer's", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "a diff",
        settingsPath: "/tmp/s.json",
        limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
      },
    );

    await action.run(context);

    // The session id is a pure function of the run id, so reusing the run's own
    // id would resume the implementer's session — a warm review wearing a cold
    // review's name, and no test would notice.
    expect(runtime.seen[0]?.runId).not.toBe(context.runId);
    expect(runtime.seen[0]?.runId).toContain("review");
  });

  /**
   * **`model:` reaches the spawn, or it is a price nobody is charged** (`#245`,
   * [0063](../../../doc/decisions-archive/0063-every-setting-is-the-recipes.md) §1's
   * *written, believed, and connected to nothing*).
   *
   * An operator writes `model: claude-haiku-4-5` on `review` to make cold
   * review cheap. The recipe resolves, `configHash` changes and the board draws
   * the new value — and if the key stopped at the schema every review would go
   * on running on the default model at the default price, with no refusal, no
   * warning and no log line saying it was dropped. The seam is this one, and
   * the assertion is on `RunRequest`: the adapter turns it into `--model`.
   */
  it("hands the recipe's model to the runtime, and omits the key when there is none", async () => {
    const deps = (runtime: Runtime) => ({
      runtime,
      issue: async () => ISSUE,
      diff: async () => "a diff",
      settingsPath: "/tmp/s.json",
      limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
    });

    const named = reviewer(outcome({ text: '{"findings":[]}' }));
    await createAgentAction({ name: "review", prompt: "", model: "claude-haiku-4-5" }, deps(named)).run(context);
    expect(named.seen[0]?.model).toBe("claude-haiku-4-5");

    // Absent stays absent, rather than becoming a name chosen here: what a
    // runtime defaults to is the runtime's to know, and `in` rather than
    // `toBeUndefined` because the claim is that no key was sent at all.
    const bare = reviewer(outcome({ text: '{"findings":[]}' }));
    await createAgentAction({ name: "review", prompt: "" }, deps(bare)).run(context);
    expect("model" in (bare.seen[0] ?? {})).toBe(false);
  });

  /**
   * The reviewer is eighteen minutes a person used to wait on in the dark
   * (#153). It writes into the run's own log, under its action, with its tool
   * calls — which no hook reports for it — between the pipeline's start and end.
   */
  it("hands its agent the run's log, tagged with the step and the action", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    runtime.run = async (request) => {
      runtime.seen.push(request);
      request.log?.note("Read", "src/x.ts");
      request.log?.note("receipt", "success · 7 turns · $0.42 · exit 0");
      return outcome({ text: '{"findings":[]}' });
    };
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "diff --git a/x b/x\n+1",
        settingsPath: "/tmp/settings.json",
        limits: { turns: 40, wallMs: 60_000, diffBytes: DIFF_BYTES },
      },
    );
    const lines: string[] = [];
    const log = { note: (label: string, detail = "") => void lines.push(`${label} | ${detail}`) };

    await runActionPipeline({ step: "proposed", actions: [action], context: { ...context, log }, emit: () => {} });

    expect(runtime.seen[0]?.traceTools).toBe(true);
    expect(lines).toEqual([
      "proposed:review | started · agent on aaaaaaa",
      expect.stringMatching(/^proposed:review \| review  run-abc:review:review:aaaaaaa · \d+ bytes of diff$/),
      "proposed:review | Read    src/x.ts",
      "proposed:review | receipt  success · 7 turns · $0.42 · exit 0",
      expect.stringMatching(/^proposed:review \| passed · after \d+s$/),
    ]);
    expect(lines.some((l) => l.startsWith("agent"))).toBe(false);
  });

  it("passes with no findings", async () => {
    const result = await actionWith(outcome({ text: '{"findings":[]}' })).run(context);

    expect(result.verdict).toBe("passed");
    expect(result.findings).toEqual([]);
  });

  it("fails with the findings attached, so the card can show them", async () => {
    const result = await actionWith(
      outcome({ text: JSON.stringify({ findings: [finding()] }) }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.findings).toHaveLength(1);
    expect(result.evidence).toContain("src/x.ts:42");
  });

  /**
   * The rubric's third tier (#135). A minor does not refuse, so the action passes
   * — and before `StepPassed` carried findings, everything the reviewer said
   * survived only as prose inside `evidence`. Asserted on the event the pipeline
   * emits, because the event is what a program reads back.
   */
  it("passes on a minor-only review and leaves its findings structured on the event", async () => {
    const minor = finding({ severity: "minor", line: 313, file: "packages/actions/src/command.ts" });
    const events: ActionEvent[] = [];
    const result = await runActionPipeline({
      step: "proposed",
      actions: [actionWith(outcome({ text: JSON.stringify({ findings: [minor] }) }))],
      context,
      emit: (e) => void events.push(e),
    });

    expect(result.ok).toBe(true);
    const passed = events.at(-1);
    expect(passed?.type).toBe("StepPassed");
    if (passed?.type !== "StepPassed") return;
    expect(passed.data.findings).toEqual([minor]);
    // The prose stays: it is what a person reads.
    expect(passed.data.evidence).toContain("packages/actions/src/command.ts:313");
    expect(parsePayload("StepPassed", passed.data)).toEqual(passed.data);
  });

  it("writes an empty array, not an absent field, on a pass with nothing to say", async () => {
    const events: ActionEvent[] = [];
    await runActionPipeline({
      step: "proposed",
      actions: [actionWith(outcome({ text: '{"findings":[]}' }))],
      context,
      emit: (e) => void events.push(e),
    });

    const passed = events.at(-1);
    expect(passed?.type).toBe("StepPassed");
    expect(passed?.data).toHaveProperty("findings", []);
  });

  it("fails when the reviewer's answer cannot be read", async () => {
    const result = await actionWith(outcome({ text: "looks fine to me" })).run(context);

    // Not passed. A reviewer whose answer is unreadable has reviewed nothing,
    // and a green action for a diff nobody assessed is the failure this whole
    // system exists to remove.
    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("not readable");
    // `describeUnreadable`'s own sentence (`#318`), not just the word before
    // it: prose with no JSON in it at all is `#369`'s to prevent, and this
    // must say so in those words rather than naming the first letter of the
    // prose as though it were a one-byte repair.
    expect(result.evidence).toContain("no JSON object was found in it");
    // And in a word as well as in the sentence (`#279`): `carriesACriterion` one
    // layer up reads fields, not prose, and for four days the only difference
    // between this and a clean review lived in the string above.
    expect(result.unreadable).toBe(true);
  });

  /**
   * **Every `describeUnreadable` branch, through the real action and not only
   * through `parseFindings`** (`#318`, scenario 2's own gap — one of the four
   * branches had no test anywhere, and it was the `reason` branch, which is
   * the fix for scenario 1).
   */
  it("names the offset and character of an unrepairable byte in the evidence", async () => {
    const result = await actionWith(outcome({ text: '{"a":1："b":2}' })).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("unexpected `：` (U+FF1A) at offset 6");
  });

  it("names where input ran out inside an open value, in the evidence", async () => {
    const result = await actionWith(
      outcome({ text: `{"findings":[{"file":"pass.ts","line":1,"severity":"major","claim":"the ending is` }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("inside a string");
  });

  it("names a readable object's missing findings array, in the evidence", async () => {
    const result = await actionWith(outcome({ text: '{"result":"ok"}' })).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("it read as an object ending at offset 15, but it had no `findings` array");
  });

  it("names a repaired reading's incomplete finding, in the evidence", async () => {
    const result = await actionWith(
      outcome({
        text:
          '{"findings":[{"file":"a.ts","line":1,"claim":"c1","failureScenario":"s1","severity":"minor"},' +
          '{"line":2,"claim":"c2","failureScenario":"the real second scenario","severity":"major"',
      }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("finding 2 of 2 has no `file`");
  });

  /**
   * **The other half of `#279`, which is `#262` not re-opening.**
   *
   * *Could not read it* and *read it, it was empty* are two outcomes, and a fix
   * that made them one would give a clean review the unreadable route — which is
   * the bug `#262` was filed for, pointed the other way. So the flag is absent on
   * every answer that parsed, whatever it said.
   */
  it("leaves the flag off an answer it could read, however little it said", async () => {
    const empty = await actionWith(outcome({ text: '{"findings":[]}' })).run(context);
    expect(empty.verdict).toBe("passed");
    expect(empty.unreadable).toBeUndefined();

    const refused = await actionWith(
      outcome({ text: JSON.stringify({ findings: [finding()] }) }),
    ).run(context);
    expect(refused.verdict).toBe("failed");
    expect(refused.unreadable).toBeUndefined();
  });

  it("says on the log that the answer could not be read, and says nothing where it could", async () => {
    const eventsFor = async (text: string): Promise<ActionEvent[]> => {
      const events: ActionEvent[] = [];
      await runActionPipeline({
        step: "review",
        actions: [actionWith(outcome({ text }))],
        context,
        emit: (e) => void events.push(e),
      });
      return events;
    };

    // Not `REVIEW_THAT_DID_NOT_PARSE` any more — `#318` recovers that one, so it
    // is no longer an example of *could not be read at all*. A string
    // truncated mid-quote is: the tolerant reader has nothing complete to
    // close around.
    const stillUnreadable = `Here is what I found.\n\n{"findings":[{"file":"pass.ts","line":1473,"severity":"major","claim":"the ending is`;
    const dropped = (await eventsFor(stillUnreadable)).at(-1);
    if (dropped?.type !== "StepFailed") throw new Error("the reviewer's answer was read after all");
    expect(dropped.data).toHaveProperty("unreadable", true);
    // The schema's, not just the object's: an optional `true` is what the log
    // holds, so a row written with it has to validate.
    expect(parsePayload("StepFailed", dropped.data)).toEqual(dropped.data);

    // **Absent rather than `false`** — the failures with no answer to parse are
    // most of them, and *absent* is what says so without a step over the log.
    const refused = (await eventsFor(JSON.stringify({ findings: [finding()] }))).at(-1);
    if (refused?.type !== "StepFailed") throw new Error("the reviewer did not refuse");
    expect(refused.data).not.toHaveProperty("unreadable");
  });

  /**
   * **What `#293` adds and the whole of what it adds**: a refused review says
   * which kind of refusal it is, the word rides to the log, and nothing reads it.
   *
   * On the event rather than only on the result because the question it exists
   * for — *how often is a refusal about the approach* — is asked of a fortnight
   * of passes, and the only store that keeps a fortnight is `events`: a run log
   * is deleted when the item lands (0034), and `results` is memory.
   */
  it("carries the reviewer's classification of its refusal onto the log", async () => {
    for (const about of REFUSED_ABOUT) {
      const events: ActionEvent[] = [];
      const text = JSON.stringify({ about, findings: [finding()] });
      const result = await runActionPipeline({
        step: "review",
        actions: [actionWith(outcome({ text }))],
        context,
        emit: (e) => void events.push(e),
      });

      expect(result.results[0]).toMatchObject({ verdict: "failed", about });

      const failed = events.at(-1);
      if (failed?.type !== "StepFailed") throw new Error("the reviewer did not refuse");
      expect(failed.data).toHaveProperty("about", about);
      // The schema's and not just the object's: the query is a fold over stored
      // rows, so a row written with this has to validate as one.
      expect(parsePayload("StepFailed", failed.data)).toEqual(failed.data);
    }
  });

  /**
   * **Absent is what every reviewer that has not been updated produces**, and it
   * has to stay a third thing all the way to the row (`#293`, `#223`'s rule and
   * 0031 §1's).
   *
   * Three ways to say nothing — no key, a word that is neither, and an answer
   * written before this field existed at all — and none of them may arrive as
   * `lines`. A count whose unclassified rows were filled in with a default is
   * a count of the default, and this field exists only to be counted.
   *
   * `REVIEW_THAT_DID_NOT_PARSE` is the third: `#318` recovers it (it is a
   * `failed` verdict now, not an unreadable one), and it still carries no
   * `about` because the real review it came from predates `#293` by months.
   */
  it("says nothing about the kind of refusal where the reviewer said nothing", async () => {
    const saidNothing = [
      JSON.stringify({ findings: [finding()] }),
      JSON.stringify({ about: "the approach", findings: [finding()] }),
      REVIEW_THAT_DID_NOT_PARSE,
    ];

    for (const text of saidNothing) {
      const events: ActionEvent[] = [];
      const result = await runActionPipeline({
        step: "review",
        actions: [actionWith(outcome({ text }))],
        context,
        emit: (e) => void events.push(e),
      });

      expect(result.results[0]?.verdict).toBe("failed");
      expect(result.results[0]).not.toHaveProperty("about");

      const failed = events.at(-1);
      if (failed?.type !== "StepFailed") throw new Error("the reviewer did not refuse");
      expect(failed.data).not.toHaveProperty("about");
      expect(parsePayload("StepFailed", failed.data)).toEqual(failed.data);
    }
  });

  /**
   * **A review that passed refused nothing, so it classified nothing.**
   *
   * `#223`'s question is *of the reviews that stopped a change, how many said the
   * approach was wrong* — a denominator with passes in it answers a different
   * question — and `StepPassed` has no field to carry one anyway. A reviewer that
   * volunteers `about` beside an empty list, or beside minors that do not stop
   * anything, is answering about a change that is going ahead.
   */
  it("keeps the classification off a review that did not refuse", async () => {
    const clean = await actionWith(outcome({ text: '{"about":"approach","findings":[]}' })).run(
      context,
    );
    expect(clean.verdict).toBe("passed");
    expect(clean).not.toHaveProperty("about");

    const minorOnly = await actionWith(
      outcome({
        text: JSON.stringify({ about: "lines", findings: [finding({ severity: "minor" })] }),
      }),
    ).run(context);
    expect(minorOnly.verdict).toBe("passed");
    expect(minorOnly).not.toHaveProperty("about");
  });

  /**
   * **A reviewer that started and did not finish is not a refusal either**
   * ([0057](../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md) §1, `#196`).
   *
   * This test asserted `failed` for two years, and the verdict it asserted is
   * the one a reviewer that read the diff and refused it returns. So
   * the conductor bought a fix round for an action that judged nothing, and on
   * `run-9e510ffc` the fixing agent spent fourteen seconds working out that
   * *the review never looked at the change*. The evidence sentence had said so
   * all along — and a sentence is not something `decideFix` reads.
   *
   * **Every kind that is not `never-started`**, which is the whole of this
   * branch: a timeout here and a crash below. Splitting them would put a second
   * classification at a seam 0031 §1 says may only have one.
   */
  it("says a reviewer that did not finish judged nothing, with the kind", async () => {
    const result = await actionWith(
      outcome({ failure: { kind: "timeout", detail: "no result within 60000ms" } }),
    ).run(context);

    expect(result.verdict).toBe("did-not-finish");
    expect(result.evidence).toContain("timeout");
    expect(result.findings).toEqual([]);
  });

  /**
   * The measured one: exit 1 in a second, no receipt on the stream, for a
   * reason that has nothing to do with the diff (`#192`, `#195`).
   */
  it("says the same of a reviewer that crashed, and carries the runtime's words", async () => {
    const result = await actionWith(
      outcome({
        exitCode: 1,
        turns: 0,
        costUsd: null,
        text: null,
        failure: { kind: "crash", detail: "Error: Session ID 0f1e is already in use." },
      }),
    ).run(context);

    expect(result.verdict).toBe("did-not-finish");
    // Prefixed, unlike `never-ran`'s: the prefix is what says the sentence
    // under it is about the machinery and never about the diff.
    expect(result.evidence).toContain("the reviewer did not finish (crash)");
    expect(result.evidence).toContain("already in use");
    expect(result.findings).toEqual([]);
  });

  /**
   * **A quota is not a verdict**, and this is where the two stopped being told
   * apart (`#133`).
   *
   * The line above asserts the ordinary case: the reviewer ran and did not
   * finish, so the action refuses. This is the case that looks identical and is
   * not — the reviewer never started, so there is nothing it could have refused.
   * `never-started` is 0031 §1's three checkable facts, decided by the adapter
   * and taken here rather than re-derived, and `never-ran` is what the pipeline
   * turns into a conductor standing down instead of a card saying a review action
   * refused this diff.
   */
  it("says a reviewer that never started judged nothing, rather than refusing", async () => {
    const said = "You've hit your session limit \u00b7 resets 2pm (America/Chicago)";
    const result = await actionWith(
      outcome({ turns: 0, costUsd: 0, exitCode: 1, failure: { kind: "never-started", detail: said } }),
    ).run(context);

    expect(result.verdict).toBe("never-ran");
    // The runtime's own words, whole and unwrapped: `conduct.ts` reads a reset
    // time out of them, and a prefix like "the reviewer did not finish" would
    // read as a sentence about the diff.
    expect(result.evidence).toBe(said);
    expect(result.findings).toEqual([]);
  });

  /**
   * **The runtime forced the schema and could not make an answer fit it after
   * retrying** — `error_max_structured_output_retries`, the one new
   * `RunFailureKind` `#369` adds. The agent answered something and the runtime
   * is what dropped it, so this is `unreadable` in `#279`'s sense rather than
   * `did-not-finish`: a `failed` verdict that buys no round (0038 §2).
   */
  it("fails and marks the answer unreadable when the runtime could not fit it to the schema", async () => {
    const result = await actionWith(
      outcome({
        turns: 3,
        costUsd: 0.08,
        exitCode: 1,
        text: null,
        failure: { kind: "no-structured-answer", detail: "retried and gave up" },
      }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.unreadable).toBe(true);
    expect(result.evidence).toContain("retried and gave up");
    expect(result.findings).toEqual([]);
  });

  /**
   * **Every reviewer run sends the schema** (`#369`). The flag is the hard
   * constraint the ticket's measurement found — `--json-schema`/
   * `--output-schema` forces a tool call rather than merely asking for one —
   * so the action has to actually send it rather than rely on the prompt's
   * prose, which `CONTRACT` no longer carries the shape rules for.
   */
  it("sends the findings schema with every review run", async () => {
    const reply = reviewer(outcome({ text: '{"findings":[]}' }));
    await createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime: reply,
        issue: async () => ISSUE,
        diff: async () => "diff --git a/x b/x\n+1",
        settingsPath: "/tmp/settings.json",
        limits: { turns: 40, wallMs: 60_000, diffBytes: DIFF_BYTES },
      },
    ).run(context);

    expect(reply.seen[0]?.outputSchema).toBe(REVIEW_ANSWER_JSON_SCHEMA);
  });

  /**
   * **`outcome.structured` is read directly, and `outcome.text` is not a
   * second opinion on the same answer** (`#369`). A runtime that honoured the
   * schema already returned the parsed object; re-parsing `text` would only
   * matter if the two could disagree, and reading both would mean deciding
   * which one wins.
   */
  it("reads the runtime's own parse when it sent one, and ignores the text beside it", async () => {
    const result = await actionWith(
      outcome({ text: "not json at all", structured: { findings: [finding()], about: null } }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.findings).toHaveLength(1);
    expect(result.unreadable).toBeUndefined();
  });

  /**
   * **A `structured` answer with no `findings` array is `unreadable`, and
   * `text` is not consulted to rescue it** (`#369`). The schema guarantees the
   * key is present on anything the runtime actually constrained; an object
   * that still lacks it did not come from the schema path working, and
   * falling back to `text` would be a second reading of one answer — exactly
   * what the structured path exists to avoid.
   */
  it("is unreadable when the structured answer has no findings array, and does not fall back to text", async () => {
    const result = await actionWith(
      outcome({ text: JSON.stringify({ findings: [finding()] }), structured: { about: null } }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.unreadable).toBe(true);
    expect(result.findings).toEqual([]);
  });

  /**
   * **The structured path's own evidence must not claim no JSON was found,
   * when a JSON object sits on the very next line of that same evidence**
   * (`#318` finding 2). `outcome.structured` is already a parsed JS value —
   * `codex.ts`'s `tryParseJSON` accepts any valid JSON under `--output-schema`,
   * not only the findings shape — so a `{"result":"ok", ...}` answer never
   * went through a byte reading `describeUnreadable(undefined)` could be
   * honest about; that function's default is for `parseFindings`'s own `text`
   * path, where "no JSON object was found" is true.
   */
  it("says the structured answer had no findings array, not that no JSON was found", async () => {
    const result = await actionWith(
      outcome({ text: "irrelevant", structured: { result: "ok", summary: "looks fine" } }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.unreadable).toBe(true);
    expect(result.evidence).toContain("it read as JSON with no `findings` array");
    expect(result.evidence).not.toContain("no JSON object was found in it");
  });

  it("does not spend an agent call on an empty diff", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "   \n  ",
        settingsPath: "/tmp/s.json",
        limits: { turns: 1, wallMs: 1, diffBytes: DIFF_BYTES },
      },
    );

    const result = await action.run(context);

    expect(result.verdict).toBe("passed");
    expect(runtime.seen).toHaveLength(0);
  });

  it("does not fetch the ticket when there is nothing to review", async () => {
    let fetched = 0;
    const action = createAgentAction(
      { name: "review", prompt: "" },
      {
        runtime: reviewer(outcome()),
        issue: async () => {
          fetched += 1;
          return ISSUE;
        },
        diff: async () => "",
        settingsPath: "/tmp/s.json",
        limits: { turns: 1, wallMs: 1, diffBytes: DIFF_BYTES },
      },
    );

    await action.run(context);
    expect(fetched).toBe(0);
  });
});

/**
 * **The drafting agent's three answers, and the one that is none of them**
 * (`#294`, 0058 §3c).
 *
 * `design` is on `ARRIVE_AT_THE_ROUTER`, `goesToTheRouter` admits a
 * `did-not-finish` whose `because` is `needs-input`, and `the-pass.py` draws the
 * fan — and until this ticket no branch in `createDraftAction` produced the token,
 * so a design agent that could not answer the ticket had one move: write its
 * doubts into the document and hand them to the implementer, which is the shape
 * the step exists to avoid.
 *
 * **Three states and they are driven here together**, because the trap is that
 * they collapse into two. *Answering with nothing is a real answer, and it is the
 * common one* — a typo fix needs no design — so a parse that read silence as a
 * question would stop every trivial ticket for a person, and one that read an
 * announced-but-unasked question as a document would hand `implement` a design
 * note that is really a difficulty (`#279`).
 */
describe("the drafting agent's answer", () => {
  const drafter = (reply: RunOutcome) =>
    createDraftAction(
      { name: "draft", prompt: "" },
      {
        runtime: reviewer(reply),
        issue: async () => ISSUE,
        diff: async () => "",
        settingsPath: "/tmp/settings.json",
        limits: { turns: 40, wallMs: 60_000, diffBytes: DIFF_BYTES },
      },
    );

  it("is a design when it is a document", async () => {
    const result = await drafter(outcome({ text: "Put it in `packages/recipe`." })).run(context);

    expect(result.verdict).toBe("passed");
    expect(result.document).toBe("Put it in `packages/recipe`.");
    expect(result.evidence).toContain("packages/recipe");
    // Neither of the other two, said out loud: this is the state the other two
    // are most likely to be mistaken for.
    expect(result.because).toBeUndefined();
    expect(result.unreadable).toBeUndefined();
  });

  it("is *this change needs no design* when it is empty", async () => {
    const result = await drafter(outcome({ text: "  \n " })).run(context);

    expect(result.verdict).toBe("passed");
    // `""` and not absent: *the agent answered that this change needs none* and
    // *nothing here drafts* are one brief to `implement`, and the key is what
    // `designFrom` tells them apart by.
    expect(result.document).toBe("");
    expect(result.evidence).toContain("no design: this change needs none");
    expect(result.because).toBeUndefined();
  });

  it("is a question when it is a question, and that is 0058 §3c's token", async () => {
    const asked = "The ticket asks for a hold at `merge` and for nothing to hold there. Which wins?";
    const result = await drafter(outcome({ text: `\`\`\`question\n${asked}\n\`\`\`` })).run(context);

    // `did-not-finish` and not `failed`: the agent judged nothing, so nothing is
    // charged for the asking (0058 §3b), and `because` is what carries it past
    // `goesToTheRouter` to `proposed`.
    expect(result.verdict).toBe("did-not-finish");
    expect(result.because).toBe(NEEDS_INPUT);
    // The question alone, and no turn count spliced into it: this string is read
    // back to the next design agent as `SentBack.asked`.
    expect(result.evidence).toBe(asked);
    expect(result.evidence).not.toContain("turns");
    // And it is not a document — nothing reaches `implement` from a question.
    expect(result.document).toBeUndefined();
  });

  /**
   * **The answer that is both, and the one the prompt makes likely** (`#294`, the
   * fix round).
   *
   * The block is taught in the prompt, so a model that has both a shape and a
   * doubt emits both — a finished design note and a question after it. Read as a
   * question and nothing else, that note is in no `document`, no `StepPassed`
   * evidence and no event: the pass stops at `design` and the person is handed a
   * side doubt with no sign a design was written, and what held it was a run log
   * 0034 deletes on landing.
   *
   * So the question still stops the pass — it is the thing that has to be
   * answered — and the note rides with it, in the one field that reaches both a
   * person's card and the log.
   */
  it("keeps the design note when the answer is a document and a question", async () => {
    const note = "## Shape\n\nPut `judgeDeclaredAt` in `judge.ts` and hand it the step's own list.";
    const asked = "should the hold go at `proposed:` or `merge:`?";
    const result = await drafter(
      outcome({ text: `${note}\n\n\`\`\`question\n${asked}\n\`\`\`` }),
    ).run(context);

    // Still a question: the agent asked, so the pass has somewhere to go and
    // nothing is charged for the asking.
    expect(result.verdict).toBe("did-not-finish");
    expect(result.because).toBe(NEEDS_INPUT);
    // The question leads, because that is what a judge is offered and what a
    // person answers.
    expect(result.evidence.startsWith(asked)).toBe(true);
    // **And the note the agent was paid to write is not thrown away.**
    expect(result.evidence).toContain(note);
    expect(result.evidence).toContain("What it had written before it asked:");
    // Still no turn count spliced in: this string is read back as `SentBack.asked`.
    expect(result.evidence).not.toContain("turns");
  });

  it("is `unreadable` when it announced a question and asked none", async () => {
    // The fence opened and never closed: read as a document this is a design note
    // whose first line is a code fence and whose body is the agent's difficulty.
    const result = await drafter(
      outcome({ text: "```question\nI do not know which of the two readings is meant" }),
    ).run(context);

    expect(result.unreadable).toBe(true);
    // A refusal's verdict, so the flag reaches `StepFailed` and the log can be
    // asked how often this happens — and `design` does not refuse, so the step
    // reports `did-not-finish` and buys nothing (`endingOf`).
    expect(result.verdict).toBe("failed");
    // Never a silently empty document, which is the whole of `#279` here.
    expect(result.document).toBeUndefined();
    expect(result.evidence).toContain("I do not know which of the two readings is meant");
  });

  it("is `unreadable` when the question block is empty", async () => {
    const result = await drafter(outcome({ text: "```question\n\n```" })).run(context);

    expect(result.unreadable).toBe(true);
    expect(result.document).toBeUndefined();
  });

  /**
   * **`NEEDS_INPUT` is compared here and nowhere above here** (`#296`).
   *
   * The token is what an action says; where the pass *goes* is an ending and an
   * event type. Both were one `StepDidNotFinish` whose `because` the conductor
   * re-read at four call sites, each of which would have compiled having lost the
   * destination to a typo — so the comparison is made once, in the file that
   * defines the word, and what leaves the pipeline is `askedAt` and `StepAsked`.
   *
   * Driven as the pair, because the whole of the claim is that they separate: the
   * same action shape, one answer a question and one a crash, and the two fields
   * are never both set.
   */
  it("leaves a question as `askedAt` and a `StepAsked`, and a crash as neither", async () => {
    const asked = "which of the two `base` values is meant?";
    const questions: ActionEvent[] = [];
    const question = await runActionPipeline({
      step: "design",
      actions: [drafter(outcome({ text: `\`\`\`question\n${asked}\n\`\`\`` }))],
      context,
      emit: (e) => void questions.push(e),
    });

    expect(question.askedAt).toEqual({ action: "draft", detail: asked });
    // And not the other field: a reader that checked `didNotFinishAt` first would
    // otherwise still see a crash where a person was being asked something.
    expect(question.didNotFinishAt).toBeNull();
    expect(questions.at(-1)?.type).toBe("StepAsked");
    expect(questions.at(-1)?.data).toMatchObject({ step: "design", action: "draft", detail: asked });
    // The event is a real one and the schema says so, which is what makes the
    // reset rather than an upcaster the decision it is (`#296`).
    expect(parsePayload("StepAsked", questions.at(-1)!.data)).toEqual(questions.at(-1)!.data);

    const crashes: ActionEvent[] = [];
    const crash = await runActionPipeline({
      step: "design",
      actions: [drafter(outcome({ failure: { kind: "timeout", detail: "no result within 60000ms" } }))],
      context,
      emit: (e) => void crashes.push(e),
    });

    expect(crash.askedAt).toBeNull();
    expect(crash.didNotFinishAt).toMatchObject({ action: "draft" });
    // No `because`: the drafting agent that crashed has no word of its own, so
    // `endingOf` spells it `did-not-finish` — and nothing routes on it.
    expect(crash.didNotFinishAt).not.toHaveProperty("because");
    expect(crashes.at(-1)?.type).toBe("StepDidNotFinish");
  });

  /**
   * The parse, read directly, so the three states are one table rather than four
   * dispatches. The action's branches above are what each state *costs*; this is
   * what each answer *is*.
   */
  it("tells the three apart by what the answer is", () => {
    expect(parseDraft(null)).toEqual({ kind: "document", document: "" });
    expect(parseDraft("")).toEqual({ kind: "document", document: "" });
    expect(parseDraft("a design")).toEqual({ kind: "document", document: "a design" });
    expect(parseDraft("```question\nwhich?\n```")).toEqual({
      kind: "question",
      question: "which?",
      draft: "",
    });
    // A document that quotes a fenced block is still a document: only the
    // `question` tag announces one.
    expect(parseDraft("use:\n\n```ts\nconst x = 1\n```")).toMatchObject({ kind: "document" });
    // And whatever stood before the fence comes back on `draft`, at every width:
    // one sentence of apology and a whole design note are the same slice, because
    // nothing about the answer tells them apart.
    expect(parseDraft("I cannot.\n\n```question\nwhich?\n```")).toEqual({
      kind: "question",
      question: "which?",
      draft: "I cannot.",
    });
    expect(parseDraft("## Shape\n\nDo it in `judge.ts`.\n\n```question\nwhich?\n```")).toEqual({
      kind: "question",
      question: "which?",
      draft: "## Shape\n\nDo it in `judge.ts`.",
    });
  });
});

/**
 * **The other half of 0058 §3c's sentence** — *or that step again with state your
 * assumption* (`#294`).
 *
 * A judge may answer a design's question by sending the pass back to `design`,
 * which buys a round. A design agent handed that round with no memory of asking
 * reads the same ticket, finds the same gap and asks the same thing: one round
 * spent, and a person at the end of it anyway. So what it asked and what the
 * judge said travel into the prompt, with the instruction the ADR names.
 */
describe("the design prompt", () => {
  it("teaches the three states and the bar between a question and a preference", () => {
    const prompt = buildDesignPrompt({ name: "draft", prompt: "" }, ISSUE);

    expect(prompt).toContain("#58 — alias-aware skill merging");
    // Empty is still a real answer, and still the common one.
    expect(prompt).toContain("reply with nothing at all");
    // A question is announced, and the block is what announces it.
    expect(prompt).toContain("```question");
    // The bar, which is the line no parse can hold.
    expect(prompt).toContain("A question is not a doubt");
    expect(prompt).toContain("have a preference, and the document is where preferences go");
    // Nothing was sent back, so nothing says it was.
    expect(prompt).not.toContain("a second time");
  });

  it("tells an agent sent back here what it asked and to assume instead", () => {
    const prompt = buildDesignPrompt({ name: "draft", prompt: "" }, ISSUE, {
      why: "assume the ticket means the first reading",
      asked: "which of the two readings is meant?",
      printed: null,
    });

    expect(prompt).toContain("which of the two readings is meant?");
    expect(prompt).toContain("assume the ticket means the first reading");
    expect(prompt).toContain("**Do not ask again.**");
  });
});

/**
 * **The bound a `run:` had and an `agent:` did not** (`#298`, 0066 §8).
 *
 * `command.ts` has clipped a command's output to `EVIDENCE_LINES` and
 * `EVIDENCE_BYTES` since it was written — *enough to act on, bounded*. An
 * `agent:` action put on the log whatever the model produced, and the only
 * thing holding it down was a sentence in a prompt asking for brevity: at
 * `design` that is the whole document, at `review` whatever the answer was.
 *
 * **Asserted on the event and not on the result**, because the event is the
 * thing that outlives this: `task_view` and `finding_backlog` are folds, so an
 * unbounded string is replayed on every rebuild, for as long as the log exists.
 *
 * The three properties together, because two of them without the third is a
 * quieter bug than the one being fixed — it is bounded, the turn count and the
 * start both survive the cut, and **it says it was cut**. A card that shows the
 * first half of a design with no mark where it stops is a person told they have
 * the whole answer.
 */
describe("an agent's evidence on the log", () => {
  /** Comfortably above `EVIDENCE_BYTES` and its quarter-sized head. */
  const BOUND = 12_000;

  type Step = Parameters<typeof runActionPipeline>[0]["step"];

  const evidenceOf = async (action: Action, step: Step) => {
    const events: ActionEvent[] = [];
    await runActionPipeline({ step, actions: [action], context, emit: (e) => void events.push(e) });
    const last = events.at(-1);
    if (last === undefined || !("evidence" in last.data)) throw new Error(`no evidence on ${last?.type}`);
    return last.data.evidence as string;
  };

  it("clips a review that said far too much, and says that it clipped it", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      finding({ file: `src/f${i}.ts`, line: i, claim: `the guard at ${i} is not asserted in the write` }),
    );

    const evidence = await evidenceOf(
      actionWith(outcome({ text: JSON.stringify({ findings: many }) })),
      "review",
    );

    expect(evidence.length).toBeLessThan(BOUND);
    // The start is what a reader needs first, and `tail` keeps it.
    expect(evidence).toContain("src/f0.ts:0");
    // The end is what carries the cost, and it is the last thing appended.
    expect(evidence).toContain("(7 turns · $0.42)");
    expect(evidence).toContain("this is not the whole answer");
  });

  /**
   * `design` is the case 0066 §8 names, and the worst of them: `createDraftAction`
   * put the entire document on `evidence`. The document itself still leaves the
   * action whole on `result.document` — `WroteTheDesign` is where a design is
   * kept, and clipping the card's copy of it costs nothing.
   */
  it("clips a design document, and leaves the document itself whole", async () => {
    const document = Array.from({ length: 4_000 }, (_, i) => `- line ${i} of the design`).join("\n");
    const drafter = createDraftAction(
      { name: "draft", prompt: "" },
      {
        runtime: reviewer(outcome({ text: document })),
        issue: async () => ISSUE,
        diff: async () => "",
        settingsPath: "/tmp/settings.json",
        limits: { turns: 40, wallMs: 60_000, diffBytes: DIFF_BYTES },
      },
    );

    const result = await drafter.run(context);
    expect(result.document).toBe(document);

    const evidence = await evidenceOf(drafter, "design");

    expect(document.length).toBeGreaterThan(80_000);
    expect(evidence.length).toBeLessThan(BOUND);
    expect(evidence).toContain("- line 0 of the design");
    expect(evidence).toContain("(7 turns · $0.42)");
    expect(evidence).toContain("this is not the whole answer");
  });

  /**
   * The other half, and the one a careless fix breaks: nearly every evidence is
   * short, and a bound that rewrote those would put a clip marker on answers
   * nothing was cut from.
   */
  it("leaves an evidence that fits exactly as it was", async () => {
    const evidence = await evidenceOf(
      actionWith(outcome({ text: JSON.stringify({ findings: [finding()] }) })),
      "review",
    );

    expect(evidence).toBe("blocker src/x.ts:42 — the guard is not asserted in the write\n\n(7 turns · $0.42)");
  });
});

/**
 * **`ActionFinding` and the schema cannot diverge, because one declaration is
 * the source of both** (`#369`). `ActionFinding` is a re-export of domain's
 * `Finding` type, and `REVIEW_ANSWER_JSON_SCHEMA` is generated from the same
 * zod object — so a field added to one and not the other is a red test here
 * rather than a runtime discovering it mid-review.
 */
describe("the schema and ActionFinding cannot diverge", () => {
  it("has exactly the keys the schema's own finding shape has", () => {
    const full: Required<ActionFinding> = {
      file: "x.ts",
      line: null,
      claim: "c",
      failureScenario: "f",
      severity: "minor",
    };
    const findingsProp = (REVIEW_ANSWER_JSON_SCHEMA.properties as Record<string, unknown>).findings as Record<
      string,
      unknown
    >;
    const items = findingsProp.items as Record<string, unknown>;
    const schemaKeys = Object.keys(items.properties as Record<string, unknown>);

    expect(Object.keys(full).sort()).toEqual(schemaKeys.sort());
  });

  it("carries severity's ladder as SEVERITIES, not a copy of it", () => {
    const findingsProp = (REVIEW_ANSWER_JSON_SCHEMA.properties as Record<string, unknown>).findings as Record<
      string,
      unknown
    >;
    const items = findingsProp.items as Record<string, unknown>;
    const severity = (items.properties as Record<string, { enum: readonly string[] }>).severity!;

    expect(severity.enum).toEqual(SEVERITIES);
  });
});
