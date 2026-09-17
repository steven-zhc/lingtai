/**
 * `lingtai upgrade`'s drain, once a log is configured and doctor has gated —
 * separate from `entry.ts` so a test can run it against a memory store.
 *
 * **A drain this person left standing is theirs to finish** (0042 §7, as
 * `lingtai restart` adopts one). Ctrl+C during the wait leaves the request
 * standing and says `lingtai upgrade` again waits on it; by the time it is run
 * again the daemon may have finished and let go of the lock. Nothing is left to
 * wait for then, but the request still stands in the fold, and the board, `lingtai
 * status` and every refusal that asks whether somebody wants this system stopped
 * would go on saying yes — so it is withdrawn once the shim has moved, whether
 * or not anything was conducting.
 */
import type { Asking, ControlState, Withdrawal } from "@lingtai/daemon";
import { paint } from "@lingtai/env/colour";
import type { Drained } from "./install.ts";

export interface UpgradeDrain {
  by: string;
  reason: string;
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

  const holder = await how.holder();
  if (holder === null) {
    const standing = (await how.control()).shutdown;
    if (standing !== null && standing.by === by) {
      log(`nothing is conducting — the drain you asked for (${standing.reason}) is done, and is withdrawn once the shim moves`);
      return withdrawing(standing.version);
    }
    log("nothing is conducting — nothing to drain");
    return { ok: true, after: async () => {} };
  }
  const asked = await how.request(by, reason);
  if (!asked.asked && asked.standing.by !== by) {
    log(
      paint.fail(
        `not upgrading: a shutdown asked by ${asked.standing.by} — ${asked.standing.reason} — is standing, ` +
          "and it is theirs to lift. Nothing was asked to stop by this command",
      ),
    );
    return { ok: false, code: 1 };
  }
  const version = asked.asked ? asked.version : asked.standing.version;
  log(paint.held(`draining ${holder} — ${await how.inFlight()}.`));
  const waited = await how.wait();
  if (waited !== "free") return { ok: false, code: waited === "interrupted" ? 130 : 1 };
  return withdrawing(version);
}
