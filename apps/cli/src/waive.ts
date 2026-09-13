/**
 * `lingtai waive <project> --issue <n> --gate <point:action> --reason <why>` —
 * merging past a verdict from the terminal the verdict was read in.
 *
 * The escape hatch existed and could only be reached from a browser on the
 * machine running the daemon (#129). The case it exists for — a flaky check, a
 * scan whose service is down, a failure a person has read and judged unrelated
 * — arrives while that person is already at a prompt looking at why the gate is
 * wrong, which is the one place the decision could not be taken.
 *
 * The same `waive()` the board's `waiveGate` calls, with the same actor and an
 * `onSha`, so there is no second write path and no CLI-shaped event:
 * `waive.test.ts` folds the item the way the board does, sends what its card
 * would send, and compares the two envelopes.
 *
 * **`--reason` is required and never defaulted.** *Humans need an escape hatch.
 * It is recorded, never silent* is the whole of `GateWaived`'s justification,
 * and a `--reason` that filled itself in — the way `--reject` defaults to "no
 * reason given" — would retire the event's only claim on being worth appending.
 */
import { loadProject, waive } from "@lingtai/conductor";
import {
  gatesOn,
  parsePayload,
  reduceRun,
  reduceWorkItem,
  workItemStream,
  type GateVerdict,
} from "@lingtai/domain";
import { eventStore, type EventStore } from "@lingtai/event-store";
import { withProjector } from "./projector.ts";
import { userInfo } from "node:os";

export interface WaiveCommandOptions {
  project: string;
  issue: number;
  /** `point:action`, the composite key a verdict is recorded under. */
  gate: string;
  reason: string;
  by?: string;
  store?: EventStore;
}

/** What a gate on the current head says, or that the run planned it and nothing ran. */
type Standing = GateVerdict | "planned";

/**
 * The gates a waiver on the latest run could name, or null when `waive()` will
 * refuse anyway — no run, or no diff — and says so in its own words.
 *
 * Two sources, and a waiver is legitimate against either:
 *
 * - **Any verdict on the head**, whatever it is. `running` and `requested`
 *   included: a run that ended — Ctrl+C twice, `--timeout` — while a scan hung
 *   leaves `GateStarted` as the last word on that gate for ever, since only
 *   `gate.run()` returning appends another. That is the ticket's own case.
 * - **Every `point:action` the run's `GatesResolved` planned**, verdict or not.
 *   `gate-audit.ts` names a waiver as the only thing that closes
 *   `landedWithoutGatePoints`, which is by definition a planned gate with no
 *   event behind it.
 *
 * `end` is left out: it runs for effect and has no verdict to be past.
 */
function gatesHere(
  events: Awaited<ReturnType<EventStore["read"]>>,
): { headSha: string; gates: Map<string, Standing> } | null {
  const run = reduceRun(events);
  if (!run.headSha) return null;

  const gates = new Map<string, Standing>();
  // A later `GatesResolved` is a later plan, so the last one wins.
  const plan = events.filter((e) => e.type === "GatesResolved").at(-1);
  if (plan) {
    for (const point of parsePayload("GatesResolved", plan.data).points) {
      if (point.gate === "end") continue;
      for (const action of point.actions) gates.set(`${point.gate}:${action}`, "planned");
    }
  }
  // On the current head, the filter the fold applies everywhere else: a verdict
  // against a sha the branch has moved past is not a thing to waive.
  for (const g of gatesOn(run)) gates.set(g.gate, g.verdict);
  return { headSha: run.headSha, gates };
}

/**
 * The refusal, naming the state there is rather than the absence of the one
 * expected. "No such gate" sends a person back to the board to find out what
 * the gates are called, which is the trip this command exists to remove.
 */
function refusal(gates: Map<string, Standing>, gate: string): string | null {
  if (gates.has(gate)) return null;
  if (gates.size === 0) {
    return `no gate named "${gate}" — this run has no verdict on its head and planned no gate, so there is nothing to waive`;
  }
  const listed = [...gates].map(([name, s]) => `${name} (${s === "planned" ? "planned, no verdict" : s})`);
  return `no gate named "${gate}" — there is ${listed.join(", ")}`;
}

export async function waiveCommand(
  options: WaiveCommandOptions,
  log = console.log,
): Promise<number> {
  if (!options.reason.trim()) {
    log("lingtai waive <project> --issue <n> --gate <point:action> --reason <why>");
    log("a waiver needs a reason — it is recorded, never silent");
    return 2;
  }

  const store = options.store ?? eventStore;
  // Checked before the stream is read, so a mistyped project says so rather
  // than `wi-lingati-129 has never been run`.
  if (!(await loadProject(options.project, store))) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }

  // A waiver changes what a card says, and this is run with the board open for
  // the same reason `lingtai approve` is — see `withProjector`.
  return withProjector(log, async () => {
    const item = reduceWorkItem(await store.read(workItemStream(options.project, options.issue)));
    const runId = item.runs.at(-1);
    const here = runId ? gatesHere(await store.read(runId)) : null;

    if (here) {
      const refused = refusal(here.gates, options.gate);
      if (refused) {
        log(refused);
        return 1;
      }
      const standing = here.gates.get(options.gate);
      if (standing === "requested" || standing === "running") {
        // Said, not refused. If the gate is genuinely still executing, its own
        // verdict lands after this and the card shows that; if the run that
        // started it is over, nothing else will ever be appended for it.
        log(`${options.gate} is ${standing} with no verdict — waiving it as it stands`);
      }
    }

    const result = await waive({
      project: options.project,
      issue: options.issue,
      gate: options.gate,
      // The local account: a weak claim, but a true one, and the same one the
      // board records (0007).
      by: options.by ?? `human:${userInfo().username}`,
      reason: options.reason,
      // The head the gates above were read on, so a branch that moves between
      // that read and the append is refused by `waive()` — exactly as the
      // board's click is — rather than waived unread.
      ...(here ? { onSha: here.headSha } : {}),
      store,
    });

    log(result.detail);
    return result.ok ? 0 : 1;
  });
}
