/**
 * The third button exists, and it is not the loud one (#151).
 *
 * The three moves were settled as Approve, Requeue and Close, and two of them
 * shipped: `#150` landed the row before `lingtai close` existed, because the
 * queue orders by kind and took the `bug` ahead of the `feature` it needed
 * (#131). So the card adjudicating a ticket nobody was going to do could
 * approve it or argue with it, and the move a person actually wanted was in a
 * terminal.
 *
 * Two things are asserted, because they fail apart. *The control is there* is
 * a fact about `decide.tsx`; *the card offers it* is a fact about the two files
 * that render a row of moves, and `#150` is the standing proof that a control
 * can exist and still be missing from the one row that needs it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Close } from "../src/app/decide.tsx";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Close", () => {
  it("rests as one button and asks for nothing until it is clicked", () => {
    const html = renderToStaticMarkup(<Close project="lingtai" issue={151} />);

    expect(html).toContain(">Close<");
    // The reason box is the second click. A close that could be made in one is
    // a close that can be made by a misclick, and nothing lifts one.
    expect(html).not.toContain("<input");
  });

  it("is never amber", () => {
    const html = renderToStaticMarkup(<Close project="lingtai" issue={151} />);

    // Brass on this board means *a person is being waited on* and nothing else
    // (0035 §3). Closing is a person deciding, not being asked, so the resting
    // button wears `btn` and not `btn pri` — which is also why no diagnosis can
    // promote it the way `primaryMove` promotes Approve and Requeue.
    expect(html).toMatch(/class="btn"/);
    expect(html).not.toMatch(/class="btn pri"/);
  });

  it("refuses to send an empty reason", () => {
    const source = read("../src/app/decide.tsx");
    const close = source.slice(source.indexOf("export function Close"));

    // `close()` refuses a blank reason on the server too; this is the half that
    // stops the click being possible at all, so the refusal is not the first
    // thing a person learns about the control.
    expect(close).toMatch(/disabled=\{!reason\.trim\(\) \|\| pending\}/);
  });
});

describe("the row of moves", () => {
  it("offers it beside Approve and Requeue on a blocked card", () => {
    for (const file of ["../src/app/page.tsx", "../src/app/standing.tsx"]) {
      const source = read(file);
      expect(source, file).toMatch(/import \{ Close[,\s]/);
      expect(source, file).toContain("<Close");
    }
  });

  it("offers it on a queued card, which is where the ones that sat were", () => {
    // #32, #115, #126 and #136 were closed on GitHub for hours and the board
    // went on listing them in Queued, because `gh issue close` appends nothing
    // and the fold reads the log. A queued card's only move was `Run now`.
    const page = read("../src/app/page.tsx");
    // `lastIndexOf`: the string also appears in `accent()` near the top of the
    // file, where it picks a card's colour and has nothing to do with a row of
    // moves. The row is the last of them.
    const queued = page.slice(page.lastIndexOf('card.column === "queued"'));
    expect(queued.slice(0, 400)).toContain("<Close");

    const standing = read("../src/app/standing.tsx");
    const runNow = standing.slice(standing.indexOf("<RunNow"));
    expect(runNow.slice(0, 600)).toContain("<Close");
  });
});
