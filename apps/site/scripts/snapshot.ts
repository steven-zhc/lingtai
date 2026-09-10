import { rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readTasks, type TaskCard } from "@lingtai/projector/task-view";
import { SNAPSHOT_FILE, takeBoard } from "../src/lib/snapshot.ts";

/**
 * Takes the board on the front page.
 *
 * Run by `pnpm --filter @lingtai/site build`, before `next build`. It reads
 * `task_view` once, hands the rows to `takeBoard`, and writes `snapshot.json`.
 * Nothing else in the site ever touches the log.
 *
 * **It refuses to invent a board.** With no `LINGTAI_DATABASE_URL` it writes
 * nothing, says so, and exits 0 — a clone of this repository can still build the
 * site, and the hero then says it has no snapshot instead of showing figures
 * somebody made up. A log it was pointed at and could not read is the opposite
 * case and stops the build; see `stop` below.
 *
 *     LINGTAI_SITE_PUBLIC_PROJECTS=owner/repo,owner/other pnpm --filter @lingtai/site snapshot
 *
 * Every name Lingtai reads for itself begins `LINGTAI_` (#63).
 */

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

/** The commit the log was read at, or null outside a repository. */
function head(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Stops the build, with the reason on stderr.
 *
 * **A log that was pointed at and did not answer is a failed build**, not a
 * page that renders the "no snapshot" notice and deploys anyway. That notice is
 * honest about a machine that never had a log and dishonest about one whose log
 * refused the connection: it reads as a deliberate choice not to publish
 * figures, when what happened is that the figures could not be fetched. The
 * distinction is `LINGTAI_DATABASE_URL` — unsetting it is a decision somebody
 * makes, and an outage is a decision nobody made.
 *
 * The build stopping here is the point. A hero quietly falling back would be a
 * fabricated screenshot of a real product, which is worse than no hero.
 */
function stop(why: string, cause: unknown): never {
  console.error(`snapshot: ${why}`);
  console.error(`  ${cause instanceof Error ? cause.message : String(cause)}`);
  console.error(
    "  This build is stopping rather than deploying a page whose board is missing for a reason nobody chose. Unset LINGTAI_DATABASE_URL to build the site without a board on purpose.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // The script owns this file: every run either writes a fresh one or leaves
  // none. A `snapshot.json` surviving from an earlier build is the quietest way
  // this page could lie — real figures under a real date, both of them from a
  // build that is not this one — and a working tree or a CI cache keeps files
  // between builds by default.
  await rm(SNAPSHOT_FILE, { force: true });

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
  let tasks: TaskCard[];
  try {
    tasks = await readTasks({ url });
  } catch (err) {
    stop("LINGTAI_DATABASE_URL is set and the log could not be read.", err);
  }

  // An empty board is a claim — "this is the queue, and there is nothing in
  // it" — and a projection that has never been built produces exactly the same
  // zero rows as a system that is genuinely idle. The two are worth different
  // things on a front page and the log cannot tell them apart from here, so
  // nothing is written and the page says it has no snapshot.
  //
  // Skipped and not stopped, which is 0035 §1's decision and not this file's:
  // the read succeeded, so this is not the case above. A log that answers
  // "nothing" has been read; a log that refuses the connection has not.
  if (tasks.length === 0) {
    console.log(
      "snapshot: skipped — `task_view` has no rows. An empty board and an unbuilt projection look identical, and neither is evidence of anything.",
    );
    return;
  }

  const snapshot = takeBoard(tasks, { open, capturedAt, commit: head() });
  await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);

  const total = snapshot.totals.cards;
  const drawn = snapshot.lanes.reduce((n, lane) => n + lane.cards.length, 0);
  console.log(
    `snapshot: ${total} ${total === 1 ? "card" : "cards"} (${snapshot.withheld} withheld), ${drawn} published, at ${snapshot.capturedAt} → ${SNAPSHOT_FILE}`,
  );
}

await main();
