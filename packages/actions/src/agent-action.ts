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
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
 * A refusal buys an agent that is handed the findings, and then this runs again
 * on the head that agent produced — with `ActionContext.recheck` carrying the
 * findings it was given. Not a second kind of action: the rubric, the checklist
 * and the contract are the same, and the only addition is the question a fix
 * makes possible to ask wrongly — *does that sequence still produce that
 * outcome*, rather than *is that sentence still in my output*. See
 * `recheckBlock`.
 */
import type { Runtime } from "@lingtai/agent";
import { SEVERITIES, type Severity } from "@lingtai/domain";
import {
  NEEDS_INPUT,
  type Action,
  type ActionContext,
  type ActionFinding,
  type ActionResult,
  type SentBack,
} from "./action.ts";

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
   * ([0029](../../../doc/decisions/0029-the-prompt-budget-is-the-recipes.md)),
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
  /**
   * **The dispatch the `agent:` at `implement` runs** — as the conductor already
   * calls it (0065 §2, `#266`).
   *
   * Beside `runtime` rather than built out of it, and that is the whole shape of
   * this row: the reviewer and the draft spawn a runtime and read what it said,
   * and the implementer's dispatch is the hook wired and proven to fail closed,
   * the socket served, `RunStarted` and `RunFinished` on the run's own stream,
   * the diff recorded, and the receipt measured against the head *this* agent
   * found. None of that is something the actions package can learn — it is the
   * same reason `worktree:` is handed a cut and `merge:` a lane.
   *
   * Optional for `ActionDeps`'s reason — `lingtai doctor` and the config tests
   * build actions purely to check that a recipe *can* be built, and have no
   * machine to dispatch on — and absent it refuses an `agent:` **at `implement`**
   * by name rather than becoming a step that passed having written no code. Every
   * other step this key serves reads a diff or writes a document and needs none
   * of it, which is why the refusal is the step's and not this object's:
   * `ImplementActionDeps` below is where it stops being optional.
   */
  work?: (brief: WorkBrief) => Promise<WorkedAnswer>;
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
Report as a single JSON object, and nothing else after it:

{"findings":[{"file":"src/x.ts","line":42,"severity":"blocker",
  "claim":"one sentence, what is wrong",
  "failureScenario":"concrete inputs or interleaving, then the wrong outcome"}]}

Rules:
- **No failure scenario, no finding.** If you cannot write the concrete sequence
  that produces a wrong outcome, you do not have a finding, you have an opinion.
  Leave it out.
- \`line\` may be null if the defect is the absence of something.
- Report findings only. Do not propose the fix — a remedy that differs from the
  one eventually taken is not a miss, and prescribing costs you attention you
  should spend finding.
- An empty list is a real answer. Say {"findings":[]}.

Do not read other issues, run \`gh\`, or look at anything outside this worktree
and the diff above. Your value is that you do not know what anyone concluded.`;

export interface ReviewIssue {
  ref: string;
  title: string;
  body: string;
}

/**
 * The block that makes a re-review a re-review
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
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

## How to report
${CONTRACT}

${spec.prompt ? `## Also for this project\n\n${spec.prompt}\n` : ""}
${recheck.length > 0 ? `${recheckBlock(recheck)}\n\n` : ""}## The diff

\`\`\`diff
${clipped}
\`\`\`
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
export function parseFindings(text: string | null): { findings: ActionFinding[]; parsed: boolean } {
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
    return { findings, parsed: true };
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
         * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §1
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
            evidence: outcome.failure.detail,
            findings: [],
          };
        }
        /**
         * **And a reviewer that *started* and did not finish has not reviewed
         * anything either** — [0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §1.
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
          evidence: `the reviewer did not finish (${outcome.failure.kind}): ${outcome.failure.detail}`,
          findings: [],
        };
      }

      const { findings, parsed } = parseFindings(outcome.text);
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
          evidence: `the reviewer's answer was not readable as findings:\n${(outcome.text ?? "").slice(0, 2_000)}`,
          findings: [],
          unreadable: true,
        };
      }

      const verdict = verdictFor(findings);
      const cost = outcome.costUsd === null ? "" : ` · $${outcome.costUsd.toFixed(2)}`;
      return {
        verdict,
        evidence: `${summarise(findings)}\n\n(${outcome.turns} turns${cost})`,
        findings,
      };
    },
  };
}

/**
 * What a `design:` agent is told, and **the whole of it is that it may answer
 * nothing** (0058 §3, `#265`).
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
 */
export function buildDesignPrompt(spec: AgentActionSpec, issue: ReviewIssue): string {
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

Read whatever you need to in this worktree. **Do not change it**: do not edit a
file, do not run a command that writes one, and do not commit. The agent that
does the work runs in this same worktree after you and starts from what you
return, not from what you left behind — so anything you write here is turns
nobody reads.

Reply with the document and nothing else: no preamble, no summary of what you
read, no offer to continue.
${spec.prompt ? `\n## Also for this project\n\n${spec.prompt}\n` : ""}`;
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
 * [0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §5 says this
 * decision removes rather than one it may add. `actionsFromRecipe` is where the
 * step picks between them.
 *
 * **Three answers, and they are three of the body's four** (`pass-steps.ts` before
 * `#265`). A document — including the empty one, which is `passed` and not a skip.
 * A runtime that never started, which is about the account and stands the
 * conductor down (0031 §3). One that started and left no receipt, which buys no
 * round and stands the pass down (0057 §2).
 *
 * **The fourth was `asked`, and no runtime could reach it.** `Drafted` carried an
 * `Asked` case for 0058 §3b's edge — `design` is on `ARRIVE_AT_THE_ROUTER`, so a
 * question there would have bought a decision at `proposed` — and the live port
 * that fed it returned `{ document: "" }` and nothing else, so the case was never
 * once constructed in this repository's log. An `ActionResult` has no shape for a
 * question, only `needs-approval`, which holds for a person rather than asking a
 * judge; giving one to this kind is a decision about the whole plugin system and
 * not about `design`. Until somebody makes it, a design agent with a question
 * writes it in the document, which is the thing `implement` reads.
 *
 * There is no fifth either way: a design is not a judgement about a diff, there
 * being no diff, so this action cannot refuse and `design` is not one of
 * `REFUSING_STEPS`.
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
        prompt: buildDesignPrompt(spec, issue),
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
          return { verdict: "never-ran", evidence: outcome.failure.detail, findings: [] };
        }
        return {
          verdict: "did-not-finish",
          evidence: `the design agent did not finish (${outcome.failure.kind}): ${outcome.failure.detail}`,
          findings: [],
        };
      }

      const document = (outcome.text ?? "").trim();
      const cost = outcome.costUsd === null ? "" : ` · $${outcome.costUsd.toFixed(2)}`;
      return {
        verdict: "passed",
        // The distinction the board wants and `implement` does not: an empty
        // document and a document are one brief to the agent — it works from
        // the issue either way — and two different things to a person reading
        // what this pass spent its turns on.
        evidence:
          (document === "" ? "no design: this change needs none" : document) +
          `\n\n(${outcome.turns} turns${cost})`,
        findings: [],
        document,
      };
    },
  };
}

/**
 * **What the one agent at `implement` did in that worktree** — four answers, and
 * the money is why they are four (`#266`).
 *
 * It was `Worked` in `packages/conductor/src/pass-steps.ts`, answered by a port
 * the body called. `agentPlugin` declares `implement` since 0065 §2, so the four
 * arrive here instead and `createImplementAction` is what turns each into a
 * verdict. Nothing about what they *cost* moved: that is `endingOf`'s, one layer
 * up, and each of the four maps onto an ending the pass already had a rule for.
 */
export type WorkedAnswer =
  /** The commit it left the worktree at — the whole of what moves `onSha`. */
  | { readonly committed: string }
  /** It stopped and asked. 0058 §3c: this buys a decision at `proposed`. */
  | { readonly asked: string }
  /** The wall that is about the account rather than the diff (0031 §1). */
  | { readonly neverStarted: { readonly agent: string; readonly detail: string } }
  /** It started and left no receipt — a crash, a spent budget, no commit (0057 §2). */
  | { readonly stopped: string };

/**
 * What the implementing agent is handed, as the only thing this action needs
 * from its caller beyond the dispatch itself.
 *
 * `Brief` in `pass-steps.ts` was the same four facts and is gone with the port.
 * The three that are not the action's own — the issue, the design and the round
 * — are read here rather than remembered: `deps.issue()` is the reviewer's own
 * row, and `design` and `again` are on the context the walk rebuilt for this
 * visit (`ActionContext`).
 */
export interface WorkBrief {
  /** Which runtime, which model and the project's own words — the recipe's entry. */
  readonly spec: AgentActionSpec;
  /** The ticket, exactly as `deps.issue()` answers it. */
  readonly issue: ReviewIssue;
  /** What `design` wrote, and `""` where it wrote nothing. `ActionContext.design`. */
  readonly design: string;
  /** Why this is the second time, or null on the way through. `ActionContext.again`. */
  readonly again: SentBack | null;
  /** The head it is working from, the round it is in, and what that round was bought on. */
  readonly context: ActionContext;
}

/**
 * **The `agent:` at `implement`, and it writes the code** (0065 §2, `#266`).
 *
 * The third action this one plugin key builds, and the step is what picks
 * (`from-recipe.ts`): a reviewer reads a diff, a draft writes a document, and
 * this one commits. Built apart from `createAgentAction` for `createDraftAction`'s
 * reason and a stronger one — the reviewer opens by asking for the diff and
 * returns `passed` when there is none, which at the step that *makes* the diff is
 * every first pass.
 *
 * **It wraps and does not reimplement.** The dispatch is `conduct.ts`'s —
 * the hook wired and proven to fail closed, the runtime spawned in the worktree,
 * `RunStarted`/`RunFinished` on the log, and the receipt measured against the
 * head this agent found — and the caller hands it over as `AgentActionDeps.work`
 * for the reason `worktree:` is handed a cut: only a caller with a machine under
 * it can build one.
 *
 * **It reports the `head` it committed, and that is the whole of what moves
 * `onSha` on a fix round.** `ActionResult.head` is the same field `worktree:`
 * fills at `admit`, `headFrom` reads it on the passing branch, and `runPass`
 * advances the walk's `onSha` to it — so a round is judged against the diff this
 * agent wrote rather than against the base the tree was cut at. That property is
 * older than the plugin and survives it unchanged.
 *
 * **Four answers, and three of them are not verdicts about the change.** A
 * question is a `failed` carrying `NEEDS_INPUT`, which at a step
 * `REFUSING_STEPS` does not carry is read by `endingOf` as a `did-not-finish`
 * with that token — exactly the ending `asking()` built by hand, with the
 * action's name where that wrote `null`. A runtime that never started is
 * `never-ran` and stands the *conductor* down (0031 §3). One that started and
 * left no receipt is `did-not-finish` and stands the pass down (0057 §2), buying
 * no round.
 *
 * There is no fifth: `implement` is not one of `REFUSING_STEPS`, so this cannot
 * refuse, and 0058 §3b's rectangle is what says why — arriving at the router and
 * refusing are different things, and only one of them is charged for.
 */
export interface ImplementActionDeps extends AgentActionDeps {
  work: NonNullable<AgentActionDeps["work"]>;
}

export function createImplementAction(spec: AgentActionSpec, deps: ImplementActionDeps): Action {
  return {
    name: spec.name,
    kind: "agent",

    async run(context: ActionContext): Promise<ActionResult> {
      const issue = await deps.issue();
      const answer = await deps.work({
        spec,
        issue,
        // `??` and not a default the caller could omit meaning: `""` is a design
        // that ran and answered nothing, and the absence is a pass that never
        // reached the step. Both are the same brief (0058 §3).
        design: context.design ?? "",
        again: context.again ?? null,
        context,
      });

      if ("committed" in answer) {
        return {
          verdict: "passed",
          evidence: `committed ${answer.committed.slice(0, 7)}`,
          findings: [],
          head: answer.committed,
        };
      }
      if ("asked" in answer) {
        return {
          verdict: "failed",
          // The question, in the agent's own words, because that is what the
          // judge at `proposed` weighs and what a person reads (0043).
          evidence: answer.asked,
          findings: [],
          // **The token, and the whole of why this is a `failed` rather than a
          // `needs-approval`.** A hold reaches a person directly; 0058 §3c sends
          // a question to `proposed`, which decides whether a person is worth
          // interrupting or whether the agent goes round again stating its
          // assumption. `implement` does not refuse, so `endingOf` reads this as
          // the `did-not-finish` that carries the token — and `goesToTheRouter`
          // is what reads it.
          because: NEEDS_INPUT,
        };
      }
      if ("neverStarted" in answer) {
        // The runtime's own words, whole, exactly as the reviewer and the draft
        // hand them on: `conduct.ts` reads a reset time out of them (0031 §4).
        return { verdict: "never-ran", evidence: answer.neverStarted.detail, findings: [] };
      }
      return { verdict: "did-not-finish", evidence: answer.stopped, findings: [] };
    },
  };
}
