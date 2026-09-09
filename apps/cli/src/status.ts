/**
 * `lingtai status` — what is runnable, and what is not.
 *
 * The old loop's equivalent was `pick_ticket`, a GitHub issue search re-run every
 * hour whose result nobody could see. The important half of this command is
 * therefore not the queue but the **absences**: an issue that is not being
 * worked has a reason, and until now the reason was never written down anywhere.
 */
import {
  describeFilter,
  heldUntil,
  inWords,
  loadProjects,
  projectFilter,
  runnableNow,
  selectRunnable,
} from "@lingtai/conductor";
import { readTasks } from "@lingtai/projector";

export interface StatusOptions {
  /** Restrict to one project. */
  project?: string;
  /** Show items that have left the queue, and what holds them. */
  all?: boolean;
}

export async function status(options: StatusOptions = {}, log = console.log): Promise<number> {
  const projects = (await loadProjects()).filter(
    (p) => !options.project || p.project === options.project,
  );

  if (projects.length === 0) {
    log(
      options.project
        ? `no project named "${options.project}" — run lingtai add <owner>/<repo> first`
        : "no projects registered — run lingtai add <owner>/<repo>",
    );
    return 0;
  }

  for (const project of projects) {
    const name = project.project!;
    log(`${name}  base=${project.base ?? "(unrecorded)"}`);

    // What this project will and will not take, said before the numbers that
    // depend on it — and said by the same function `lingtai daemon` prints at
    // startup, so the two cannot disagree (#76). It names the recipe's hash and
    // branch, its kinds in priority order, its excludes; or, when the recipe
    // will not resolve, that and the reason, which is the case that used to
    // render as a queue that was simply empty.
    const filter = await projectFilter(project);
    for (const line of describeFilter(filter)) log(`  ${line}`);

    // Priority order is the recipe's `kinds`, and the recipe lives in the
    // managed repository — so without GitHub the queue can still be listed, just
    // not prioritised.
    const kinds: readonly string[] = filter.ok ? filter.kinds : [];
    // What GitHub is offering. Empty when it could not be asked, which is not
    // the same as an empty queue and is said differently below.
    let offered: { ref: string; title: string; kind: string }[] = [];
    /** Whether GitHub answered at all. An empty offer means nothing without it. */
    let asked = false;
    if (filter.ok) {
      try {
        const { client, recipe } = filter;

        // Always, not behind a flag. There is nothing left to read the queue
        // out of — 0022 deleted the table that used to hold it — so the choice
        // is between asking GitHub and having no answer. This takes nothing,
        // claims nothing and appends no event.
        const found = await runnableNow({ client, recipe });
        offered = found.runnable;
        asked = true;
        const reasons = new Map<string, number>();
        for (const s of found.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
        const passed = [...reasons]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([reason, n]) => `${reason} ${n}`)
          .join(", ");
        // **`eligible`, not `runnable`.** They are answers to different
        // questions and this line used the other line's word for its own,
        // which made "8 runnable / 0 runnable" read as a contradiction when
        // both numbers were right (`#54`). This one is about the *recipe* —
        // how many open issues its `kinds` and `exclude` will take. The line
        // below is about *state* — how many can be claimed right now.
        log(
          `  from GitHub: ${found.runnable.length} eligible` +
            (found.skipped.length > 0 ? `, ${found.skipped.length} passed over — ${passed}` : ""),
        );
      } catch (err) {
        log(`  (GitHub unavailable: ${(err as Error).message} — the queue cannot be listed)`);
      }
    }

    // What GitHub offers minus what the log says is claimed — including
    // anything the backoff is still holding, which the listing below names.
    //
    // Zero when the recipe would not resolve, and it changes no answer: nothing
    // was offered either, so there is nothing for a window to apply to. It is
    // not a fallback for the recipe's value (0028) — there is no such thing.
    const backoffMs = filter.ok ? filter.backoffMs : 0;
    const runnable = await selectRunnable({ project: name, offered, kinds, backoffMs });
    const queuedRows = runnable.map((r) => ({ ...r, state: "queued" as const }));
    const known = await readTasks({ project: name });

    // **Where the rest went**, in the same breath as the number. A reader who
    // sees eight eligible and none runnable has to be told why, or the honest
    // reading of the pair is "something is broken" (`#54`). `gates` folds into
    // `running`: from an operator's seat they are the same fact.
    const NAMES: Record<string, string> = {
      running: "running",
      gates: "running",
      waiting: "waiting on you",
      landed: "landed",
    };
    const elsewhere = new Map<string, number>();
    for (const t of known) {
      if (t.state === "queued") continue;
      const label = NAMES[t.state] ?? t.state;
      elsewhere.set(label, (elsewhere.get(label) ?? 0) + 1);
    }
    const elsewhereSays = [...elsewhere].map(([label, n]) => `${n} ${label}`).join(", ");

    log(`  queue: ${runnable.length} runnable` + (elsewhereSays ? ` — ${elsewhereSays}` : ""));

    // `--all` widens the listing to everything the project has a row for,
    // which is how you see what is running, held or landed rather than only
    // what could start next.
    let rows: {
      taskId: string;
      issue: string;
      kind: string;
      title: string;
      state: string;
      /** Only ever on a row the log wrote; an offer GitHub made carries neither. */
      lastAttemptAt?: Date | null;
      repairPending?: boolean;
    }[] = queuedRows;
    if (options.all) {
      const ids = new Set(known.map((t) => t.taskId));
      // An issue GitHub offers that Lingtai has never touched has no row at
      // all. Before 0022 the cache wrote it one; now it is only in the offer.
      rows = [...known, ...queuedRows.filter((r) => !ids.has(r.taskId))];
    }
    if (rows.length === 0) continue;
    const now = Date.now();
    for (const t of rows) {
      // **When, not whether** (`#95`). A task inside the backoff window is
      // runnable-but-not-yet, and `[backing off]` on its own is a state a person
      // can see and cannot act on: nothing said how long it lasted or what ended
      // it. The arithmetic is the recipe's `source.backoff` from the last
      // attempt, so it is said here rather than left to be looked up (0028).
      const held =
        t.state === "queued"
          ? heldUntil(
              { lastAttemptAt: t.lastAttemptAt ?? null, repairPending: t.repairPending === true },
              backoffMs,
              now,
            )
          : null;
      // A queued row that is not runnable and not held is one GitHub is not
      // offering — closed by hand, relabelled, excluded. That is not the clock
      // and never was, and calling it `[backing off]` was the second thing this
      // line got wrong. Said only when GitHub actually answered: with no answer
      // every row looks unoffered, and the line above already says so.
      const unoffered =
        t.state === "queued" && asked && !runnable.some((r) => r.taskId === t.taskId);
      const note =
        t.state !== "queued"
          ? `  [${t.state}]`
          : held
            ? `  [backing off — runnable in ${inWords(held.getTime() - now)}]`
            : unoffered
              ? "  [not offered]"
              : "";
      log(`    #${t.issue.padEnd(5)} ${t.kind.padEnd(11)} ${t.title}${note}`);
    }
  }
  return 0;
}
