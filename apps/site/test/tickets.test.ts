import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docRoot } from "@/lib/docs";
import { money } from "@/lib/snapshot";
import { ISSUES, TICKETS } from "@/lib/tickets";

/**
 * "Every figure on the page is real and traceable to a public ticket" (#116).
 *
 * The board's figures cannot be typed — they come out of the log or the page
 * says it has none. The two tickets under "when it goes wrong" are the one
 * place the site is allowed to write an amount down, because they are history
 * rather than status, and this is what that permission costs: each figure is
 * checked against the document in `doc/` that records it, so a number nobody
 * can source fails the build instead of reading as true for a year.
 */

describe("the two tickets are traceable", () => {
  it("cites a document in this repository that records the figure", async () => {
    for (const ticket of TICKETS) {
      const file = path.join(docRoot, ticket.source);
      const text = await readFile(file, "utf8");
      // Both halves, in the same document: the reference, so the sentence is
      // about this ticket, and the amount, so it is this ticket's cost and not
      // a figure that drifted while the prose stayed still.
      expect(text, `doc/${ticket.source} does not mention #${ticket.ref}`).toContain(
        `#${ticket.ref}`,
      );
      expect(
        text,
        `doc/${ticket.source} does not record ${money(ticket.costUsd)} for #${ticket.ref}`,
      ).toContain(money(ticket.costUsd)!);
    }
  });

  it("points at issues in this repository, which are public", () => {
    expect(ISSUES).toBe("https://github.com/steven-zhc/lingtai/issues/");
    for (const ticket of TICKETS) expect(Number.isInteger(ticket.ref)).toBe(true);
  });

  it("shows one that landed and one that did not", () => {
    // The section is worth reading because of the second one. A page that
    // reached for two successes when the failure got inconvenient would be
    // making the argument this project says it refuses to make.
    expect(TICKETS.filter((t) => t.landed)).toHaveLength(1);
    expect(TICKETS.filter((t) => !t.landed)).toHaveLength(1);
  });
});
