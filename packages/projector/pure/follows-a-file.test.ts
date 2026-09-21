/**
 * A projection that follows a log with no `LISTEN`/`NOTIFY` behind it (#221).
 *
 * `pure/sqlite.test.ts` proves the *fold* works on a file: it catches up, it
 * rebuilds, it reads the board back. What it does not prove is that anything
 * ever tells it to look — and until now nothing did. #178 built
 * `createPollingWaker` and its contract; **nothing selected it**, so every
 * subscriber in the repository named `createPostgresWaker` outright and a
 * projection on a machine with no Postgres did not fall back to a poll, it
 * failed to open a `LISTEN` on a database that was not there.
 *
 * So what is asserted here is the *selection*, and the shape of the assertion
 * matters:
 *
 * - the runner is given **a log and nothing else** — no `waker`, no `store`.
 *   If the waker were still chosen beside the store rather than handed out by
 *   it, this would reach for Postgres and fail.
 * - the append happens **after `start()` resolves**, which is after the
 *   catch-up read. Nothing but a nudge can deliver it.
 * - there is no sweep in a projection runner. `SWEEP_MS` is the daemon's
 *   fallback pass and does not run here, so a poll that never fired would hang
 *   this test rather than be papered over by it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePayload, workItemStream } from "@lingtai/domain";
import { createSqliteLog, openSqliteLog } from "@lingtai/event-store/sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createProjectionRunner } from "../src/projection.ts";
import { createSqliteProjectionStore, openSqliteProjections } from "../src/sqlite.ts";
import { taskViewProjection } from "../src/task-view.ts";

const dirs: string[] = [];

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-follows-"));
  dirs.push(dir);
  return join(dir, "log.db");
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function eventually(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out after 4s waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a projection on a machine with no Postgres", () => {
  it("advances on an append made after it caught up, woken by the log's own poll", async () => {
    const path = freshPath();
    const logDb = openSqliteLog(path);
    // 25ms rather than `POLL_MS`, so a test does not wait on the real interval.
    // It is the same waker; only the timer is shortened.
    const log = createSqliteLog({ db: logDb, path, intervalMs: 25 });
    const into = createSqliteProjectionStore(openSqliteProjections(path));
    const project = `esctest${crypto.randomUUID().slice(0, 6)}`;

    // A log and a place to fold into. Nothing names a waker, and nothing names
    // a store: if the choice were still made beside the log, this would be a
    // `LISTEN` against nothing.
    const runner = createProjectionRunner({ projection: taskViewProjection, log, into });

    try {
      await runner.start();
      // Caught up on an empty log, which is the state a daemon is in for most
      // of its life and the one in which the old code was silently deaf.
      expect((await runner.lag()).lag).toBe(0n);

      const item = workItemStream(project, 1);
      await log.store.append(item, 0, [
        {
          type: "WorkItemDiscovered",
          actor: "conductor",
          data: parsePayload("WorkItemDiscovered", {
            project,
            source: "manual",
            externalRef: "1",
            title: "a card that only a nudge can produce",
            kind: "tech-debt",
            labels: [],
          }),
        },
      ]);

      await eventually(
        async () => (await into.tasks({ retentionDays: 30, project })).length === 1,
        "the card to reach task_view",
      );

      const [card] = await into.tasks({ retentionDays: 30, project });
      expect(card?.title).toBe("a card that only a nudge can produce");
      // And the checkpoint moved with it, in the same transaction.
      expect((await runner.lag()).lag).toBe(0n);
      expect((await runner.lag()).lastSeq).toBe(1n);
    } finally {
      await runner.close();
      await into.close();
      logDb.close();
    }
  });
});
