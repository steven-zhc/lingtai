import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readTasks, type TaskCard, type TaskState } from "@lingtai/projector/task-view";
import {
  SNAPSHOT_FILE,
  type Lane,
  type Snapshot,
  type SnapshotCard,
  type SnapshotLane,
} from "../src/lib/snapshot.ts";

/**
 * Takes the board on the front page.
 *
 * Run by `pnpm --filter @lingtai/site build`, before `next build`. It reads
 * `task_view` once, reduces every card to what may be published, and writes
 * `snapshot.json`. Nothing else in the site ever touches the log.
 *
 * **It refuses to invent a board.** With no `LINGTAI_DATABASE_URL` it writes
 * nothing, says so, and exits 0 — a clone of this repository can still build
 * the site, and the hero then says it has no snapshot instead of showing
 * figures somebody made up. A page whose claim is *you can see what happened*
 * cannot afford one fabricated number on it.
 *
 *     LINGTAI_SITE_PUBLIC_PROJECTS=owner/repo,owner/other pnpm --filter @lingtai/site snapshot
 *
 * Every name Lingtai reads for itself begins `LINGTAI_` (#63).
 */

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
const LANE_OF: Record<TaskState, Lane> = {
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

/**
 * The projects whose tickets may be named on a public page.
 *
 * Empty by default, and that is deliberate: the safe failure is a board of
 * withheld cards, and the unsafe one is a private repository's issue titles on
 * the internet. A project has to be named here to be published, so the person
 * running the build is the one who decided.
 */
function publishable(): Set<string> {
  const named = process.env.LINGTAI_SITE_PUBLIC_PROJECTS ?? "";
  return new Set(
    named
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== ""),
  );
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

/** The commit the log was read at, or null outside a repository. */
function head(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const url = process.env.LINGTAI_DATABASE_URL;
  if (url === undefined || url === "") {
    console.log(
      "snapshot: skipped — no LINGTAI_DATABASE_URL. The site will build, and its board will say it has no snapshot.",
    );
    return;
  }

  const open = publishable();
  if (open.size === 0) {
    console.log(
      "snapshot: LINGTAI_SITE_PUBLIC_PROJECTS names no project, so every card will be withheld.",
    );
  }

  const capturedAt = new Date();
  const tasks = await readTasks({ url });
  const cards = tasks.map((t) => reduce(t, open.has(t.project), capturedAt.getTime()));

  // An empty board is a claim — "this is the queue, and there is nothing in
  // it" — and a projection that has never been built produces exactly the same
  // zero rows as a system that is genuinely idle. The two are worth different
  // things on a front page and the log cannot tell them apart from here, so
  // nothing is written and the page says it has no snapshot.
  if (cards.length === 0) {
    console.log(
      "snapshot: skipped — `task_view` has no rows. An empty board and an unbuilt projection look identical, and neither is evidence of anything.",
    );
    return;
  }

  const lanes: SnapshotLane[] = LANES.map((lane) => ({
    ...lane,
    cards: cards.filter((c) => c.lane === lane.id),
  }));

  const snapshot: Snapshot = {
    capturedAt: capturedAt.toISOString(),
    commit: head(),
    lanes,
    totals: {
      costUsd: round(cards.reduce((sum, c) => sum + (c.costUsd ?? 0), 0)),
      turns: cards.reduce((sum, c) => sum + (c.turns ?? 0), 0),
      cards: cards.length,
    },
    withheld: cards.filter((c) => c.project === null).length,
  };

  await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `snapshot: ${cards.length} cards (${snapshot.withheld} withheld) at ${snapshot.capturedAt} → ${SNAPSHOT_FILE}`,
  );
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

await main();
