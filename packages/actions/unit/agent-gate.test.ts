/**
 * The agent gate.
 *
 * Everything here is about the three properties experiment 001 said the gate
 * lives or dies by: the reviewer is cold, a finding without a failure scenario
 * is not a finding, and severity is not the reviewer's to soften.
 */
import type { RunOutcome, RunRequest, Runtime } from "@lingtai/agent";
import { sessionIdFor } from "@lingtai/agent";
import { describe, expect, it } from "vitest";
import { SEVERITIES, parsePayload } from "@lingtai/domain";
import {
  buildReviewPrompt,
  createAgentGate,
  parseFindings,
  verdictFor,
} from "../src/agent-gate.ts";
import { type GateEvent, runGatePipeline } from "../src/gate.ts";

const ISSUE = { ref: "58", title: "alias-aware skill merging", body: "merge skills by alias" };

/** The recipe's default, written here rather than imported: this file is about
 *  the gate's behaviour at *a* bound, not about which bound the schema picks. */
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

const gateWith = (reply: RunOutcome, diff = "diff --git a/x b/x\n+1", prompt = "") =>
  createAgentGate(
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
    // against the gate rather than the prompt.
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

  it("says nothing about a re-review when there is nothing to re-check", () => {
    // Every review before a fix is this one, and it has to be the prompt it was
    // — the block below is an addition and never a rewrite.
    const prompt = buildReviewPrompt({ name: "review", prompt: "" }, ISSUE, "d", DIFF_BYTES);

    expect(prompt).not.toContain("must no longer happen");
  });
});

/**
 * The re-review, which is the acceptance contract of the fix loop
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
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

    // Not a second kind of gate. A re-review that lost the rubric would rate the
    // fix's own defects the way 001's reviewer rated silent corruption.
    expect(prompt).toMatch(/silent corruption is a blocker/i);
    expect(prompt).toMatch(/check-then-write/i);
    expect(prompt).toContain("THE-DIFF");
  });

  it("runs under an id of its own, so it is not asked whether it still agrees with itself", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const gate = createAgentGate(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "a diff",
        settingsPath: "/tmp/s.json",
        limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
      },
    );

    await gate.run(context);
    await gate.run({ ...context, onSha: "b".repeat(40), recheck: refused });

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
    const gate = createAgentGate(
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
    const first = await gate.run({ ...context, onSha: "a".repeat(40) });
    const second = await gate.run({ ...context, onSha: "b".repeat(40), round: 2 });

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
   * arriving as the harshest, refusing the gate and buying a fix round. That
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
    // must not both render as a green gate.
    expect(parseFindings("I looked at it and it seems fine to me.")).toEqual({
      findings: [],
      parsed: false,
    });
    expect(parseFindings(null).parsed).toBe(false);
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

describe("the gate", () => {
  it("runs the reviewer under its own id, never the implementer's", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const gate = createAgentGate(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "a diff",
        settingsPath: "/tmp/s.json",
        limits: { turns: 40, wallMs: 1000, diffBytes: DIFF_BYTES },
      },
    );

    await gate.run(context);

    // The session id is a pure function of the run id, so reusing the run's own
    // id would resume the implementer's session — a warm review wearing a cold
    // review's name, and no test would notice.
    expect(runtime.seen[0]?.runId).not.toBe(context.runId);
    expect(runtime.seen[0]?.runId).toContain("review");
  });

  /**
   * The reviewer is eighteen minutes a person used to wait on in the dark
   * (#153). It writes into the run's own log, under its gate, with its tool
   * calls — which no hook reports for it — between the pipeline's start and end.
   */
  it("hands its agent the run's log, tagged with the point and the action", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    runtime.run = async (request) => {
      runtime.seen.push(request);
      request.log?.note("Read", "src/x.ts");
      request.log?.note("receipt", "success · 7 turns · $0.42 · exit 0");
      return outcome({ text: '{"findings":[]}' });
    };
    const gate = createAgentGate(
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

    await runGatePipeline({ point: "proposed", gates: [gate], context: { ...context, log }, emit: () => {} });

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
    const result = await gateWith(outcome({ text: '{"findings":[]}' })).run(context);

    expect(result.verdict).toBe("passed");
    expect(result.findings).toEqual([]);
  });

  it("fails with the findings attached, so the card can show them", async () => {
    const result = await gateWith(
      outcome({ text: JSON.stringify({ findings: [finding()] }) }),
    ).run(context);

    expect(result.verdict).toBe("failed");
    expect(result.findings).toHaveLength(1);
    expect(result.evidence).toContain("src/x.ts:42");
  });

  /**
   * The rubric's third tier (#135). A minor does not refuse, so the gate passes
   * — and before `GatePassed` carried findings, everything the reviewer said
   * survived only as prose inside `evidence`. Asserted on the event the pipeline
   * emits, because the event is what a program reads back.
   */
  it("passes on a minor-only review and leaves its findings structured on the event", async () => {
    const minor = finding({ severity: "minor", line: 313, file: "packages/actions/src/command.ts" });
    const events: GateEvent[] = [];
    const result = await runGatePipeline({
      point: "proposed",
      gates: [gateWith(outcome({ text: JSON.stringify({ findings: [minor] }) }))],
      context,
      emit: (e) => void events.push(e),
    });

    expect(result.ok).toBe(true);
    const passed = events.at(-1);
    expect(passed?.type).toBe("GatePassed");
    if (passed?.type !== "GatePassed") return;
    expect(passed.data.findings).toEqual([minor]);
    // The prose stays: it is what a person reads.
    expect(passed.data.evidence).toContain("packages/actions/src/command.ts:313");
    expect(parsePayload("GatePassed", passed.data)).toEqual(passed.data);
  });

  it("writes an empty array, not an absent field, on a pass with nothing to say", async () => {
    const events: GateEvent[] = [];
    await runGatePipeline({
      point: "proposed",
      gates: [gateWith(outcome({ text: '{"findings":[]}' }))],
      context,
      emit: (e) => void events.push(e),
    });

    const passed = events.at(-1);
    expect(passed?.type).toBe("GatePassed");
    expect(passed?.data).toHaveProperty("findings", []);
  });

  it("fails when the reviewer's answer cannot be read", async () => {
    const result = await gateWith(outcome({ text: "looks fine to me" })).run(context);

    // Not passed. A reviewer whose answer is unreadable has reviewed nothing,
    // and a green gate for a diff nobody assessed is the failure this whole
    // system exists to remove.
    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("not readable");
  });

  /**
   * **A reviewer that started and did not finish is not a refusal either**
   * ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §1, `#196`).
   *
   * This test asserted `failed` for two years, and the verdict it asserted is
   * the one a reviewer that read the diff and refused it returns. So
   * `run-once.ts` bought a fix round for a gate that judged nothing, and on
   * `run-9e510ffc` the fixing agent spent fourteen seconds working out that
   * *the review never looked at the change*. The evidence sentence had said so
   * all along — and a sentence is not something `decideFix` reads.
   *
   * **Every kind that is not `never-started`**, which is the whole of this
   * branch: a timeout here and a crash below. Splitting them would put a second
   * classification at a seam 0031 §1 says may only have one.
   */
  it("says a reviewer that did not finish judged nothing, with the kind", async () => {
    const result = await gateWith(
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
    const result = await gateWith(
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
   * finish, so the gate refuses. This is the case that looks identical and is
   * not — the reviewer never started, so there is nothing it could have refused.
   * `never-started` is 0031 §1's three checkable facts, decided by the adapter
   * and taken here rather than re-derived, and `never-ran` is what the pipeline
   * turns into a conductor standing down instead of a card saying a review gate
   * refused this diff.
   */
  it("says a reviewer that never started judged nothing, rather than refusing", async () => {
    const said = "You've hit your session limit \u00b7 resets 2pm (America/Chicago)";
    const result = await gateWith(
      outcome({ turns: 0, costUsd: 0, exitCode: 1, failure: { kind: "never-started", detail: said } }),
    ).run(context);

    expect(result.verdict).toBe("never-ran");
    // The runtime's own words, whole and unwrapped: `run-once.ts` reads a reset
    // time out of them, and a prefix like "the reviewer did not finish" would
    // read as a sentence about the diff.
    expect(result.evidence).toBe(said);
    expect(result.findings).toEqual([]);
  });

  it("does not spend an agent call on an empty diff", async () => {
    const runtime = reviewer(outcome({ text: '{"findings":[]}' }));
    const gate = createAgentGate(
      { name: "review", prompt: "" },
      {
        runtime,
        issue: async () => ISSUE,
        diff: async () => "   \n  ",
        settingsPath: "/tmp/s.json",
        limits: { turns: 1, wallMs: 1, diffBytes: DIFF_BYTES },
      },
    );

    const result = await gate.run(context);

    expect(result.verdict).toBe("passed");
    expect(runtime.seen).toHaveLength(0);
  });

  it("does not fetch the ticket when there is nothing to review", async () => {
    let fetched = 0;
    const gate = createAgentGate(
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

    await gate.run(context);
    expect(fetched).toBe(0);
  });
});
