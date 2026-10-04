/**
 * The agent action: a second agent, cold.
 *
 * This is the action experiment 001 was run to justify, and it earned its place.
 * Issue #58 in `nextloom-ai-admin` passed agent self-review, `verify.sh`, CI, a
 * full human read, and merged — and hours later the same agent filed three bugs
 * against its own merged code. A reviewer given only the issue and the diff
 * found all four known defects in a single finding, plus two nobody had found,
 * both still on `develop` and neither covered by any of ~300 issues.
 *
 * The claim being tested was that self-review after ~89 turns of committed
 * reasoning is not a second opinion. It is not.
 *
 * **Cold is the whole mechanism, and it is fragile.** The reviewer gets the
 * issue text, the diff and the worktree. It does not get the implementer's
 * plan, transcript, or session — and note that `sessionIdFor` is a *function of
 * the run id*, so handing this the run's own id would resume the implementer's
 * session and quietly destroy the only property that matters. It runs under its
 * own id for exactly that reason.
 *
 * Three things are fixed here rather than left to the recipe, because
 * experiment 001 measured each of them going wrong:
 *
 * **The severity rubric.** The reviewer rated silent data corruption — with two
 * actions returning success and an audit row that lies — as `major`. That is a
 * blocker. Left to judgement it will be under-rated again.
 *
 * **A finding needs a failure scenario.** An observation without one is an
 * opinion, and opinions are what made the old review queue unworkable.
 *
 * **Concurrency and check-then-write are named.** All four known defects were
 * that one shape. The experiment is explicit that this tests *the action as
 * designed* rather than a generic reviewer, so the checklist is part of the
 * action, not part of the configuration.
 *
 * A recipe's `prompt` is appended, never substituted. It can add what this
 * project cares about; it cannot remove the rubric — the same rule the recipe
 * follows everywhere else.
 *
 * **Adversarial verification is deliberately not here.** It was designed to
 * filter false positives, and the measured false-positive rate is zero: all
 * three findings in 001 were real. A filter with nothing to filter still costs
 * an agent call. Add it when false positives actually appear.
 *
 * **And the same action is what checks a fix**
 * ([0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
 * A refusal buys an agent that is handed the findings, and then this runs again
 * on the head that agent produced — with `ActionContext.recheck` carrying the
 * findings it was given. Not a second kind of action: the rubric, the checklist
 * and the contract are the same, and the only addition is the question a fix
 * makes possible to ask wrongly — *does that sequence still produce that
 * outcome*, rather than *is that sentence still in my output*. See
 * `recheckBlock`.
 */
import type { Runtime } from "@lingtai/agent";
import { REFUSED_ABOUT, SEVERITIES, type RefusedAbout, type Severity } from "@lingtai/domain";
import {
  NEEDS_INPUT,
  type Action,
  type ActionContext,
  type ActionFinding,
  type ActionResult,
  type SentBack,
} from "./action.ts";
import { boundedEvidence } from "./command.ts";

export interface AgentActionSpec {
  name: string;
  /** Appended to the fixed brief. Adds concerns; cannot remove them. */
  prompt: string;
  /**
   * The recipe's `model:`, handed to the runtime as-is — and **absent means the
   * runtime's own default**, so it is passed through absent rather than
   * resolved to a name here (`#245`, 0063 §2).
   *
   * Lingtai keeps no table of what each runtime defaults to: the runtime knows,
   * and a copy at this seam would be a second place for it to be wrong. Which
   * is also why it is not validated — the legal model names are the runtime's
   * to know, and a stale allowlist here would refuse a model that works.
   */
  model?: string;
}

export interface AgentActionDeps {
  runtime: Runtime;
  /** The ticket, exactly as the implementer received it. Fetched lazily so a
   *  recipe without an agent action costs no API call. */
  issue: () => Promise<{ ref: string; title: string; body: string }>;
  /** The diff under review, `base...head`. Supplied by the caller: the actions
   *  package does not know about git, and should not learn. */
  diff: () => Promise<string>;
  /** Rendered outside the worktree, like the implementer's. */
  settingsPath: string;
  /**
   * What the reviewer may spend, and what it is given.
   *
   * `diffBytes` is the recipe's `runtime.budget.diff`
   * ([0029](../../../doc/decisions-archive/0029-the-prompt-budget-is-the-recipes.md)),
   * and it was a constant here. Above it the diff is truncated rather than sent
   * whole: [experiment 001](../../../doc/experiments/001-cold-review-issue-58.md)'s
   * diff was 1391 lines across 6 files and fitted comfortably, and a diff far
   * past that is a work item that was scoped too large — which the compaction
   * counter already reports. Sending a megabyte to a reviewer produces a worse
   * review, not a better one.
   *
   * Required rather than defaulted, so the number has one home. How large a
   * diff is normal is a fact about a repository, not about reviewing.
   */
  limits: { turns: number; wallMs: number; diffBytes: number };
}

const RUBRIC = `
Severity is not a judgement call. Use this rubric exactly.

- blocker — data is silently wrong, or lost, or a caller is told something
  succeeded when it did not. Silent corruption is a blocker even when it is
  rare, and *especially* when the system reports success and writes an audit
  record that disagrees with what happened. A race that can corrupt data is a
  blocker, not a major.
- major — a defect a user will hit in normal use, that is visible when it
  happens.
- minor — a real defect that is cosmetic, or so narrow it needs contrivance.

If you are between two levels, take the higher one.`;

const CHECKLIST = `
Look at these first. They are where the defects have actually been.

1. **Concurrency and check-then-write.** A SELECT that decides something and an
   UPDATE that acts on it, with nothing constraining the row in between. Ask
   whether the thing that was read is asserted in the write. Ask what a second
   writer does between the two. Ask whether the table is written by anything
   else.
2. **Failure paths that report success.** Two statements where the second can
   fail after the first has committed. What is the caller told? What does the
   audit trail say?
3. **Error states rendered as empty states.** A load that fails, sets null, and
   renders the same branch as "there is nothing here". What is the operator
   told, and what do they do next?
4. **Tests that assert less than they appear to.** A test whose name claims a
   behaviour and whose assertions would pass with that behaviour broken.`;

const CONTRACT = `
Do not read other issues, run \`gh\`, or look at anything outside this worktree
and the diff above. Your value is that you do not know what anyone concluded.

Report as a single JSON object, and nothing else after it:

{"about":"lines","findings":[{"file":"src/x.ts","line":42,"severity":"blocker",
  "claim":"one sentence, what is wrong",
  "failureScenario":"concrete inputs or interleaving, then the wrong outcome"}]}

Rules:
- **No failure scenario, no finding.** If you cannot write the concrete sequence
  that produces a wrong outcome, you do not have a finding, you have an opinion.
  Leave it out.
- **Say what a refusal is about.** Where your findings stop the change, add
  \`"about"\` beside them: \`"lines"\` where this is the right change and part of
  it is wrong, \`"approach"\` where no edit to these lines would fix it because
  the shape is wrong and it should be written again. The example above shows
  where the key goes and is not the usual answer. Omit the key when you
  cannot say which — *did not say* is a real answer here and a guess is not.
- \`line\` may be null if the defect is the absence of something.
- Report findings only. Do not propose the fix — a remedy that differs from the
  one eventually taken is not a miss, and prescribing costs you attention you
  should spend finding.
- An empty list is a real answer. Say {"findings":[]}.`;

export interface ReviewIssue {
  ref: string;
  title: string;
  body: string;
}

/**
 * The block that makes a re-review a re-review
 * ([0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
 *
 * **The reviewer and the fixer are both agents, and a fix that silences a
 * finding is not a fix.** Deleting the line, renaming the symbol or adding a
 * suppression all make a finding's text go away with the defect intact —
 * Goodhart, with a model at each end of the measure. So the question asked here
 * is deliberately not *is this finding still reported*: it is **does this
 * sequence still produce this outcome**, against a scenario quoted verbatim and
 * written before anybody knew what the fix would be.
 *
 * That last property is the whole guard, and it is why the scenario is quoted
 * rather than paraphrased: a criterion the fixer could have authored is not a
 * criterion. The three clauses about removal are there because removal is the
 * cheap way to pass — a capability deleted along with its defect is a scenario
 * that no longer *runs*, not one that no longer produces the outcome.
 */
function recheckBlock(findings: readonly ActionFinding[]): string {
  const items = findings.map((f, i) => {
    const at = f.line === null ? f.file : `${f.file}:${f.line}`;
    return [
      `${i + 1}. **${f.severity}** · ${at} — ${f.claim}`,
      "",
      "   Failure scenario, verbatim:",
      "",
      ...f.failureScenario.split("\n").map((line) => `   > ${line}`),
    ].join("\n");
  });

  return `## Scenarios that must no longer happen

An earlier version of this diff was refused for the findings below, and an agent
has since changed the code with the intention of addressing them. It was given
these scenarios and nothing else about the review.

${items.join("\n\n")}

For each one, walk the code as it now stands and answer the only question that
matters: **does that sequence still produce that outcome?**

- A scenario that is still reachable by *any* path is still a finding. Report it
  again, at the same severity or higher.
- **Code that was deleted, renamed, moved or suppressed is not, on its own, a
  fix.** If the behaviour the scenario describes can still be produced — through
  the new name, the new location, the remaining caller — the finding stands. If
  the capability was removed along with the defect, so that the sequence can no
  longer be performed at all, say so in a new finding: the caller has lost
  something it had.
- A scenario that genuinely can no longer produce its outcome is simply not
  reported. Do not say so, and do not argue with the finding that made it.
- **Every verdict above is a finding, in the format at *How to report* below —
  never a sentence before or beside the JSON.** State what is still wrong in
  \`claim\`, and put the sequence that still produces it, as the code now stands,
  in \`failureScenario\` — narrower than the quote above where only part of it
  still reproduces. A half-fixed scenario with two surviving paths is two
  findings, not one finding straining to describe both.

Then review the diff as it now stands for anything else, exactly as you would
have without this section. The fix is part of the diff and is not above review.`;
}

export function buildReviewPrompt(
  spec: AgentActionSpec,
  issue: ReviewIssue,
  diff: string,
  limitBytes: number,
  recheck: readonly ActionFinding[] = [],
): string {
  const clipped =
    diff.length > limitBytes
      ? `${diff.slice(0, limitBytes)}\n\n[diff truncated at ${limitBytes} bytes]`
      : diff;

  return `You are reviewing a change you did not write. You have the ticket and the
diff, and deliberately nothing else — no plan, no transcript, no reasoning from
whoever wrote it. That is deliberate: this exists because self-review after a
long implementation is not a second opinion.

## The ticket

#${issue.ref} — ${issue.title}

${issue.body}

## The checklist
${CHECKLIST}

## Severity
${RUBRIC}

${spec.prompt ? `## Also for this project\n\n${spec.prompt}\n` : ""}
${recheck.length > 0 ? `${recheckBlock(recheck)}\n\n` : ""}## The diff

\`\`\`diff
${clipped}
\`\`\`

## How to report
${CONTRACT}
`;
}

/**
 * The findings, from whatever the reviewer actually said.
 *
 * Defensive in the same way `parseResult` is, and for the same reason: a model
 * asked for JSON usually gives JSON, and the run where it does not must not
 * become a crash with no verdict.
 *
 * A finding without a failure scenario is **dropped, not repaired**. The rule is
 * in the prompt and enforcing it here is what makes it true rather than
 * aspirational.
 *
 * **Where the answer starts is not the first brace in it** (`#272`). It used to
 * be `indexOf("{")`, which is the *prose's* brace whenever the reviewer quoted
 * the code — and the more precisely it quoted, the likelier that was. `#262`'s
 * reviewer verified every citation in the diff, wrote
 * `` `StepPassed` = `{ending:"passed"}` `` on the way, answered `{"findings":[]}`
 * and had a clean review read as unreadable; a person waived it. So every brace
 * is a candidate, tried last first, because the object is what the answer *ends*
 * in. A truncated answer still parses at no position and is still refused: that
 * difference is the only thing the refusal below is for.
 */
export function parseFindings(text: string | null): {
  findings: ActionFinding[];
  parsed: boolean;
  /**
   * **What the reviewer said its refusal was about**, where it said one of the
   * two words, and absent otherwise (`#293`).
   *
   * Spread rather than set, so *it did not say* is an absent key here and stays
   * one all the way to `StepFailed`: the whole value of the field is the count
   * it makes possible, and a missing answer filled in with a default would be
   * counted as the default.
   */
  about?: RefusedAbout;
} {
  if (!text) return { findings: [], parsed: false };

  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) candidates.push(block.replace(/```(?:json)?/g, "").replace(/```/g, ""));
  // Last brace first: the outer object's own `{` is reached after the braces
  // nested inside it, so `{"findings":[{…}]}` is not read as its last finding.
  for (let i = text.length - 1; i >= 0; i--) if (text[i] === "{") candidates.push(text.slice(i));
  candidates.push(text);

  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    const list = (value as { findings?: unknown })?.findings;
    if (!Array.isArray(list)) continue;

    const findings: ActionFinding[] = [];
    for (const raw of list) {
      const f = raw as Partial<ActionFinding>;
      // The rule from the prompt, enforced.
      if (!f?.claim || !f?.failureScenario) continue;
      findings.push({
        file: String(f.file ?? "(unknown)"),
        line: typeof f.line === "number" ? f.line : null,
        claim: String(f.claim),
        failureScenario: String(f.failureScenario),
        severity: isSeverity(f.severity)
          ? f.severity
          : // Unrecognised means the rubric was not followed, and the rubric
            // exists because severity ran *low*. Take the higher one — and
            // `SEVERITIES` is worst first, so the highest is its own head
            // rather than a name spelled again here.
            SEVERITIES[0],
      });
    }
    // The reviewer's own classification, taken only where it is one of the two
    // words and never repaired into one: a `severity` off the ladder is raised to
    // the worst because the rubric is a thing the reviewer was told, and there is
    // no equivalent safe direction here — `lines` and `approach` are opposite
    // answers, and inventing either would put a classification at this seam that
    // no reviewer made (0031 §1, `#223`'s own rule).
    const about = (value as { about?: unknown })?.about;
    return { findings, parsed: true, ...(isRefusedAbout(about) ? { about } : {}) };
  }

  return { findings: [], parsed: false };
}

/**
 * Blocker or major refuses. A minor is worth knowing and not worth stopping for.
 *
 * **This is one half of the bar, and a fold is the other** (`#237`). What
 * refuses here is exactly what `backlogProjection`
 * (`packages/projector/src/backlog.ts`) does *not* file, and the two spell the
 * same `minor` in two packages that cannot see each other. `decideBacklog` in
 * `packages/conductor/src/backlog.ts` is that one comparison as a function, and
 * when a step reads the `backlog:` plugin **both** of these have to be handed
 * the recipe's value: wire the fold alone and a `major` still fails the action
 * here, `StepFailed` is still emitted, the fold never sees it, and a recipe
 * that said a major costs nothing has bought a fix round.
 *
 * The ladder is `SEVERITIES` and the bar is a position in it, so a severity
 * added to the enum lands on one side of this by arithmetic rather than by
 * being listed.
 */
const BAR: Severity = "minor";
export function verdictFor(findings: readonly ActionFinding[]): "passed" | "failed" {
  const bar = SEVERITIES.indexOf(BAR);
  return findings.some((f) => SEVERITIES.indexOf(f.severity) < bar) ? "failed" : "passed";
}

/** Whether the reviewer's word is on the ladder at all. `SEVERITIES` is the ladder. */
function isSeverity(value: unknown): value is Severity {
  return (SEVERITIES as readonly unknown[]).includes(value);
}

/** Whether the reviewer said one of the two words. `REFUSED_ABOUT` is the pair. */
function isRefusedAbout(value: unknown): value is RefusedAbout {
  return (REFUSED_ABOUT as readonly unknown[]).includes(value);
}

function summarise(findings: readonly ActionFinding[]): string {
  if (findings.length === 0) return "no findings";
  return findings
    .map((f) => `${f.severity} ${f.file}${f.line === null ? "" : `:${f.line}`} — ${f.claim}`)
    .join("\n");
}

export function createAgentAction(spec: AgentActionSpec, deps: AgentActionDeps): Action {
  return {
    name: spec.name,
    kind: "agent",

    async run(context: ActionContext): Promise<ActionResult> {
      const diff = await deps.diff();
      if (!diff.trim()) {
        // Nothing to review is not the same as nothing wrong, and saying so is
        // cheaper than an agent call that reads an empty diff.
        return { verdict: "passed", evidence: "the diff is empty; nothing to review", findings: [] };
      }

      const issue = await deps.issue();
      const recheck = context.recheck ?? [];
      // **Not** `context.runId`. The session id is derived from it, so reusing
      // it would resume the implementer's session and make this a warm review
      // wearing a cold review's name.
      //
      // A re-review gets an id of its own for the same reason *again*: a
      // second review that resumed the first one would be a reviewer asked
      // whether it still agrees with itself, which is the warm-review failure
      // experiment 001 measured, one level up (0038 §2).
      //
      // **So the commit is in it on every path, and not only when findings
      // travelled** (`#195`). This read `${context.runId}:review:${spec.name}`
      // whenever `recheck` was empty — which is every fix round bought by a
      // refusal that carried no findings, a red build or an unreadable answer.
      // Round 2 then handed Claude Code round 1's session id, and the binary
      // refuses one it has already been given: `Session ID ... is already in
      // use`, one second, no receipt, the round spent, the diff never read
      // (`run-9e510ffc`, `wi-lingtai-192`). **The crash was the lucky
      // outcome** — a runtime that resumed instead would have produced the
      // warm review the paragraph above exists to prevent, silently.
      //
      // A function of what the log already records — the run and the commit —
      // so a transcript is still findable from a verdict, which is
      // `sessionIdFor`'s whole reason. The head moves every round a fix is
      // bought for (`conduct.ts` only continues the loop when the fixer
      // committed), so the commit is what makes each round's review a
      // different reviewer.
      const reviewId = `${context.runId}:review:${spec.name}:${context.onSha.slice(0, 7)}`;
      context.log?.note(
        "review",
        `${reviewId} · ${diff.length} bytes of diff` +
          (recheck.length > 0 ? ` · rechecking ${recheck.length} finding${recheck.length === 1 ? "" : "s"}` : ""),
      );
      const outcome = await deps.runtime.run({
        runId: reviewId,
        cwd: context.cwd,
        prompt: buildReviewPrompt(spec, issue, diff, deps.limits.diffBytes, recheck),
        // The recipe's, or the key is not sent at all — `RunRequest.model` is
        // optional and the adapter omits `--model` without it, which is what
        // "the runtime's own default" means in the one place it has to be true.
        ...(spec.model === undefined ? {} : { model: spec.model }),
        settingsPath: deps.settingsPath,
        // Already tagged `<step>:<action>` by the pipeline (#153). The reviewer
        // runs without the hook, so its tool calls are the stream's to write.
        log: context.log,
        traceTools: true,
        env: context.env,
        limits: deps.limits,
        signal: context.signal,
      });

      if (outcome.failure) {
        /**
         * A reviewer that never started has not reviewed anything, and saying
         * so is not the same as refusing the diff.
         *
         * [0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §1
         * was written for runs, because when it landed the only agent in a pass
         * was the implementer — the `agent` action existed and had never once run
         * (`d4fbd1a`). The second agent in a pass became reachable and met a
         * quota wall in its first afternoon, and the action turned it into a
         * failed verdict: a sentence about this diff, produced by a condition
         * that has nothing to do with any diff (`#133`).
         *
         * **The classification is the adapter's, not read again here.** `kind`
         * is `neverStarted`'s three checkable facts — at most the one turn the
         * runtime's own refusal counts as, zero cost, an error — and 0031 §1's whole point is that no reading of the
         * message may decide this. Re-deriving it from `outcome.turns` and
         * `outcome.costUsd` at this seam would give the classification a second
         * home, and the second home is where the two would drift: a receipt
         * that would not parse leaves turns at zero out of ignorance, which is
         * a crash and must stay one.
         */
        if (outcome.failure.kind === "never-started") {
          return {
            verdict: "never-ran",
            // The runtime's own words, whole. `conduct.ts` reads a reset time
            // out of them (0031 §4) and the board shows them as what they are:
            // evidence about the account, never about the diff.
            evidence: boundedEvidence(outcome.failure.detail),
            findings: [],
          };
        }
        /**
         * **And a reviewer that *started* and did not finish has not reviewed
         * anything either** — [0057](../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md) §1.
         *
         * The sentence below has said `the reviewer did not finish` since this
         * branch was written, and the verdict beside it said `failed` — which
         * is the verdict a reviewer that read the diff and refused it returns.
         * So the conductor bought a fix round, and on `run-9e510ffc` an agent
         * was paid fourteen seconds to write *I'm not fixing anything this
         * round … the review never looked at the change* (`#196`). The
         * difference was real and lived only in this string, and a string is
         * not something `decideFix` or the board reads.
         *
         * **The whole branch, and not a second reading of `kind`.** Every
         * failure that is not `never-started` reaches here without a receipt:
         * a crash, a timeout, a turn budget spent without an answer, an abort.
         * None of them judged the diff, so none of them may buy an agent to
         * answer a judgement. Splitting `crash` out from its neighbours would
         * put a second classification at this seam, which is exactly what
         * 0031 §1 forbids — the adapter's `kind` is the answer, and what the
         * answer *costs* is the pipeline's (0057 §4).
         *
         * The runtime's own words stay in it, whole and prefixed, because the
         * prefix is what says they are about the machinery.
         */
        return {
          verdict: "did-not-finish",
          evidence: boundedEvidence(
            `the reviewer did not finish (${outcome.failure.kind}): ${outcome.failure.detail}`,
          ),
          findings: [],
        };
      }

      const { findings, parsed, about } = parseFindings(outcome.text);
      if (!parsed) {
        /**
         * A reviewer whose answer cannot be read has not reviewed anything. The
         * alternative is a green action for a diff nobody assessed.
         *
         * **`unreadable` is the same fact in a word rather than in the sentence**
         * (`#279`). Both of the ways this returns `findings: []` — this branch and
         * a review that read the diff and had nothing to say — reached `proposed`
         * as the same shape, and `carriesACriterion` answered the only thing it
         * could: *nothing an agent could be held to*. `#269`'s third review said
         * four things, one of them a `major` with a failure scenario, and stopped
         * one closing brace short of valid JSON; the pass parked as though the
         * reviewer had held an opinion, and 61 turns and $8.97 went with it.
         *
         * It is still a `failed`, and it still buys nothing: an answer nobody can
         * read is not a criterion (0038 §2). What the flag changes is which
         * sentence a person is handed and what the log can be asked.
         */
        return {
          verdict: "failed",
          evidence: boundedEvidence(`the reviewer's answer was not readable as findings:\n${outcome.text ?? ""}`),
          findings: [],
          unreadable: true,
        };
      }

      const verdict = verdictFor(findings);
      const cost = outcome.costUsd === null ? "" : ` · $${outcome.costUsd.toFixed(2)}`;
      return {
        verdict,
        evidence: boundedEvidence(`${summarise(findings)}\n\n(${outcome.turns} turns${cost})`),
        findings,
        /**
         * **The reviewer's own classification of its refusal, and only of a
         * refusal** (`#293`).
         *
         * On the `failed` verdict because that is the only thing there is to
         * classify: a review that passed refused nothing, so an `about` it
         * volunteered anyway is about a change that is going ahead, and
         * `StepPassed` has no field for it. `#223`'s question is *of the reviews
         * that stopped a change, how many said the approach was wrong*, and a
         * denominator with passes in it does not answer it.
         *
         * Spread, so *the reviewer did not say* stays an absent key — the rule
         * this whole field is under.
         */
        ...(verdict === "failed" && about !== undefined ? { about } : {}),
      };
    },
  };
}

/**
 * What a `design:` agent is told, and **the whole of it is the three things it
 * may answer** (0058 §3 and §3c, `#265`, `#294`).
 *
 * The reviewer's three fixed blocks are absent because none of them is about a
 * change that has not been written: there is no severity to rate, no finding to
 * hold to a failure scenario, and no diff to read. What is fixed here instead is
 * the one rule an empty answer depends on — *a design nobody needed is a design
 * you do not write* — because a model handed a ticket and asked for a document
 * will produce one for a typo fix, and that document is then in `implement`'s
 * prompt being worked from.
 *
 * **It is asked not to commit, and the asking is not what makes that safe.** This
 * runs in the worktree `implement` will run in, unhooked and writable, so there is
 * nothing here that *stops* a commit — and a prompt is not a guard, because the
 * agent that ignores it is the one a guard is for. What makes a design commit
 * harmless is one line in `firstDispatch` (`packages/conductor/src/conduct.ts`):
 * the receipt 0057 §2 asks for is measured against `startedAt`, the head *this*
 * agent found, rather than against `tree.baseSha`. Measured from the base, a
 * document committed here would have stood in for the implementer's receipt, and a
 * pass that wrote no code would have gone to `build` and `review` with
 * `RunProposedCompletion` naming the drafting agent's commit.
 *
 * So the paragraph in the prompt is there for the money rather than for the
 * correctness: a design agent that edits the tree is one whose turns went
 * somewhere the next agent will not read.
 *
 * **The three states, and the third is the one `#294` added.** Absent, empty and
 * a question: a document, *this change needs no design*, and *I cannot design
 * this until somebody answers X*. The first two were here from the day the step
 * was, and the block that teaches the third is written so it cannot eat the
 * second — a question is announced by a fence and by nothing else, because *the
 * common answer is silence* and a parse that read silence as a question would
 * stop every trivial ticket for a person.
 *
 * **And the bar between a question and a preference is in the prompt rather than
 * in the parse**, because no parse can tell them apart: *I would probably put it
 * in `x.ts`* and *the ticket asks for two incompatible things and does not say
 * which wins* are the same shape to a regular expression and opposite answers to
 * a reader. So the prompt states the test — *what would you have to be told* —
 * and `createDraftAction` takes the agent at its word, which is `parseFindings`'s
 * own rule about severity read the other way round (0031 §1).
 */
export function buildDesignPrompt(
  spec: AgentActionSpec,
  issue: ReviewIssue,
  /**
   * Why this step is being run a second time, or null on the way through.
   *
   * The other half of 0058 §3c's sentence: a judge may answer a design's question
   * with *that step again*, and a design agent handed the round with no memory of
   * asking would ask it again — one round bought, the same question, and a person
   * at the end of it anyway. `sentBackTo` in `packages/conductor/src/pass.ts` is
   * what computes it, off this pass's own visits.
   */
  again: SentBack | null = null,
): string {
  return `You are writing the design note for a change nobody has written yet. You
have the ticket and the worktree it will be made in, and nothing has been
committed. What you write is handed to the agent that does the work, beside the
ticket, and is the only thing it gets from you.

## The ticket

#${issue.ref} — ${issue.title}

${issue.body}

## What to write

The shape of the change: where it goes, what it touches, and the decision that
is not obvious from the ticket. Not the diff, and not a restatement of the
ticket — the agent reading this has the ticket too.

**Answering with nothing is a real answer, and it is the common one.** A change
whose shape is obvious from the ticket does not need a design, and a document
written anyway is a paragraph the implementing agent will work from instead of
from the issue. If this is one of those, reply with nothing at all.

## When the ticket cannot be designed as it stands

Some tickets cannot be answered with a document, however long you read: they ask
for two incompatible things and do not say which wins, or the shape turns on
something only the person who opened it knows. **Ask, rather than writing your
doubts into the document.** A doubt in the document is handed to the agent that
writes the code, which is the one reader who cannot answer it.

To ask, reply with exactly this and nothing else:

\`\`\`question
the one thing somebody has to tell you before you could write the design
\`\`\`

**A question is not a doubt, and the bar is high.** *I would probably put it in
\`x.ts\`* is a design decision — make it, and write it down; that is what this
step is for. *The ticket asks for two incompatible things and does not say which
wins* is a question. The test: if you cannot say what you would have to be
**told** before you could write the document, you do not have a question — you
have a preference, and the document is where preferences go.

One question, not a list, and only where the document is impossible without the
answer. It stops the pass: either a person answers it, or you are asked again and
told to state your assumption instead.

Read whatever you need to in this worktree. **Do not change it**: do not edit a
file, do not run a command that writes one, and do not commit. The agent that
does the work runs in this same worktree after you and starts from what you
return, not from what you left behind — so anything you write here is turns
nobody reads.

Reply with the document and nothing else, or with the \`question\` block and
nothing else: no preamble, no summary of what you read, no offer to continue.
${again === null ? "" : `\n${sentBackBlock(again)}\n`}${spec.prompt ? `\n## Also for this project\n\n${spec.prompt}\n` : ""}`;
}

/**
 * **You asked, somebody answered, and the answer is *design it anyway*** —
 * 0058 §3c's second half, and the only thing that makes it worth more than the
 * first (`#294`).
 *
 * A judge that routes a `needs-input` back to `design` has bought a round, and
 * the round is worth nothing if the agent it buys arrives with no memory of the
 * question: it reads the same ticket, finds the same gap, and asks the same
 * thing. So what the judge said travels, and the instruction it travels with is
 * the one the ADR names — *state your assumption* — because an assumption written
 * into the document is a thing the implementer and the cold reviewer can both see
 * and argue with, where a second question is the pass stopping twice over one
 * ticket.
 *
 * `asked` is null where the round was bought on something other than a question,
 * which at this step is nothing today: `design`'s only route to the router is
 * `needs-input`. It is written for the null anyway, because the field is
 * `SentBack`'s and not this step's.
 */
function sentBackBlock(again: SentBack): string {
  return `## You are at this step a second time

${again.asked === null ? "" : `You asked:\n\n${again.asked}\n\n`}The answer: ${again.why}

**Do not ask again.** Write the design on a stated assumption: say which reading
you took and why, in the document, where the agent that writes the code and the
reviewer that reads it both see it. An assumption on the page is something either
of them can disagree with; a second question is this ticket stopping twice.`;
}

/**
 * **What a design agent answered — and there are three of those, not two**
 * (`#294`).
 *
 * `parseFindings`'s opposite number and deliberately nothing like it in size: a
 * reviewer answers a list of structured things and this answers one of three
 * states, so the contract is a fence rather than a schema. **A question is
 * announced and a document is not**, which is the only arrangement that keeps the
 * state the step already had: *answering with nothing is a real answer, and it is
 * the common one* (`buildDesignPrompt`), so silence has to stay a document — an
 * announced document would make every unannounced empty answer ambiguous, and
 * `""` is the answer a typo fix gives.
 *
 * So the three are told apart by what the answer **is**:
 *
 * ```
 * ""                       the change needs no design          → a document, empty
 * anything else            the design                          → a document
 * a ```question fence      what somebody has to answer first   → a question, and
 *                          whatever stood before it            → its `draft`
 * ```
 *
 * **And the third state keeps what stood before the fence** (`#294`, the fix
 * round). The parse is lenient about *where* the fence is, so what precedes it is
 * whatever the agent wrote before it asked — one sentence where it could not
 * start, and **a finished design note where a model that had both a shape and a
 * doubt emitted both**, which is what the prompt teaching the fence makes likely.
 * Nothing about an answer tells those two apart and nothing needs to: both are
 * `draft`, and the one outcome that must not happen is the document an agent was
 * paid to write reaching no result, no event and nothing but a run log that is
 * deleted when the ticket lands (0034).
 *
 * **And `unreadable` is not a fourth state, it is the absence of one** (`#279`).
 * An answer that opened the fence and never closed it, or closed it around
 * nothing, has announced a question and not asked one — and the branch that does
 * not exist is the one where that silently becomes a document: a design note
 * reading ```` ```question ```` followed by the agent's real difficulty, handed to
 * `implement` as the shape of the change. That is `#279`'s failure in this step's
 * spelling, so it is refused in its own word rather than passed as an empty one.
 */
export type Drafted =
  | { readonly kind: "document"; readonly document: string }
  | { readonly kind: "question"; readonly question: string; readonly draft: string }
  | { readonly kind: "unreadable"; readonly answer: string };

/** The fence that announces a question, on its own line, and nothing else does. */
const OPENS_A_QUESTION = /^[ \t]*```question[ \t]*$/m;
/** The fence that closes it. Any closing fence, because the block holds prose. */
const CLOSES_THE_FENCE = /^[ \t]*```[ \t]*$/m;

/**
 * Which of the three a design agent's answer is. `Drafted` is the argument.
 *
 * Lenient about where the fence appears, for the reason `parseFindings` is
 * lenient about where the JSON is: a model that says *I cannot design this until*
 * and then opens the fence has asked a question, and refusing it over a preamble
 * would spend the turns and throw the answer away. **And the leniency costs
 * nothing, because what it skipped over comes back** — everything before the
 * fence is `draft`, whether that is one sentence of apology or the design note
 * itself, so no reading of *where the fence was* can lose text the agent wrote.
 * Strict about the fence itself, because that is the whole signal — an unclosed
 * one is `unreadable` rather than a document that begins with a code fence.
 */
export function parseDraft(text: string | null): Drafted {
  const answer = (text ?? "").trim();
  // Before the fence is looked for, because silence is a document and the common
  // one: a question is something the agent did, and it did nothing.
  if (answer === "") return { kind: "document", document: "" };

  const opened = OPENS_A_QUESTION.exec(answer);
  if (opened === null) return { kind: "document", document: answer };

  const inside = answer.slice(opened.index + opened[0].length);
  const closed = CLOSES_THE_FENCE.exec(inside);
  if (closed === null) return { kind: "unreadable", answer };
  const question = inside.slice(0, closed.index).trim();
  if (question === "") return { kind: "unreadable", answer };
  // Everything before the fence, and it is not thrown away at any width: a
  // preamble and a whole design note are the same slice.
  return { kind: "question", question, draft: answer.slice(0, opened.index).trim() };
}

/**
 * **The `agent:` at `design`, and it drafts rather than judges** (0065 §4, `#265`).
 *
 * The same plugin key as the reviewer above and a different action, because the
 * two share nothing but a runtime: `createAgentAction` opens by asking for the
 * diff and returns `passed` when there is none, which at `design` is *every*
 * pass — nothing has been committed there — so a `design:` block built out of it
 * would resolve, be printed by `lingtai add`, be drawn on the board and never
 * dispatch anything. That is `#61` with a new spelling, and it is the case
 * [0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §5 says this
 * decision removes rather than one it may add. `actionsFromRecipe` is where the
 * step picks between them.
 *
 * **Five answers** (`pass-steps.ts` before `#265`). A document — including the
 * empty one, which is `passed` and not a skip. A runtime that never started,
 * which is about the account and stands the conductor down (0031 §3). One that
 * started and left no receipt, which buys no round and stands the pass down
 * (0057 §2).
 *
 * **The fourth is `needs-input`, and until `#294` no runtime could reach it.**
 * 0058 §3c names `design` as one of the three steps that may end asking,
 * `ARRIVE_AT_THE_ROUTER` carries `design`, `goesToTheRouter` admits the ending
 * and `the-pass.py` draws the fan — and this function had no branch that produced
 * the token, so a design agent that found the ticket unanswerable had one move:
 * write its doubts into the document and hand them to the implementer, which is
 * the shape the step exists to avoid. That is `#61`'s shape — decided, drawn,
 * routed for, and unreachable.
 *
 * **It arrives in the answer and not through the hook**, which is the difference
 * between this step and `implement`. An implementer is a long run that may need to
 * stop mid-flight, so `hook-socket.ts` appends `RunAwaitingInput` and
 * `work-action.ts` turns `asked` into this same token. A design agent is one
 * question and one answer, and it runs `unhookedSettings` — the call the cold
 * reviewer gets — so hooking it would change what the step *is* as well as what it
 * can say. Its shape is `review`'s: an answer the action parses (`parseDraft`).
 *
 * **The fifth is `unreadable`, and it is the one that must not be quiet**
 * (`#279`). An answer that announced a question and did not carry one is not an
 * empty document, and the difference is what reaches `implement`.
 *
 * There is no sixth: a design is not a judgement about a diff, there being no
 * diff, so `design` is not one of `REFUSING_STEPS` — which is why the `failed`
 * this returns for an unreadable answer arrives at the step as a `did-not-finish`
 * (`endingOf` in `pass.ts`) and buys nothing, exactly as `#279` wants.
 */
export function createDraftAction(spec: AgentActionSpec, deps: AgentActionDeps): Action {
  return {
    name: spec.name,
    kind: "agent",

    async run(context: ActionContext): Promise<ActionResult> {
      const issue = await deps.issue();
      // **Not** `context.runId`, for the reviewer's reason one function up: the
      // session id is derived from it, so reusing it would resume the
      // implementer's session — and here it would resume a session that has not
      // happened yet, which is the same mistake read backwards.
      const draftId = `${context.runId}:design:${spec.name}`;
      context.log?.note("design", `${draftId} · drafting for #${issue.ref}`);
      const outcome = await deps.runtime.run({
        runId: draftId,
        cwd: context.cwd,
        // `context.again` is the pass's own fold over its visits (`sentBackTo`),
        // and it is null on every way through — which is every pass but one a
        // judge sent back here.
        prompt: buildDesignPrompt(spec, issue, context.again ?? null),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        settingsPath: deps.settingsPath,
        log: context.log,
        traceTools: true,
        env: context.env,
        limits: deps.limits,
        signal: context.signal,
      });

      if (outcome.failure) {
        // The adapter's classification and never a second reading of it
        // (0031 §1), exactly as the reviewer above: at most one turn, no cost
        // and an error is `never-started`, and everything else started.
        if (outcome.failure.kind === "never-started") {
          return { verdict: "never-ran", evidence: boundedEvidence(outcome.failure.detail), findings: [] };
        }
        return {
          verdict: "did-not-finish",
          evidence: boundedEvidence(
            `the design agent did not finish (${outcome.failure.kind}): ${outcome.failure.detail}`,
          ),
          findings: [],
        };
      }

      const drafted = parseDraft(outcome.text);
      const cost = outcome.costUsd === null ? "" : ` · $${outcome.costUsd.toFixed(2)}`;

      if (drafted.kind === "question") {
        /**
         * **0058 §3c, reachable** (`#294`). `did-not-finish` and not `failed`: the
         * agent judged nothing, so no round is charged for the asking, and
         * `because` is what carries it past `goesToTheRouter` to `proposed` —
         * where `BUILT_IN_FOR["needs-input"]` is null, so a person holds it with
         * the question unless a recipe declared a judge for the direction.
         *
         * **The question first on `evidence`, with no turn count spliced in.**
         * This string is three things at once: the sentence a person reads off the
         * card, the evidence a judge weighs, and — where the judge sends the pass
         * back here — `SentBack.asked`, which is quoted verbatim into the next
         * design prompt. A cost appended to it would be read back to an agent as
         * part of its own question. `createWorkAction` carries `asked` the same
         * bare way, and what the turns cost is on the run log.
         *
         * **And the draft rides with it, under a rule, where the agent wrote one**
         * (`#294`, the fix round). `WroteTheDesign` in `pass.ts` is *only on a
         * pass* and `StepDidNotFinish` carries one field, so `evidence` is the one
         * channel a question's draft can reach both a person and the log through —
         * and a design note that reached neither would be in nothing but the run
         * log, which 0034 deletes when the ticket lands. The question leads because
         * the question is what has to be answered; the draft follows because an
         * agent that wrote one and asked anyway has told its reader, its judge and
         * the round it may buy something all three of them want. Absent, and not
         * an empty rule, where it asked and wrote nothing.
         */
        return {
          verdict: "did-not-finish",
          because: NEEDS_INPUT,
          evidence: boundedEvidence(
            drafted.draft === ""
              ? drafted.question
              : `${drafted.question}\n\n---\n\nWhat it had written before it asked:\n\n${drafted.draft}`,
          ),
          findings: [],
        };
      }

      if (drafted.kind === "unreadable") {
        /**
         * The reviewer's branch one function up, in this step's spelling
         * (`#279`): an announced question that was never asked is neither of the
         * two answers, and the branch that does not exist is the one where it
         * becomes a silently empty document — or worse, a document whose first
         * line is a fence and whose body is the difficulty the agent could not
         * state.
         *
         * `failed` and `unreadable: true` rather than a bare `did-not-finish`,
         * because the flag is what a log can be asked and a sentence is not. It
         * costs nothing extra: `design` does not refuse (`REFUSING_STEPS`), so
         * `endingOf` reports the step `did-not-finish` with no route to the
         * router, and the pass rests for a person carrying the answer.
         */
        return {
          verdict: "failed",
          evidence: boundedEvidence(
            "the design agent announced a question and did not ask one — the `question` block was " +
              `empty or never closed, so the answer is neither a design nor a question:\n${drafted.answer}`,
          ),
          findings: [],
          unreadable: true,
        };
      }

      const document = drafted.document;
      return {
        verdict: "passed",
        // The distinction the board wants and `implement` does not: an empty
        // document and a document are one brief to the agent — it works from
        // the issue either way — and two different things to a person reading
        // what this pass spent its turns on.
        evidence: boundedEvidence(
          (document === "" ? "no design: this change needs none" : document) +
            `\n\n(${outcome.turns} turns${cost})`,
        ),
        findings: [],
        document,
      };
    },
  };
}
