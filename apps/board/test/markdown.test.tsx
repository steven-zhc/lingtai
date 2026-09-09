/**
 * Markdown is decided per source, and a log is never one.
 *
 * The half of #106 that is a security property and the half that is a
 * readability one are the same rule read from two ends, so they are tested
 * together: the ticket body is markdown *and* is written by anyone who can file
 * an issue on a managed repository, and a gate's stdout is neither.
 *
 * The assertions are on the markup, for the reason #101 established one file
 * along — the escaping was never a fact about the payload, it appeared in the
 * render, so that is where a test has to look.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import { renderingFor, sourceOfPayloadDocument } from "../src/lib/markdown.ts";
import { splitPayload, toLine } from "../src/lib/history.ts";
import { DocumentBody } from "../src/app/markdown.tsx";
import { HistoryRow } from "../src/app/history-row.tsx";

/** The real failure the rule is written against, from 2026-09-08. */
const TYPECHECK = [
  "packages/actions typecheck: test/agent-gate.test.ts(36,5): error TS2741:",
  "  Property 'enforcesLimits' is missing in type '{ id: \"claude-code\"; … }'",
  "# not a heading, and _not_ emphasis",
].join("\n");

const PROMPT = ["# Ticket", "", "## #106 — Markdown is decided per source", "", "Body."].join("\n");

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
    at: new Date("2026-09-08T17:12:15Z"),
  };
}

describe("the rule", () => {
  it("says what each of the three sources gets, and nothing else exists", () => {
    expect(renderingFor("ticket-body")).toBe("rendered");
    expect(renderingFor("prompt")).toBe("on request");
    expect(renderingFor("log")).toBe("never");
  });

  /**
   * The safety property. An allowlist of things to render is a list somebody
   * must remember to leave the next event type off; this is a list of the two
   * things that are not the log, so the next one is raw for free.
   */
  it("calls a document out of an unknown event a log", () => {
    expect(sourceOfPayloadDocument("SomethingNobodyHasWrittenYet", "detail")).toBe("log");
    expect(sourceOfPayloadDocument(undefined, "prompt")).toBe("log");
    expect(sourceOfPayloadDocument("RunFailed", "detail")).toBe("log");
    expect(sourceOfPayloadDocument("RepairRequested", "detail")).toBe("log");
  });

  it("distinguishes the composed prompt from a field that merely shares its name", () => {
    expect(sourceOfPayloadDocument("RunPrompted", "prompt")).toBe("prompt");
    // An agent's own question, printed. Not the document it was given.
    expect(sourceOfPayloadDocument("RunAwaitingInput", "prompt")).toBe("log");
  });

  it("stamps the source onto the document as it comes off the payload", () => {
    const { documents } = splitPayload({ prompt: PROMPT }, "RunPrompted");
    expect(documents.map((d) => d.source)).toEqual(["prompt"]);
    expect(splitPayload({ detail: TYPECHECK }, "RunFailed").documents[0]?.source).toBe("log");
  });
});

describe("a log", () => {
  const html = renderToStaticMarkup(
    <DocumentBody source="log" text={TYPECHECK} rawClass="hdoctext" />,
  );

  /** `_` becomes emphasis, `#` becomes a heading, `{ }` gets eaten. */
  it("keeps every character markdown would have eaten", () => {
    expect(html).toContain("<pre");
    expect(html).toContain("_not_");
    expect(html).toContain("# not a heading");
    expect(html).toContain("id: &quot;claude-code&quot;");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<h1>");
  });

  it("is not offered as markdown either — there is nothing to click", () => {
    expect(html).not.toContain("Read as markdown");
    expect(html).not.toContain('class="md"');
  });

  it("stays raw all the way through a history row", () => {
    const row = renderToStaticMarkup(
      <HistoryRow line={toLine(e("RunFailed", { kind: "gate-failed", detail: TYPECHECK }))} />,
    );
    expect(row).toContain("_not_");
    expect(row).not.toContain("<em>");
    expect(row).not.toContain("Read as markdown");
  });
});

describe("the prompt", () => {
  const html = renderToStaticMarkup(
    <DocumentBody source="prompt" text={PROMPT} rawClass="hdoctext" />,
  );

  /**
   * #88's whole justification is that the log holds the *exact* document the
   * agent was given — the GitHub body having been editable afterwards — and
   * under #104 the edit box is what will run, byte for byte.
   */
  it("is raw, whole, and first", () => {
    expect(html.indexOf("<pre")).toBeLessThan(html.indexOf('class="md"'));
    expect(html).toContain(PROMPT);
    expect(html).toContain('<pre class="hdoctext">');
  });

  it("offers a rendered view, closed", () => {
    expect(html).toContain("Read as markdown");
    expect(html).toContain("<h1>Ticket</h1>");
    // `details` with no `open`: the record is what you land on.
    expect(html).not.toContain("<details open");
  });
});

describe("the ticket body, which anyone who can file an issue writes", () => {
  function render(body: string): string {
    return renderToStaticMarkup(
      <DocumentBody source="ticket-body" text={body} rawClass="tbodytext" />,
    );
  }

  it("renders as markdown, with GFM", () => {
    const html = render("## Done when\n\n- [ ] one\n- [x] two\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h2>Done when</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("passes no raw HTML through", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<div onclick=\"steal()\">hi</div>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)</");
  });

  it("refuses a javascript: link, which the sanitiser drops", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  /** A remote image is a tracking pixel and a request from the board's origin. */
  it("never emits an image tag, and offers the image as a link instead", () => {
    const html = render("![a pixel](https://tracker.example/p.gif)");
    expect(html).not.toContain("<img");
    expect(html).toContain("https://tracker.example/p.gif");
    expect(html).toContain("class=\"mdimg\"");
    expect(html).toContain("a pixel");
  });

  /** `.tlink` is the page's own accent link. A stranger's link is not that. */
  it("marks a link as somebody else's", () => {
    const html = render("[somewhere](https://example.com/x)");
    expect(html).toContain('class="mdlink"');
    expect(html).not.toContain("tlink");
    expect(html).toContain('rel="noreferrer nofollow ugc"');
    expect(html).toContain('target="_blank"');
  });
});
