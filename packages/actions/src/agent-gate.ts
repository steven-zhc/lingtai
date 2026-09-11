/**
 * The agent gate: a second agent, cold.
 *
 * This is the gate experiment 001 was run to justify, and it earned its place.
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
 * that one shape. The experiment is explicit that this tests *the gate as
 * designed* rather than a generic reviewer, so the checklist is part of the
 * gate, not part of the configuration.
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
 * **And the same gate is what checks a fix**
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
 * A refusal buys an agent that is handed the findings, and then this runs again
 * on the head that agent produced — with `GateContext.recheck` carrying the
 * findings it was given. Not a second kind of gate: the rubric, the checklist
 * and the contract are the same, and the only addition is the question a fix
 * makes possible to ask wrongly — *does that sequence still produce that
 * outcome*, rather than *is that sentence still in my output*. See
 * `recheckBlock`.
 */
import type { Runtime } from "@lingtai/agent";
import type { Gate, GateContext, GateFinding, GateResult } from "./gate.ts";

export interface AgentGateSpec {
  name: string;
  /** Appended to the fixed brief. Adds concerns; cannot remove them. */
  prompt: string;
}

export interface AgentGateDeps {
  runtime: Runtime;
  /** The ticket, exactly as the implementer received it. Fetched lazily so a
   *  recipe without an agent gate costs no API call. */
  issue: () => Promise<{ ref: string; title: string; body: string }>;
  /** The diff under review, `base...head`. Supplied by the caller: the gates
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
function recheckBlock(findings: readonly GateFinding[]): string {
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
  spec: AgentGateSpec,
  issue: ReviewIssue,
  diff: string,
  limitBytes: number,
  recheck: readonly GateFinding[] = [],
): string {
  const clipped =
    diff.length > limitBytes
      ? `${diff.slice(0, limitBytes)}\n\n[diff truncated at ${limitBytes} bytes]`
      : diff;

  return `You are reviewing a change you did not write. You have the ticket and the
diff, and deliberately nothing else — no plan, no transcript, no reasoning from
whoever wrote it. That is the point: this exists because self-review after a
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
 */
export function parseFindings(text: string | null): { findings: GateFinding[]; parsed: boolean } {
  if (!text) return { findings: [], parsed: false };

  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) candidates.push(block.replace(/```(?:json)?/g, "").replace(/```/g, ""));
  const brace = text.indexOf("{");
  if (brace >= 0) candidates.push(text.slice(brace));
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

    const findings: GateFinding[] = [];
    for (const raw of list) {
      const f = raw as Partial<GateFinding>;
      // The rule from the prompt, enforced.
      if (!f?.claim || !f?.failureScenario) continue;
      findings.push({
        file: String(f.file ?? "(unknown)"),
        line: typeof f.line === "number" ? f.line : null,
        claim: String(f.claim),
        failureScenario: String(f.failureScenario),
        severity:
          f.severity === "blocker" || f.severity === "major" || f.severity === "minor"
            ? f.severity
            : // Unrecognised means the rubric was not followed, and the rubric
              // exists because severity ran *low*. Take the higher one.
              "blocker",
      });
    }
    return { findings, parsed: true };
  }

  return { findings: [], parsed: false };
}

/** Blocker or major refuses. A minor is worth knowing and not worth stopping for. */
export function verdictFor(findings: readonly GateFinding[]): "passed" | "failed" {
  return findings.some((f) => f.severity === "blocker" || f.severity === "major")
    ? "failed"
    : "passed";
}

function summarise(findings: readonly GateFinding[]): string {
  if (findings.length === 0) return "no findings";
  return findings
    .map((f) => `${f.severity} ${f.file}${f.line === null ? "" : `:${f.line}`} — ${f.claim}`)
    .join("\n");
}

export function createAgentGate(spec: AgentGateSpec, deps: AgentGateDeps): Gate {
  return {
    name: spec.name,
    kind: "agent",

    async run(context: GateContext): Promise<GateResult> {
      const diff = await deps.diff();
      if (!diff.trim()) {
        // Nothing to review is not the same as nothing wrong, and saying so is
        // cheaper than an agent call that reads an empty diff.
        return { verdict: "passed", evidence: "the diff is empty; nothing to review", findings: [] };
      }

      const issue = await deps.issue();
      const recheck = context.recheck ?? [];
      const outcome = await deps.runtime.run({
        // **Not** `context.runId`. The session id is derived from it, so reusing
        // it would resume the implementer's session and make this a warm review
        // wearing a cold review's name.
        //
        // A re-review gets an id of its own for the same reason *again*: a
        // second review that resumed the first one would be a reviewer asked
        // whether it still agrees with itself, which is the warm-review failure
        // experiment 001 measured, one level up (0038 §2).
        runId:
          recheck.length === 0
            ? `${context.runId}:review:${spec.name}`
            : `${context.runId}:review:${spec.name}:recheck:${context.onSha.slice(0, 7)}`,
        cwd: context.cwd,
        prompt: buildReviewPrompt(spec, issue, diff, deps.limits.diffBytes, recheck),
        settingsPath: deps.settingsPath,
        env: context.env,
        limits: deps.limits,
        signal: context.signal,
      });

      if (outcome.failure) {
        return {
          verdict: "failed",
          evidence: `the reviewer did not finish (${outcome.failure.kind}): ${outcome.failure.detail}`,
          findings: [],
        };
      }

      const { findings, parsed } = parseFindings(outcome.text);
      if (!parsed) {
        // A reviewer whose answer cannot be read has not reviewed anything. The
        // alternative is a green gate for a diff nobody assessed.
        return {
          verdict: "failed",
          evidence: `the reviewer's answer was not readable as findings:\n${(outcome.text ?? "").slice(0, 2_000)}`,
          findings: [],
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
