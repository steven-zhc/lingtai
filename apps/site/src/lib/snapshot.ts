import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TaskCard, TaskState } from "@lingtai/projector/task-view";

/**
 * The board on the front page, as a file.
 *
 * The hero is Lingtai's own board — real lanes, real tickets, real figures —
 * and it is **not live**. `scripts/snapshot.ts` reads the log once, `takeBoard`
 * below reduces it to what may be published, and the script writes
 * `snapshot.json`; the build reads that file and renders it; the site is a
 * static export and never opens a connection. See `next.config.ts` for why that
 * is a structural property rather than a habit.
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
 *
 * The fold is here rather than in the script because it is the part with a
 * property worth testing: what a withheld card keeps, and that a lane which
 * publishes five cards still counts all forty.
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
  /**
   * How many cards are in this lane — **all of them**, not how many are drawn.
   *
   * `cards` is a handful (`LANE_CARDS`) and this is the whole lane, and the
   * two are separate fields because the moment they were one field the page
   * would be quietly reporting the size of its own excerpt. The lane header
   * prints this one, so a lane holding forty landed items says forty and shows
   * five. The difference is drawn as "and N more" rather than left to be
   * inferred from a number that does not match the cards under it.
   */
  count: number;
  cards: SnapshotCard[];
}

export interface Snapshot {
  /** ISO, and printed on the page. */
  capturedAt: string;
  /** The commit the log was read at, when the working tree was a repository. */
  commit: string | null;
  lanes: SnapshotLane[];
  /**
   * What the board has cost, added up — over every card in it, and not over
   * the handful each lane publishes. The head of the board prints these, so
   * they are the figure the page is making its claim with; summing the excerpt
   * would make the claim smaller than the truth and, worse, make it depend on
   * `LANE_CARDS`.
   */
  totals: { costUsd: number; turns: number; cards: number };
  /** How many cards on the whole board had their identity withheld, so the page can say. */
  withheld: number;
}

export const SNAPSHOT_FILE = path.resolve(process.cwd(), "snapshot.json");

/**
 * How many cards a lane publishes.
 *
 * A handful, because the hero is a photograph of a board and not the board: it
 * sits beside a paragraph, and a lane that scrolls has stopped being an image
 * of anything. Five is what fits without the frame growing.
 *
 * What makes the excerpt honest rather than flattering is that it is only the
 * *drawing* that is capped. `SnapshotLane.count` and `Snapshot.totals` are over
 * every card, so the page says how much work there is and shows a sample of it,
 * which is a different claim from showing all of a small board.
 */
export const LANE_CARDS = 5;

/**
 * Which lane a state is shown in. Four lanes, not five — `gates` is a task
 * state and not a lane, because from an operator's seat "the agent is working"
 * and "the build is running" are the same fact (ADR 0016 §8).
 *
 * The board's `COLUMN_OF` is the original and this agrees with it by being the
 * same shape: a `Record` over `TaskState`, so a sixth state cannot be added to
 * the domain without both of them failing to compile. That is the property #59
 * lacked, where bucketing on the raw state left a task off every column for the
 * whole of its gate run.
 */
export const LANE_OF: Record<TaskState, Lane> = {
  queued: "queued",
  running: "running",
  gates: "running",
  waiting: "waiting",
  landed: "landed",
};

const LANES: { id: Lane; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting on you" },
  { id: "landed", label: "Landed" },
];

export interface TakeOptions {
  /**
   * The projects whose tickets may be named. Everything else is withheld —
   * an allowlist, so a project that has never been considered is invisible
   * rather than published by default.
   */
  open: Set<string>;
  capturedAt: Date;
  /** The commit the log was read at, or null outside a repository. */
  commit: string | null;
}

/**
 * The board, taken.
 *
 * Pure: it is handed the rows and gives back the file's contents, so what the
 * page will say can be checked without a database. Every decision that could
 * make the hero flattering is in here — which cards are withheld, which are
 * drawn, what the totals are over — and each of them is a test.
 */
export function takeBoard(tasks: TaskCard[], { open, capturedAt, commit }: TakeOptions): Snapshot {
  const now = capturedAt.getTime();
  const lanes: SnapshotLane[] = LANES.map(({ id, label }) => {
    const inLane = tasks.filter((t) => LANE_OF[t.state] === id);
    return {
      id,
      label,
      count: inLane.length,
      cards: publish(id, inLane).map((t) => reduce(t, open.has(t.project), now)),
    };
  });

  return {
    capturedAt: capturedAt.toISOString(),
    commit,
    lanes,
    totals: {
      costUsd: round(tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)),
      turns: tasks.reduce((sum, t) => sum + (t.turns ?? 0), 0),
      cards: tasks.length,
    },
    withheld: tasks.filter((t) => !open.has(t.project)).length,
  };
}

/**
 * Which of a lane's cards get drawn.
 *
 * **The lane that is stuck shows what has been stuck longest; every other lane
 * shows what moved most recently.** That is the board's own ordering and its
 * own reason — in "Waiting on you" the oldest wait is what to do next, and
 * everywhere else the newest movement is what the machine is doing — so the
 * excerpt is a photograph of the board rather than a second opinion about it.
 *
 * Nothing here prefers a public card over a withheld one. It would make the
 * picture more readable and it would make the excerpt an argument: a board that
 * quietly shows its nicest cards is the board this page is trying not to be.
 */
function publish(lane: Lane, cards: TaskCard[]): TaskCard[] {
  const moved = (t: TaskCard) => t.updatedAt.getTime();
  const order =
    lane === "waiting"
      ? (a: TaskCard, b: TaskCard) => moved(a) - moved(b)
      : (a: TaskCard, b: TaskCard) => moved(b) - moved(a);
  return [...cards].sort(order).slice(0, LANE_CARDS);
}

/**
 * A card, reduced to what a stranger may see.
 *
 * A withheld card keeps its lane, its age, its attempts and its money and loses
 * everything that names anything. It is kept rather than dropped because the
 * lane counts and the totals are the claim the page is making, and a board that
 * quietly omits some of its work is the board nobody should believe.
 */
function reduce(t: TaskCard, open: boolean, now: number): SnapshotCard {
  const hours = (now - t.updatedAt.getTime()) / 3_600_000;
  return {
    lane: LANE_OF[t.state],
    project: open ? t.project : null,
    ref: open ? t.issue : null,
    title: open ? t.title : null,
    // The kind is a label name — `bug`, `feature`, `tech-debt` — and names
    // nothing about the repository it came from, so it survives withholding.
    kind: t.kind,
    note: open ? t.note : null,
    attempts: t.attempts,
    turns: t.turns,
    costUsd: t.costUsd,
    hoursSinceUpdate: Number.isFinite(hours) ? Math.max(0, Math.round(hours * 10) / 10) : null,
    blocked: t.blocked,
  };
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * The snapshot, or null when no build has taken one.
 *
 * Null is an ordinary state — a clone of this repository has no log to read —
 * so this returns it rather than throwing. A malformed file is not: it means
 * the generator and the reader disagree, and a page rendering half a board is
 * worse than a page saying it has none. A lane with no `count` is that case
 * exactly: it is a file written before lanes carried one, and rendering it
 * would print an excerpt's size where the lane's size belongs.
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
  const lanes = Array.isArray(parsed.lanes) ? parsed.lanes : null;
  if (
    typeof parsed.capturedAt !== "string" ||
    lanes === null ||
    lanes.some((l) => typeof l.count !== "number")
  ) {
    throw new Error(
      `${SNAPSHOT_FILE} is not a board snapshot — regenerate it with \`pnpm --filter @lingtai/site snapshot\``,
    );
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
