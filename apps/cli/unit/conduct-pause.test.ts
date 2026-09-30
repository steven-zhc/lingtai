/**
 * A pause one project's run appended stops the next project in the same pass
 * (#210).
 *
 * `conductorPass` read the control stream once for the whole pass and then
 * walked every registered project. A run that meets an account-wide wall stands
 * the conductor down (0031 §3), and the project after it was claimed anyway,
 * straight into the same wall — the pause was on the log and nothing between
 * the two projects asked it.
 *
 * No database: `conductProjects` takes its store and each project's work as
 * parameters, so this is the per-project half with the work stood in for, as
 * `integration/conduct.test.ts` does on Postgres. The first project's work
 * appends the conductor's own pause; the claim is that the second is never
 * entered.
 */
import { loadProject } from "@lingtai/conductor";
import { readControl } from "@lingtai/daemon/control";
import { CONTROL_STREAM, projectStream } from "@lingtai/domain";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { describe, expect, it } from "vitest";
import { conductProjects } from "../src/conduct.ts";

describe("a pass across several projects", () => {
  it("asks whether the conductor is paused before each project, not once for the pass", async () => {
    const store = createMemoryEventStore();
    for (const project of ["first", "second"]) {
      await store.append(projectStream(project), 0, [
        {
          type: "ProjectConfigured",
          actor: "conductor",
          data: { project, owner: "steven-zhc", base: "main", configHash: "h", fromSha: "s" },
        },
      ]);
    }
    const projects = [(await loadProject("first", store))!, (await loadProject("second", store))!];

    const entered: string[] = [];
    const lines: string[] = [];
    const outcome = await conductProjects({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (line) => lines.push(line),
      paused: async () => {
        const c = await readControl(store);
        return c.paused ? `paused by ${c.by} — ${c.reason}` : null;
      },
      work: async (project, where) => {
        entered.push(project.project!);
        where.ref = "main";
        // What `standDownConductor` appends when a run never started: the
        // conductor's own pause, with a time on it.
        const until = new Date(Date.now() + 3_600_000).toISOString();
        await store.append(CONTROL_STREAM, (await store.read(CONTROL_STREAM)).length, [
          { type: "ConductorPaused", actor: "conductor", data: { by: "lingtai", reason: "the weekly limit", until } },
        ]);
        return "looked";
      },
    });

    expect(entered).toEqual(["first"]);
    expect(outcome.projects).toBe(1);
    expect(lines.join("\n")).toContain("second: not looked at — paused by lingtai — the weekly limit");
  });
});
