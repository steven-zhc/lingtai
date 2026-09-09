/**
 * What the next attempt will be handed — the thing `#104` puts on the page.
 *
 * The claims here are the ones that make showing the prompt worth anything.
 * A page that composes an *approximation* of the document is worse than a page
 * that shows nothing, because it invites somebody to approve a prompt that is
 * not the one that runs; so what is asserted is that one function produces
 * both, that a person's sentence reaches it, and that the version says so.
 *
 * Pure, under `vitest.pure.config.ts`: this is a fold over envelopes plus three
 * string joins, and a composition that needed a database would be the wrong
 * shape.
 */
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
  it("is the template alone on a first attempt nobody has edited", () => {
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
    expect(renderPrompt(TEMPLATE, TICKET, next.failure)).toBe("#104 — The control is the prompt\n\nthe body\n\n");
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
    const text = renderPrompt(TEMPLATE, TICKET, next.failure);
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
});
