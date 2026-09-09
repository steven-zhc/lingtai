/**
 * The prompt is shown before it is sent, and the page says what an edit did.
 *
 * The failure this is written against is `#89`: two attempts and $13.04 spent
 * chasing a flag that one sentence would have settled, because the only thing a
 * person could say about a blocked item was *yes* or *no*. So the assertions
 * are about the four things that turn approval into *yes, but* — the document
 * itself, the bound on the edit, the version that names it, and the diff that
 * keeps hand-written prose from passing for something Lingtai composed.
 *
 * The rendering is asserted on the markup for the reason `#101` established:
 * these are facts about what a reader is shown, not about the fold.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lineDelta, type OutgoingView } from "../src/lib/prompt.ts";
import { Outgoing } from "../src/app/outgoing.tsx";

const COMPOSED = "#104 — the ticket\n\nthe body\n\nwhat attempt 1 did\n";

const VIEW: OutgoingView = {
  text: COMPOSED,
  version: "ticket@1924+failure@1c5708ba",
  basedOn: "ticket@1924+failure@1c5708ba",
  attempt: 3,
  edit: null,
  delta: { added: 0, removed: 0 },
  problem: null,
};

describe("what an edit did to the prompt", () => {
  it("counts an inserted block as additions and nothing else", () => {
    // What an edit actually produces: one contiguous block inside `{{failure}}`.
    const after = "a\nb\nADDED ONE\nADDED TWO\nc\n";
    expect(lineDelta("a\nb\nc\n", after)).toEqual({ added: 2, removed: 0 });
  });

  it("counts nothing when the document did not move", () => {
    expect(lineDelta(COMPOSED, COMPOSED)).toEqual({ added: 0, removed: 0 });
  });

  /**
   * Not only insertions, because the count must not lie if the composition ever
   * changes shape underneath it — a `−0` on a document that lost lines is the
   * kind of quietly wrong number this box exists to avoid.
   */
  it("counts a replacement on both sides", () => {
    expect(lineDelta("a\nold one\nold two\nc", "a\nnew\nc")).toEqual({ added: 1, removed: 2 });
  });
});

describe("the box, rendered", () => {
  /**
   * The document itself, not a summary of it and not behind a disclosure. The
   * whole complaint is that the prompt was composed by the system, never shown,
   * and could not be changed.
   */
  it("shows the composed prompt, raw, before anything is sent", () => {
    const html = renderToStaticMarkup(<Outgoing taskId="wi-lingtai-104" outgoing={VIEW} />);

    expect(html).toContain("will be sent");
    expect(html).toContain("what attempt 1 did");
    // Raw. `markdown.ts` §6: the prompt is never rendered, and the edit box is
    // never anything but text.
    expect(html).toContain('<pre class="outtext">');
    expect(html).toContain("Edit");
  });

  /**
   * The bound is on the box that makes the edit, because that is where somebody
   * decides whether the ticket is the right place instead (0032 §6).
   */
  it("says how long the edit lasts, on the box", () => {
    const html = renderToStaticMarkup(<Outgoing taskId="wi-lingtai-104" outgoing={VIEW} />);
    expect(html).toContain("attempt 3 only");
  });

  /**
   * **The part that cannot be skipped.** Two runs sharing a `promptVersion`
   * that did not share a prompt is the log lying about what produced a result,
   * so the field a reader would check is on the page rather than only in a
   * payload.
   */
  it("prints the version, and the version names the edit", () => {
    const edited: OutgoingView = {
      ...VIEW,
      version: "ticket@1924+failure@9d0c11aa+human@a91f2e",
      edit: { text: "the flag is in the binary", by: "human:steven" },
      delta: { added: 4, removed: 0 },
    };
    const html = renderToStaticMarkup(<Outgoing taskId="wi-lingtai-104" outgoing={edited} />);

    expect(html).toContain("ticket@1924+failure@9d0c11aa+human@a91f2e");
    expect(html).toContain("human:steven");
    expect(html).toContain("+4 −0 lines against what Lingtai composed");
    // The way back off it is offered beside the edit, not buried.
    expect(html).toContain("Remove the edit");
  });

  it("offers no removal when there is nothing to remove", () => {
    const html = renderToStaticMarkup(<Outgoing taskId="wi-lingtai-104" outgoing={VIEW} />);
    expect(html).not.toContain("Remove the edit");
  });

  /**
   * Never merely absent (#76). A missing template, an unregistered project and
   * a recipe that will not parse all look alike, and only the reason tells them
   * apart — and none of them may render as a prompt that is not the real one.
   */
  it("says why there is no prompt rather than showing an approximation", () => {
    const html = renderToStaticMarkup(
      <Outgoing
        taskId="wi-lingtai-104"
        outgoing={{ ...VIEW, text: "", problem: "the recipe could not be read: bad kinds" }}
      />,
    );

    expect(html).toContain("the recipe could not be read: bad kinds");
    expect(html).not.toContain("attempt 3 only");
    expect(html).not.toContain("<pre");
  });
});
