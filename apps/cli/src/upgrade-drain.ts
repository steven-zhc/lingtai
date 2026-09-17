/**
 * `lingtai upgrade`'s drain, once a log is configured — the doctor gate, the
 * request and the wait — separate from `entry.ts` so a test can run it against
 * a memory store.
 *
 * **A drain this person left standing is theirs to finish** (0042 §7, as
 * `lingtai restart` adopts one). Ctrl+C during the wait leaves the request
 * standing, and by the time `lingtai upgrade` is run again either of two things
 * is true:
 *
 * - **Nothing holds the lock.** The daemon finished and let go. Nothing is left
 *   to wait for, but the request still stands in the fold, and the board,
 *   `lingtai status` and every refusal that asks whether somebody wants this
 *   system stopped would go on saying yes — so it is withdrawn once the shim
 *   has moved.
 * - **Something holds it.** Maybe the daemon that read the request, and maybe
 *   one started since — which never reads a request older than itself (#159),
 *   so waiting on the old one would be waiting for ever. Which of the two it is
 *   cannot be told from here, so the old request is lifted and asked again, as
 *   `lingtai restart`'s `liftAdopted` does: a daemon that had already read it
 *   reads the new one too.
 *
 * **A refusal says what it leaves standing.** Doctor is gated before anything
 * is asked, and where this person's earlier drain is still standing the
 * refusal names it rather than saying nothing was asked to stop.
 */
import type { Asking, ControlState, Withdrawal } from "@lingtai/daemon";
import { paint } from "@lingtai/env/colour";
import type { Drained } from "./install.ts";

export interface UpgradeDrain {
  by: string;
  reason: string;
  /** Waive a red doctor, and nothing else. */
  despiteDoctor: boolean;
  /** Run `lingtai doctor`, print it, and say how many failures gate. */
  doctor: () => Promise<number>;
  holder: () => Promise<string | null>;
  control: () => Promise<Pick<ControlState, "shutdown">>;
  request: (by: string, reason: string) => Promise<Asking>;
  withdraw: (by: string, version: number, reason: string) => Promise<Withdrawal>;
  inFlight: () => Promise<string>;
  wait: () => Promise<"free" | "interrupted" | "gave-up">;
  log: (line: string) => void;
}

export async function drainForUpgrade(how: UpgradeDrain): Promise<Drained> {
  const { by, reason, log } = how;
  const withdrawing = (version: number): Drained => ({
    ok: true,
    after: async () => {
      await how.withdraw(by, version, `upgraded: ${reason}`);
    },
  });
  const theirs = (standing: { by: string; reason: string }): Drained => {
    log(
      paint.fail(
        `not upgrading: a shutdown asked by ${standing.by} — ${standing.reason} — is standing, ` +
          "and it is theirs to lift. Nothing was asked to stop by this command",
      ),
    );
    return { ok: false, code: 1 };
  };

  const earlier = (await how.control()).shutdown;
  const own = earlier !== null && earlier.by === by ? earlier : null;

  if ((await how.doctor()) > 0 && !how.despiteDoctor) {
    log(
      paint.fail(
        own === null
          ? "not upgrading: lingtai doctor failed, and nothing was asked to stop. --despite-doctor upgrades anyway, once read"
          : `not upgrading: lingtai doctor failed, and nothing more was asked to stop — but the drain you asked for earlier ` +
              `(${own.reason}) is still standing, and a daemon that read it still stops after its pass. ` +
              "lingtai resume lifts it; --despite-doctor upgrades anyway, once read",
      ),
    );
    return { ok: false, code: 1 };
  }

  const holder = await how.holder();
  if (holder === null) {
    if (own !== null) {
      log(`nothing is conducting — the drain you asked for (${own.reason}) is done, and is withdrawn once the shim moves`);
      return withdrawing(own.version);
    }
    log("nothing is conducting — nothing to drain");
    return { ok: true, after: async () => {} };
  }

  if (own !== null) {
    log(paint.held(`a drain you asked for is already standing (${own.reason}) — lifted, and asked again so ${holder} reads it.`));
    const lifted = await how.withdraw(by, own.version, "upgrading: taken over by a new upgrade, which asks its own");
    if (!lifted.withdrew && lifted.standing !== null && lifted.standing.by !== by) return theirs(lifted.standing);
  }

  const asked = await how.request(by, reason);
  if (!asked.asked && asked.standing.by !== by) return theirs(asked.standing);
  // Not asked, and ours: another command by this person asked between the
  // withdrawal and this, so it is newer than the daemon holding the lock too.
  const version = asked.asked ? asked.version : asked.standing.version;
  log(paint.held(`draining ${holder} — ${await how.inFlight()}.`));
  const waited = await how.wait();
  if (waited !== "free") return { ok: false, code: waited === "interrupted" ? 130 : 1 };
  return withdrawing(version);
}
