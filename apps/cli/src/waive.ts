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
 * The same `waive()` the board calls, with the same arguments and the same
 * `actor()`. There is no second write path and no CLI-shaped event: a waiver
 * taken here is indistinguishable in the log from one taken on a card, and
 * `waive.test.ts` compares the two envelopes rather than leaving it to be
 * believed.
 *
 * **`--reason` is required and never defaulted.** *Humans need an escape hatch.
 * It is recorded, never silent* is the whole of `GateWaived`'s justification,
 * and a `--reason` that filled itself in — the way `--reject` defaults to "no
 * reason given" — would retire the event's only claim on being worth appending.
 */
import { actor, loadProject, waive } from "@lingtai/conductor";
import {
  gatesOn,
  reduceRun,
  reduceWorkItem,
  workItemStream,
  type GateVerdict,
} from "@lingtai/domain";
import { eventStore, type EventStore } from "@lingtai/event-store";
import { withProjector } from "./projector.ts";

export interface WaiveCommandOptions {
  project: string;
  issue: number;
  /** `point:action`, the composite key a verdict is recorded under. */
  gate: string;
  reason: string;
  by?: string;
  store?: EventStore;
}

/**
 * A gate has been decided when the pipeline has stopped having anything further
 * to say about it.
 *
 * `GateVerdict` has five values and only three of them are verdicts.
 * `requested` and `running` are the pipeline announcing that a gate is *about*
 * to have one: `runGatePipeline` emits `GateRequested` then `GateStarted` and
 * reports nothing more until `gate.run()` returns (`packages/actions/src/gate.ts`),
 * which for a build or a scan is minutes. The fold keys every gate event under
 * `point:action` and takes the last, so a waiver appended during those minutes
 * is overwritten by the gate's own verdict when it lands — the waiver is in the
 * log, and the card shows `failed`. Refusing is the only honest answer.
 */
function decided(verdict: GateVerdict): boolean {
  return verdict === "passed" || verdict === "failed" || verdict === "waived";
}

/**
 * The gates on the current head, or null when the question does not arise yet.
 *
 * Null for an item with no run and for a run with no diff, because `waive()`
 * already refuses both by name and saying it twice in two wordings is how two
 * vocabularies for one refusal start.
 *
 * **Why the listing is here and not in `waive()`.** A person on a card is
 * looking at the gates as they click; a person at a prompt typed the gate from
 * memory, and the commonest thing they have is a typo. The board's home card
 * also sends a placeholder gate name rather than the key it rendered
 * (`page.tsx`, `gates={... ? ["build"] : []}`), so tightening the shared path
 * would retire the very control this ticket is trying to reach — a different
 * ticket's fix, not this one's.
 */
async function gatesHere(
  store: EventStore,
  project: string,
  issue: number,
): Promise<{ gate: string; verdict: GateVerdict }[] | null> {
  const item = reduceWorkItem(await store.read(workItemStream(project, issue)));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) return null;

  const run = reduceRun(await store.read(runId));
  if (!run.headSha) return null;
  // On the current head, the same filter the fold applies everywhere else: a
  // verdict against a sha the branch has moved past is not a thing to waive.
  return gatesOn(run).map((g) => ({ gate: g.gate, verdict: g.verdict }));
}

/**
 * The refusal, when there is one — naming the actual state rather than the
 * absence of the expected one.
 *
 * That is the difference between a refusal and a dead end: "no such gate" sends
 * somebody back to the board to find out what there is, which is the trip this
 * command exists to remove.
 */
function refusal(gates: { gate: string; verdict: GateVerdict }[], gate: string): string | null {
  const named = gates.find((g) => g.gate === gate);

  if (!named) {
    const listed = gates.map((g) => `${g.gate} (${g.verdict})`).join(", ");
    return gates.length === 0
      ? "no gate verdict on this head — there is nothing to waive"
      : `no gate named "${gate}" — there is ${listed}`;
  }

  if (!decided(named.verdict)) {
    return (
      `${gate} is ${named.verdict}, not decided — it has no verdict to waive yet, and a ` +
      "waiver appended now is overwritten by its own verdict when that lands"
    );
  }

  return null;
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
  // Registered, and nothing more. `approve` demands an `owner` because it is
  // about to merge through GitHub; a waiver is an append and asks the network
  // nothing, so a project recorded before owners were is still one you can
  // decide about.
  if (!(await loadProject(options.project, store))) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }

  const by = options.by ?? actor();

  // A waiver changes what a card says, and this is run with the board open for
  // the same reason `lingtai approve` is — see `withProjector`.
  return withProjector(log, async () => {
    const gates = await gatesHere(store, options.project, options.issue);
    const refused = gates && refusal(gates, options.gate);
    if (refused) {
      log(refused);
      return 1;
    }

    const result = await waive({
      project: options.project,
      issue: options.issue,
      gate: options.gate,
      by,
      reason: options.reason,
      store,
    });

    log(result.detail);
    return result.ok ? 0 : 1;
  });
}
