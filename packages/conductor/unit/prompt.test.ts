/**
 * What the next attempt will be handed — the thing `#104` puts on the page.
 *
 * The claims here are the ones that make showing the prompt worth anything.
 * A page that composes an *approximation* of the document is worse than a page
 * that shows nothing, because it invites somebody to approve a prompt that is
 * not the one that runs; so what is asserted is that one function produces
 * both, that a person's sentence reaches it, and that the version says so.
 *
 * Unit, under `--project unit`: this is a fold over envelopes plus three
 * string joins, and a composition that needed a database would be the wrong
 * shape.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Envelope,
  type EventType,
  type PayloadOf,
  SCHEMA_VER,
  parsePayload,
} from "@lingtai/domain";
import type { PromptBudget } from "../src/attempts.ts";
import { editHash, nextPrompt, renderPrompt } from "../src/prompt.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The recipe's defaults (0029), spelled out for the reason `attempts.test.ts` gives. */
const BUDGET: PromptBudget = { evidence: 2_000, attempts: 5, findings: 5 };

let seq = 1n;

function stream(streamId: string) {
  let version = 0;
  return function event<T extends EventType>(type: T, data: PayloadOf<T>): Envelope {
    version += 1;
    return {
      seq: seq++,
      streamId,
      version,
      type,
      schemaVer: SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: "conductor",
      causation: null,
      at: new Date("2026-09-09T04:12:15.000Z"),
    };
  };
}

const discovered: PayloadOf<"WorkItemDiscovered"> = {
  project: "lingtai",
  source: "github-issue",
  externalRef: "104",
  title: "Approving a blocked item is yes or no",
  kind: "feature",
  labels: ["feature"],
};

const claim = (runId: string): PayloadOf<"WorkItemClaimed"> => ({
  runId,
  worker: "conductor",
  title: "Approving a blocked item is yes or no",
  kind: "feature",
});

const edit = (text: string): PayloadOf<"PromptEdited"> => ({
  text,
  hash: text.trim() === "" ? null : editHash(text),
  by: "human:steven",
  basedOn: "ticket@1924",
  chatId: null,
});

const TICKET = { number: 104, title: "The control is the prompt", body: "the body" };
const TEMPLATE = "#{{issue}} — {{title}}\n\n{{body}}\n\n{{failure}}";

describe("the next attempt's prompt", () => {
  /**
   * The criterion `#82` set and this must not undo: a first attempt with no
   * edit renders byte-identically to the template. `{{failure}}` filled with an
   * empty string is a prompt this feature never touched.
   */
  it("is the template alone on a first attempt nobody has edited, except the checks block that always renders", () => {
    const e = stream("wi-lingtai-104");
    const next = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [e("WorkItemDiscovered", discovered)],
      lastRun: null,
    });

    expect(next.attempt).toBe(1);
    expect(next.failure).toBe("");
    expect(next.version).toBe("ticket@1924");
    // **This is no longer byte-identical to the template** (`#319`): unlike
    // `{{failure}}` and `{{design}}`, `{{checks}}` never renders blank — even a
    // first attempt nobody has edited is told the bar and told not to wait on
    // anything slower than this turn, because that silence is what `#249` and
    // `#308` were lost to. What this still asserts is the part of `#82`'s
    // criterion that survives: nothing about the ticket or the history is added
    // beyond that one block.
    const text = renderPrompt(TEMPLATE, TICKET, [], next.failure);
    expect(text.startsWith("#104 — The control is the prompt\n\nthe body\n\n")).toBe(true);
    expect(text).toContain("## What `build` checks, and what it does not");
    expect(text).toMatch(/commit it before you verify/i);
  });

  it("carries an answer given before any run into every attempt, without the issue body", () => {
    const e = stream("wi-lingtai-51");
    const asked = e("WorkItemBlocked", {
      question: "Which of the three designs for the production-credential tripwire?",
      needsFrom: "human",
      runId: null,
      needs: "judgement",
      diagnosis: null,
    });
    const answered = e("WorkItemUnblocked", { by: "human:steven", note: "the second: refuse at the hook" });

    const first = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [e("WorkItemDiscovered", discovered), asked, answered],
      lastRun: null,
    });
    const text = renderPrompt(TEMPLATE, TICKET, [], first.failure);
    expect(text).toContain("## Decided before any run");
    expect(text).toContain("**Asked:** Which of the three designs for the production-credential tripwire?");
    expect(text).toContain("**Answered by human:steven:** the second: refuse at the hook");
    // The ticket's body is untouched: the answer came off the log.
    expect(text).toContain("the body");
    // Lingtai composed it, so it is not an edit and is inside `composed`.
    expect(first.edit).toBeNull();
    expect(first.composed.failure).toBe(first.failure);
    expect(first.version).not.toBe("ticket@1924");

    // A claim consumes an edit and not a decision: the second attempt is told too.
    const second = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [
        e("WorkItemDiscovered", discovered),
        asked,
        answered,
        e("WorkItemClaimed", claim("run-a")),
        e("WorkItemReleased", { runId: "run-a", reason: "killed" }),
      ],
      lastRun: null,
    });
    expect(second.failure).toContain("the second: refuse at the hook");
  });

  it("does not carry a requeue's note, which answered an attempt and not the ticket", () => {
    const e = stream("wi-lingtai-51b");
    const next = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [
        e("WorkItemDiscovered", discovered),
        e("WorkItemClaimed", claim("run-a")),
        e("WorkItemBlocked", {
          question: "conflict: agent/51 does not merge into main",
          needsFrom: "human",
          runId: "run-a",
          needs: "acknowledgement",
          diagnosis: null,
        }),
        e("WorkItemUnblocked", { by: "human:steven", note: "the base has moved" }),
      ],
      lastRun: null,
    });
    expect(next.failure).not.toContain("Decided before any run");
  });

  /**
   * The sentence reaches the agent, inside a block that names who wrote it and
   * says how long it lasts. An edit that composed cleanly and silently did not
   * reach the run would be a control the page claims and the code does not
   * have — `#58`'s shape.
   */
  it("carries a person's sentence into the document, naming them and its bound", () => {
    const e = stream("wi-lingtai-104b");
    const next = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [
        e("WorkItemDiscovered", discovered),
        e("PromptEdited", edit("`claude --help` does not list it. Read the bundle.")),
      ],
      lastRun: null,
    });

    expect(next.edit).toEqual({
      text: "`claude --help` does not list it. Read the bundle.",
      by: "human:steven",
    });
    const text = renderPrompt(TEMPLATE, TICKET, [], next.failure);
    expect(text).toContain("## Added for this attempt by human:steven");
    expect(text).toContain("`claude --help` does not list it. Read the bundle.");
    expect(text).toContain("It applies to this attempt only.");
  });

  /**
   * **The part that cannot be skipped** (0032 §5). Without it two runs share a
   * `promptVersion` and did not share a prompt, and the log is lying about what
   * produced a result. The hash is of the final text, and it is the same number
   * `PromptEdited.hash` carries.
   */
  it("names the edit in the version, and never reads as the unedited one", () => {
    const e = stream("wi-lingtai-104c");
    const item = [e("WorkItemDiscovered", discovered), e("PromptEdited", edit("pass --max-turns"))];
    const next = nextPrompt({ base: "ticket@1924", budget: BUDGET, item, lastRun: null });

    // Both parts move, and that is right rather than redundant. The edit is a
    // block *inside* `{{failure}}`, so a first attempt that carries one has a
    // failure block where an unedited one has none — and `human@` is what says
    // which of the two kinds put it there (0032 §5).
    expect(next.version).toMatch(
      new RegExp(`^ticket@1924\\+failure@[0-9a-f]{12}\\+human@${editHash("pass --max-turns")}$`),
    );
    expect(next.composed.version).toBe("ticket@1924");
    expect(next.version).not.toBe(next.composed.version);
  });

  /**
   * The removal. `reduceWorkItem` clears `pendingPrompt` on a blank edit, so
   * the version falls back to today's form rather than carrying a `human@…` for
   * a block the agent was never shown.
   */
  it("falls back to the unedited version once the edit is taken back off", () => {
    const e = stream("wi-lingtai-104d");
    const next = nextPrompt({
      base: "ticket@1924",
      budget: BUDGET,
      item: [
        e("WorkItemDiscovered", discovered),
        e("PromptEdited", edit("pass --max-turns")),
        e("PromptEdited", edit("   ")),
      ],
      lastRun: null,
    });

    expect(next.edit).toBeNull();
    expect(next.version).toBe("ticket@1924");
    expect(next.failure).toBe("");
  });

  /**
   * `composed` is what Lingtai wrote on its own, and it is what the page diffs
   * against and what an edit records as `basedOn`. It still carries the history
   * — the thing being separated out is the human's sentence and nothing else.
   */
  it("keeps the history in what it composed, and only the sentence out of it", () => {
    const e = stream("wi-lingtai-104e");
    const item = [
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", claim("run-1")),
      e("WorkItemReleased", { runId: "run-1", reason: "the build refused" }),
      e("PromptEdited", edit("the flag is in the binary, not in --help")),
    ];
    const next = nextPrompt({ base: "ticket@1924", budget: BUDGET, item, lastRun: [] });

    expect(next.attempt).toBe(2);
    expect(next.composed.failure).toContain("This ticket has been attempted once already");
    expect(next.composed.failure).not.toContain("Added for this attempt");
    expect(next.failure).toContain("This ticket has been attempted once already");
    expect(next.failure).toContain("Added for this attempt");
    // Both blocks are in `failure`, so the version has to say which of the two
    // kinds moved: the failure fingerprint is the same and the human's is not.
    expect(next.composed.version).toMatch(/^ticket@1924\+failure@[0-9a-f]{12}$/);
    expect(next.version.startsWith(next.composed.version)).toBe(false);
    expect(next.version).toContain(`human@${editHash("the flag is in the binary, not in --help")}`);
  });

  /**
   * An empty stream says the attempt committed nothing; `null` says nobody
   * looked. `attemptBrief` prints the first in as many words, and printing it
   * about a run nobody read would be an invention in a prompt.
   */
  it("distinguishes an attempt that produced nothing from one nobody read", () => {
    const e = stream("wi-lingtai-104f");
    const item = [
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", claim("run-1")),
      e("WorkItemReleased", { runId: "run-1", reason: "timeout" }),
    ];

    const read = nextPrompt({ base: "ticket@1924", budget: BUDGET, item, lastRun: [] });
    const unread = nextPrompt({ base: "ticket@1924", budget: BUDGET, item, lastRun: null });

    expect(read.failure).toContain("It committed no change");
    expect(unread.failure).not.toContain("It committed no change");
  });

  /**
   * **The document `design` produced reaches the agent that does the work**
   * (`#265`, 0058 §3).
   *
   * `Brief.design` was on the brief from the day the brief existed and the live
   * dispatch never read it, which cost nothing while the port that filled it
   * answered `""` on every pass. `agentPlugin` serves `design` now, so a recipe can
   * buy a document there — and a document nothing hands on is an agent run bought by
   * a line in the recipe whose answer no reader sees. So the claim is the one the
   * `{{failure}}` rule already makes for the attempt history: **a template with no
   * slot gets it appended rather than losing it.**
   *
   * `TEMPLATE` above carries `{{failure}}` and no `{{design}}`, which is both halves
   * in one fixture: the history goes in its slot and the design is appended.
   */
  it("hands the design to the implementer, in its slot or appended", () => {
    const design = "Put it in `packages/recipe`, beside `whyNoKindAt`.";

    const appended = renderPrompt(TEMPLATE, TICKET, [], "", design);
    expect(appended).toContain("## The design, written for this run before any code");
    expect(appended).toContain(design);
    // What it is *not*: an instruction that outranks the ticket.
    expect(appended).toContain("the ticket is what was asked for");

    // In the slot where a template has one, and then not appended a second time.
    const slotted = renderPrompt(`${TEMPLATE}\n{{design}}`, TICKET, [], "", design);
    expect(slotted.match(/## The design, written for this run/g)).toHaveLength(1);

    // And the two blocks compose in reading order: the design is about the change,
    // the history is about the attempts at it.
    const both = renderPrompt("#{{issue}}", TICKET, [], "## What the last attempt did", design);
    expect(both.indexOf("## The design")).toBeLessThan(both.indexOf("## What the last attempt did"));

    /**
     * **And an empty design changes nothing**, which is every pass today: no recipe
     * declares a `design:` and `defaultsAt` has no row for the step, so an
     * unconfigured one runs nothing and this renders what it always rendered. This
     * asserts the two arities agree, so the parameter cannot drift into meaning
     * something absent.
     */
    for (const blank of ["", "   \n\n  "]) {
      expect(renderPrompt(TEMPLATE, TICKET, [], "", blank)).toBe(renderPrompt(TEMPLATE, TICKET, [], ""));
      expect(renderPrompt(TEMPLATE, TICKET, [], "", blank)).not.toContain("## The design");
    }
  });

  /**
   * **`#319`.** `#249` ran the integration suite as part of doing a ticket and
   * was killed at its timeout with no commit at all. `#308` finished the work,
   * verified the real gate was green, started a suite the gate does not run,
   * scheduled a wakeup to check on it, and was terminated under that wakeup —
   * $13.17 and eight fixed findings, gone with the worktree. The rule that would
   * have stopped both lived in `CLAUDE.md`, which an agent may or may not read;
   * `{{checks}}` is how it reaches the brief every agent is actually handed.
   */
  describe("the checks block renderPrompt always adds", () => {
    it("names the build step's own commands as the whole of the bar", () => {
      const text = renderPrompt(TEMPLATE, TICKET, ["pnpm typecheck && pnpm test"], "");
      expect(text).toContain("Run this before you finish");
      expect(text).toContain("pnpm typecheck && pnpm test");
      expect(text).toContain("the whole of what this pass asks you to run");
      expect(text).toContain("There is no later turn");
      expect(text).toMatch(/commit it before you verify/i);
    });

    it("is appended once when the template carries no {{checks}} slot", () => {
      const text = renderPrompt("#{{issue}}", TICKET, ["pnpm test"]);
      expect(text.match(/## What `build` checks, and what it does not/g)).toHaveLength(1);
    });

    it("renders in the slot, and not a second time, when the template has one", () => {
      const text = renderPrompt("#{{issue}}\n{{checks}}", TICKET, ["pnpm test"]);
      expect(text.match(/## What `build` checks/g)).toHaveLength(1);
    });

    /**
     * **Never blank**, unlike `{{failure}}` and `{{design}}`. A project whose
     * recipe declares no command at `build:` still has to be told not to wait on
     * anything slower than this turn — that silence is what `#249` and `#308`
     * were lost to, and it is not conditional on the recipe having a bar to name.
     */
    it("still tells the agent not to wait, even when the recipe names no command", () => {
      const text = renderPrompt(TEMPLATE, TICKET, []);
      expect(text).toContain("declares no command at `build:`");
      expect(text).toMatch(/commit it before you verify/i);
    });

    /**
     * **`#319`, step 4 of the real template.** `{{checks}}` substitutes a block
     * that opens with an `##` heading. Put inline after a bare `3. ` marker with
     * no blank line around it, that heading renders as inline list text and the
     * `4. **Commit as the work stands…` item that follows has no blank line
     * ahead of it either — an ordered item that isn't `1.` cannot interrupt a
     * paragraph, so it is swallowed into the checks text instead of staying its
     * own step. `prompts/ticket.md` puts a blank line on both sides of
     * `{{checks}}` for exactly this reason; this reads the real file rather than
     * a fixture so a future edit that removes either blank line fails here.
     */
    it("keeps step 4 its own numbered item in the real ticket template", async () => {
      const template = await readFile(`${repoRoot}prompts/ticket.md`, "utf8");
      const text = renderPrompt(template, TICKET, ["pnpm typecheck && pnpm test"]);
      expect(text).toMatch(/\n\n4\. \*\*Commit as the work stands/);
    });
  });
});
