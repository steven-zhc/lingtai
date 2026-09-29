/**
 * The `RuntimeId → factory` table, and the claim that it is the only place.
 *
 * **The ticket's box is "a test adds a fake third `RuntimeId` and asserts nothing
 * outside the enum and the table had to change".** A test cannot add a member to
 * a zod enum, so the claim is made structurally instead, which is what it actually
 * means: every list of runtimes in the system is *derived* from `RuntimeId.options`
 * or from `RUNTIMES`, and none is written out. The two assertions below fail on the
 * day somebody writes one by hand, which is the day the third runtime becomes
 * invisible somewhere rather than broken.
 *
 * The exhaustiveness half is a *type* claim and not a runtime one:
 * `Record<RuntimeId, …>` makes a missing row a `tsc` error at the table, which is
 * better than an `undefined` at whichever call site reached for it first. The
 * `satisfies` line below is what pins that, and `pnpm typecheck` is where it
 * fails.
 */
import { describe, expect, it } from "vitest";
import { RuntimeId } from "@lingtai/domain";
import {
  FIRST_RUNTIME,
  RUNTIMES,
  ToolsCannotBeDenied,
  createRuntime,
  createToollessRuntime,
  everyRuntime,
} from "../src/runtimes.ts";
import { AUTH_PROBES } from "../src/auth.ts";
import type { Runtime } from "../src/runtime.ts";

describe("the table", () => {
  it("has a row for every RuntimeId and no row for anything else", () => {
    expect(Object.keys(RUNTIMES).sort()).toEqual([...RuntimeId.options].sort());
  });

  /**
   * **A key that disagrees with its row is the silent pick 0046 §3 forbids**, one
   * level below where `agentRefusal` catches it: `conduct.ts` constructs from
   * `runtime.agent` and then compares `capabilities.id` against the same field, so
   * a row filed under the wrong key would make that comparison pass while the
   * wrong binary ran.
   */
  it("builds, for each id, a runtime that says it is that id", () => {
    for (const id of RuntimeId.options) {
      expect(createRuntime(id).capabilities.id).toBe(id);
      expect(RUNTIMES[id]().capabilities.id).toBe(id);
    }
  });

  it("is exhaustive as a type, so a new enum member is a tsc error here", () => {
    // Not a runtime assertion — it is the `satisfies` that carries the claim, and
    // `pnpm typecheck` is where it fails. Written down because the guarantee is
    // the reason there is no `undefined` branch in `createRuntime`.
    const exhaustive = RUNTIMES satisfies Record<RuntimeId, (o?: never) => Runtime>;
    expect(Object.keys(exhaustive)).toHaveLength(RuntimeId.options.length);
  });
});

/**
 * **The second table, and why it is allowed to exist.**
 *
 * `RUNTIMES[id]().checkAuth` is the same probe `AUTH_PROBES` holds, so this looks
 * like duplication to delete. It is not: `lingtai init` asks which agent a machine
 * has *before there is a log*, and reaching the factory table loads
 * `claude-code.ts` → `hook-socket.ts` → `@lingtai/event-store`, whose client is
 * built at module scope and throws without a database URL. `auth.ts` exists for
 * exactly that reason (see its header).
 *
 * What keeps the two from drifting is the type, not vigilance: both are
 * `Record<RuntimeId, …>`, so a third runtime is a `tsc` error in both. These
 * assertions write that down where somebody counting the places a runtime is
 * named would look.
 */
describe("the auth probe table, which init reads before there is a log", () => {
  it("has the same keys as the factory table, because both are total over the enum", () => {
    expect(Object.keys(AUTH_PROBES).sort()).toEqual(Object.keys(RUNTIMES).sort());
    expect(Object.keys(AUTH_PROBES).sort()).toEqual([...RuntimeId.options].sort());
  });

  it("answers every id with a function, so no id is probed by position", () => {
    // It was `Promise.all([claudeCodeAuth(…), codexAuth(…)])` indexed against a
    // written-out list of ids — one insertion from reporting Codex's answer under
    // Claude Code's name.
    for (const id of RuntimeId.options) expect(AUTH_PROBES[id]).toBeTypeOf("function");
  });
});

describe("what a caller may ask of any runtime", () => {
  /**
   * 0054 applied one ticket early: the caller says what the agent is *for*, and
   * each row translates into its own vocabulary. A table typed on
   * `ClaudeCodeOptions` would make every other row translate `permissionMode`, a
   * word it does not have.
   */
  it("takes runtime-neutral options every row can answer", () => {
    for (const id of RuntimeId.options) {
      expect(createRuntime(id, { tools: "full" }).capabilities.id).toBe(id);
      expect(createRuntime(id, { binary: "/nowhere/stand-in" }).capabilities.id).toBe(id);
    }
  });

  /**
   * **`tools: "none"` is a promise and not a preference, so a row that cannot
   * keep it refuses by name.**
   *
   * Codex's row translated it to `-s read-only`, which forbids writes and forbids
   * nothing else — measured on `codex-cli 0.155.1`, a Codex agent in an empty
   * directory under `-s read-only` was asked to `ls /Users/steven` and printed
   * it. `answerDiscussion`'s containment is a Claude Code settings file whose
   * docstring is *"Every tool, denied"*, and Codex reads no such file:
   * `codexHookArgs` looks for a `hooks` key, finds none, returns `[]`, and
   * nothing reported that the deny list had been dropped. That is 0007's
   * *"never silently downgrades"* one layer along.
   */
  it("refuses a runtime that has no way to be given no tools, by name", () => {
    expect(createRuntime("claude-code", { tools: "none" }).capabilities.id).toBe("claude-code");
    expect(() => createRuntime("codex", { tools: "none" })).toThrow(ToolsCannotBeDenied);
    expect(() => createRuntime("codex", { tools: "none" })).toThrow(/read-only/);
    // `full` is unaffected: a Codex *implementer* is what the sandbox is for.
    expect(createRuntime("codex", { tools: "full" }).capabilities.id).toBe("codex");
    expect(createRuntime("codex").capabilities.id).toBe("codex");
  });

  /**
   * **A row that cannot be given no tools is a reason to ask another row, not to
   * stop answering.**
   *
   * `answerDiscussion` is the caller and it refused instead for a while: a project
   * whose recipe named Codex then had *every* board question answered with the
   * refusal, permanently — 0033's third kind of agent traded away for a field that
   * decides which runtime works the project's tickets and has nothing to do with a
   * discussion. Preferring the named one is still right, because a machine signed
   * in to one runtime alone should answer with the one it has; what is wrong is
   * stopping there. The containment is not what falls back: what comes back can be
   * given no tools, which is the whole of what was asked for.
   */
  it("falls back to a runtime that can be given no tools, preferring the one named", () => {
    const first = createToollessRuntime("claude-code");
    expect(first?.id).toBe("claude-code");
    // Null means *the named one answered*, so a caller can say which is which.
    expect(first?.instead).toBeNull();

    const second = createToollessRuntime("codex");
    expect(second?.id).toBe("claude-code");
    expect(second?.instead).toBe("codex");

    // Every id gets an answer, which is the claim the board depends on.
    for (const id of RuntimeId.options) expect(createToollessRuntime(id)).not.toBeNull();
  });
});

describe("every runtime, for asking all of them something", () => {
  /**
   * `projects.ts`'s sign-in probe is the caller, and the probe is the one place a
   * forgotten runtime is **invisible rather than broken**: detection is allowed
   * only when exactly one is signed in (0046 §3), so a missing row makes *the only
   * runtime signed in* a reason that is false.
   */
  it("is the table's own values, so a row is all a third runtime needs", () => {
    expect(everyRuntime().map((r) => r.capabilities.id).sort()).toEqual([...RuntimeId.options].sort());
    expect(everyRuntime()).toHaveLength(Object.keys(RUNTIMES).length);
  });

  it("gives each one a checkAuth, so the probe can ask", () => {
    // `signedInProbe` reads `checkAuth?.()`; a runtime that cannot be asked is
    // reported as not signed in, which for a runtime that *is* would be wrong.
    for (const runtime of everyRuntime()) expect(runtime.checkAuth).toBeTypeOf("function");
  });

  /**
   * Both adapters answer `invocation()` now, which is what `RunStarted.invocation`
   * records before a run happens. A runtime that cannot say must not pretend — the
   * field is optional for that reason — but neither of these two is that runtime.
   */
  it("gives each one an invocation, so RunStarted records how it was spawned", () => {
    for (const runtime of everyRuntime()) expect(runtime.invocation).toBeTypeOf("function");
  });
});

describe("the preference order, where more than one is signed in", () => {
  /**
   * `propose.ts` picks among ids *already signed in* — it constructs nothing, so
   * it does not read `RUNTIMES` — and what it needs is an order. The enum has one,
   * and it is the same order the ternary hardcoded.
   */
  it("is the enum's own, with claude-code first", () => {
    expect(RuntimeId.options[0]).toBe("claude-code");
    // `FIRST_RUNTIME` is the one named fallback in the system — `discuss.ts`,
    // asked about a project no recipe covers. Pinned here so it cannot drift from
    // the order `propose.ts` proposes in: two answers to "which one, absent a
    // recipe" would be two answers to one question.
    expect(FIRST_RUNTIME).toBe(RuntimeId.options[0]);
    const prefer = (signedIn: readonly string[]) =>
      RuntimeId.options.find((id) => signedIn.includes(id)) ?? null;
    expect(prefer(["codex", "claude-code"])).toBe("claude-code");
    expect(prefer(["codex"])).toBe("codex");
    expect(prefer([])).toBeNull();
  });
});
