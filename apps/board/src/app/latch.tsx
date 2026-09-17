"use client";

/**
 * A disclosure that opens itself when something starts, and stays where you put it.
 *
 * **Opening is a signal; closing is not** (#132). The board and the task page
 * each re-render on every append (`live.tsx`), so anything derived from the fold
 * is a value that changes under a reader's hands — and `<details open={running}>` is the whole of the
 * bug that makes: React writes the attribute whenever the prop changes, so the
 * attempt that opened itself when its run started *collapses under somebody
 * reading it* the moment that run finishes, and a `RunLog` that was already
 * mounted when the run started never opens at all, because `useState(live)`
 * read `live` once at mount and the run was not going yet.
 *
 * So the open state is held here and moved in one direction only: the signal
 * going true opens it, nothing closes it but the reader, and a signal that was
 * already true at mount is the initial state rather than an effect. What a
 * person opened stays open and what they closed stays closed, which is the only
 * behaviour a disclosure on a live page can have and still be usable.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * The open state of one disclosure, latched.
 *
 * `initial` is what the server rendered — the same value, so nothing
 * hydrates differently — and `openWhen` is the live signal. `RunLog` needs the
 * boolean itself (it decides whether to follow a file), so this is a hook and
 * `Latch` below is the ordinary case wrapped around it.
 */
export function useLatch(
  initial: boolean,
  openWhen = false,
): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(initial || openWhen);

  // Only ever true. This runs when `openWhen` becomes true — a run that started
  // after this mounted — and never puts it back, which is the half `open={…}`
  // as a bare attribute got wrong in both directions.
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);

  return [open, setOpen];
}

/** `<details>` under `useLatch`. See the module header for why it is not an attribute. */
export function Latch({
  className,
  id,
  initial,
  openWhen,
  children,
}: {
  className?: string;
  id?: string;
  /** Open from the first paint, on the server and in the browser. */
  initial: boolean;
  /** Opens it when it becomes true, and never closes it. */
  openWhen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useLatch(initial, openWhen);
  return (
    <details
      className={className}
      id={id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {children}
    </details>
  );
}

/**
 * The part of a `<details>` that `openTo` reads: where it is, and whether it is open.
 * Structural, so the walk is testable without a document.
 */
export interface Disclosing {
  open?: boolean;
  parentElement: { closest(selector: "details"): Disclosing | null } | null;
}

/**
 * Opens every `<details>` a fragment's target is inside, and says how many.
 *
 * **A pointer into a collapsed row has to land on something readable** (#152).
 * The attempts row of the task page's record is closed on load, and `#attempt-N`
 * — the bar's `from attempt N of M ↓` and rank 2's `in attempt N ↓` — is inside
 * it. Some browsers open a closed ancestor on fragment navigation and some do
 * not, and none does anything when the hash is already the one clicked, so it
 * is not left to the browser.
 */
export function openTo(target: Disclosing): number {
  let opened = 0;
  for (let d = target.parentElement?.closest("details") ?? null; d; d = d.parentElement?.closest("details") ?? null) {
    if (!d.open) {
      d.open = true;
      opened += 1;
    }
  }
  return opened;
}

/**
 * The element id a `#fragment` names. A malformed escape — `#100%`, a link cut
 * off mid-escape — is taken as written rather than thrown: an effect that
 * throws takes the whole task page to the error boundary, and an unknown
 * fragment has only ever done nothing.
 */
export function fragmentId(hash: string): string {
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * `openTo` for the page: on load, on every hash change, and on every click of a
 * same-page link — the click because following a link to the hash already in
 * the address bar fires no navigation and no `hashchange`. Renders nothing.
 *
 * Opening is a signal here as it is in `Latch`: a row a link opened is the
 * reader's to close. Setting `open` on the element fires its `toggle`, so a
 * `Latch` on the way up records the change as its own.
 */
export function Reveal() {
  useEffect(() => {
    const reveal = (hash: string, scroll: boolean) => {
      if (!hash.startsWith("#") || hash.length < 2) return;
      const target = document.getElementById(fragmentId(hash));
      if (target === null) return;
      // Scrolled only where the browser will not: a row that was closed when it
      // navigated, or a link to the hash it is already at.
      if (openTo(target) > 0 || scroll) target.scrollIntoView({ block: "start" });
    };
    const onHash = () => reveal(window.location.hash, false);
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const href = event.target.closest("a")?.getAttribute("href") ?? "";
      // Before the browser's own navigation, so the row is open by the time it
      // looks for the target; and scrolled here when that navigation is none.
      if (href.startsWith("#")) reveal(href, href === window.location.hash);
    };
    reveal(window.location.hash, false);
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}
