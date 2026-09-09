/**
 * The ticket row, which said `bug` twice.
 *
 * `#89  bug  bug  lingtai:waiting` on every ticket in the repository, because
 * the row rendered the kind pill and then *every* label — and **the kind is one
 * of the labels**: that is how the recipe's `source.kinds` picks it up, so a
 * duplicate was structural rather than a bad row of data (#111 §6).
 *
 * Asserted on the markup for the reason `#101` established: this was never a
 * fact about `TicketView`, which is right. It appears in the render.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TicketView } from "../src/lib/task.ts";
import { Ticket } from "../src/app/task/[id]/page.tsx";

const TICKET: TicketView = {
  project: "lingtai",
  ref: "89",
  title: "the agent produced no commits",
  kind: "bug",
  labels: ["bug", "lingtai:waiting"],
  url: "https://github.com/steven-zhc/lingtai/issues/89",
  body: null,
  problem: null,
};

/** Every `class="pill"`, in order, with what is inside it. */
function pills(html: string): string[] {
  return [...html.matchAll(/<span class="pill">([^<]*)<\/span>/g)].map((m) => m[1] ?? "");
}

describe("the kind, and the labels", () => {
  it("names the kind once", () => {
    expect(pills(renderToStaticMarkup(<Ticket ticket={TICKET} />))).toEqual([
      "bug",
      "lingtai:waiting",
    ]);
  });

  /**
   * The pill is first because it is the one label the conductor acts on — the
   * queue never sees a ticket without one — and the rest follow it.
   */
  it("leads with the kind and keeps every other label after it", () => {
    const html = renderToStaticMarkup(
      <Ticket ticket={{ ...TICKET, labels: ["documentation", "tech-debt", "enhancement"], kind: "tech-debt" }} />,
    );

    expect(pills(html)).toEqual(["tech-debt", "documentation", "enhancement"]);
  });

  /**
   * A kind the labels no longer carry — relabelled on GitHub since the claim —
   * is still the kind Lingtai took the ticket as, and the log is what says so.
   */
  it("still names a kind the labels have stopped carrying", () => {
    const html = renderToStaticMarkup(
      <Ticket ticket={{ ...TICKET, kind: "bug", labels: ["lingtai:waiting"] }} />,
    );

    expect(pills(html)).toEqual(["bug", "lingtai:waiting"]);
  });

  it("lists the labels on a ticket whose kind was never recorded", () => {
    const html = renderToStaticMarkup(<Ticket ticket={{ ...TICKET, kind: null }} />);

    expect(pills(html)).toEqual(["bug", "lingtai:waiting"]);
  });
});
