import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The board on the front page, as a file.
 *
 * The hero is Lingtai's own board — real lanes, real tickets, real figures —
 * and it is **not live**. `scripts/snapshot.ts` reads the log once, reduces it
 * to what may be published, and writes `snapshot.json`; the build reads that
 * file and renders it; the site is a static export and never opens a
 * connection. See `next.config.ts` for why that is a structural property
 * rather than a habit.
 *
 * Two consequences follow, and both are on the page rather than hidden:
 *
 * - **It has a date.** A board with no date is a board claiming to be now, and
 *   this one is a photograph. `capturedAt` is stamped on the render.
 * - **It can be missing.** A build on a machine with no log produces a site
 *   with no figures, and the hero says so — the same posture as `lingtai
 *   doctor` printing an unimplemented check as `skip`. What it must never do is
 *   invent a plausible board, which is the one failure that would make every
 *   other claim on the page worthless.
 */

/** The four lanes, as the board has them. Not five: `gates` folds into `running`. */
export type Lane = "queued" | "running" | "waiting" | "landed";

export interface SnapshotCard {
  lane: Lane;
  /**
   * The repository, or null when it is withheld.
   *
   * Not every project Lingtai runs is public, and a card from a private one is
   * kept — with its identity removed — rather than dropped. Dropping it would
   * change the lane counts and the totals, and those are the figures the page
   * is making a claim with. A withheld card still says which lane it is in,
   * how long it has been there and what it cost, because none of that names
   * anything. See `scripts/snapshot.ts` for how a project becomes publishable.
   */
  project: string | null;
  /** `#114`, or null when withheld. */
  ref: string | null;
  title: string | null;
  kind: string;
  /** What it is waiting on, or what it merged as. Null when withheld or absent. */
  note: string | null;
  attempts: number;
  turns: number | null;
  costUsd: number | null;
  /**
   * Hours since the log last moved this card, **as at `capturedAt`**.
   *
   * Computed at capture and not at render, because the render happens once at
   * build time and the page is then served for as long as it is served. A
   * duration computed in the browser would keep counting against a fixed
   * photograph and read "412 hours" a fortnight later; this one is a fact about
   * a moment, and the moment is printed beside it.
   */
  hoursSinceUpdate: number | null;
  /** Whether a person is holding a question on it. The lane says where; this says whether. */
  blocked: boolean;
}

export interface SnapshotLane {
  id: Lane;
  label: string;
  cards: SnapshotCard[];
}

export interface Snapshot {
  /** ISO, and printed on the page. */
  capturedAt: string;
  /** The commit the log was read at, when the working tree was a repository. */
  commit: string | null;
  lanes: SnapshotLane[];
  /** What the cards on it have cost, added up. */
  totals: { costUsd: number; turns: number; cards: number };
  /** How many cards had their identity withheld, so the page can say. */
  withheld: number;
}

export const SNAPSHOT_FILE = path.resolve(process.cwd(), "snapshot.json");

/**
 * The snapshot, or null when no build has taken one.
 *
 * Null is an ordinary state — a clone of this repository has no log to read —
 * so this returns it rather than throwing. A malformed file is not: it means
 * the generator and the reader disagree, and a page rendering half a board is
 * worse than a page saying it has none.
 */
export async function readSnapshot(): Promise<Snapshot | null> {
  let raw: string;
  try {
    raw = await readFile(SNAPSHOT_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Snapshot;
  if (typeof parsed.capturedAt !== "string" || !Array.isArray(parsed.lanes)) {
    throw new Error(`${SNAPSHOT_FILE} is not a board snapshot — regenerate it with \`pnpm --filter @lingtai/site snapshot\``);
  }
  return parsed;
}

/** `2026-09-09`, in UTC, which is the only zone a static page can claim. */
export function stamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * "20 hours", "3 days" — the one figure every lane wants.
 *
 * Rounded to something a person says out loud. Precision here would be false:
 * the number is already as old as the build.
 */
export function elapsed(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** `$13.04`. Cents, because at these amounts the cents are the persuasive part. */
export function money(usd: number | null): string | null {
  return usd === null ? null : `$${usd.toFixed(2)}`;
}
