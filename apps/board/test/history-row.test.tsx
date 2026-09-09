/**
 * A document inside a payload renders as a document.
 *
 * `RunPrompted` carries the exact prompt an agent was given (#88), and the row
 * rendered it as `JSON.stringify(data, null, 2)` — one line, thousands of
 * characters wide, every newline a literal `\n`. The most valuable event on the
 * stream was the least readable thing on the page (#101).
 *
 * The assertion is on the markup and not on `splitPayload` alone, because the
 * escaping was never a fact about the payload: it appeared in the render, so
 * that is where a test has to look.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import { splitPayload, toLine } from "../src/lib/history.ts";
import { HistoryRow } from "../src/app/history-row.tsx";

const PROMPT = [
  "# Ticket",
  "",
  "## #83 — Blocked has only a question: no diagnosis",
  "",
  "When something goes wrong the system has exactly one thing it can do.",
].join("\n");

function e(type: string, data: unknown): Envelope {
  return {
    seq: 1800n,
    streamId: "run-f60112af-a598",
    version: 3,
    type,
    schemaVer: 2,
    data,
    actor: "agent:run-f60112af-a598-47ee-a21c-b277bda75822",
    causation: null,
    at: new Date("2026-09-04T17:12:15Z"),
  };
}

function render(event: Envelope): string {
  return renderToStaticMarkup(<HistoryRow line={toLine(event)} />);
}

describe("a payload that carries a document", () => {
  it("renders the prompt with its own newlines, and never as an escape", () => {
    const html = render(e("RunPrompted", { promptVersion: "ticket@1924", bytes: 6268, prompt: PROMPT }));

    // The failure this closes, stated as the two characters it was made of.
    expect(html).not.toContain("\\n");
    // And the document itself, whole, with the newlines it was written with —
    // which is what a selection copies into `claude -p`.
    expect(html).toContain(PROMPT);
  });

  it("labels the block with the field it came from and its size", () => {
    const html = render(e("RunPrompted", { promptVersion: "ticket@1924", bytes: 6268, prompt: PROMPT }));
    expect(html).toContain("prompt");
    expect(html).toContain(`${Buffer.byteLength(PROMPT, "utf8")} bytes`);
  });

  it("keeps every other field as pretty-printed JSON, and the key of the one it lifted", () => {
    const { raw, documents } = splitPayload({ promptVersion: "ticket@1924", bytes: 6268, prompt: PROMPT });
    expect(raw).toContain('"promptVersion": "ticket@1924"');
    expect(raw).toContain('"bytes": 6268');
    // Nothing is dropped: the key stays, saying how big it was and where to
    // look. It is JSON that still parses, and it holds no escaped document.
    expect(JSON.parse(raw).prompt).toMatch(/^‹document, \d+ bytes/);
    expect(raw).not.toContain("\\n");
    expect(documents).toEqual([
      { field: "prompt", text: PROMPT, bytes: Buffer.byteLength(PROMPT, "utf8") },
    ]);
  });

  /**
   * A rule, not a list of field names. `RunFailed.detail` is a gate's stdout
   * and `WorkItemBlocked.diagnosis.raw` is a build log; an allowlist would have
   * been written for `prompt` and been a version behind for both.
   */
  it("lifts a document wherever it sits, including nested and in an array", () => {
    const { raw, documents } = splitPayload({
      kind: "gate-failed",
      diagnosis: { raw: "error TS2345: …\n  at build.ts:4" },
      findings: [{ scenario: "given a\nthen b" }],
    });
    expect(documents.map((d) => d.field)).toEqual(["diagnosis.raw", "findings[0].scenario"]);
    expect(raw).not.toContain("\\n");
    expect(raw).toContain('"kind": "gate-failed"');
  });

  it("leaves a payload with no document exactly as it was stored", () => {
    const data = { promptVersion: "ticket@1911", bytes: 4593, prompt: null };
    expect(splitPayload(data)).toEqual({ raw: JSON.stringify(data, null, 2), documents: [] });
  });
});
