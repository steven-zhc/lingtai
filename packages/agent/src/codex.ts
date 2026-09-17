/**
 * The Codex adapter — a stub with its capabilities declared, and deliberately
 * nothing else.
 *
 * Both runtimes are designed for from day one because retrofitting the interface
 * later is a refactor. Implementing the second one *now* would be guessing at
 * the wrong abstractions: the contract has not yet survived a single real run,
 * and the first thing a second implementation does is harden whatever the first
 * one got wrong. See doc/decisions/0007-dual-runtime.md.
 *
 * What is real here is the capability declaration. The scheduler matches against
 * it before dispatching, so a project requiring `sandboxed` can already be told
 * that Codex could carry it and Claude Code could not — the decision does not
 * wait on the implementation.
 */
import { spawn } from "node:child_process";
import type { AuthStatus, RunOutcome, RunRequest, Runtime, RuntimeCapabilities } from "./runtime.ts";

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  id: "codex",
  // The intersection only. Codex has no SessionEnd, PreCompact or Notification,
  // which is exactly why the adapter contract is the intersection.
  hooks: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  canFailClosed: true,
  // Codex can rewrite a tool call, not merely refuse it.
  canRewriteToolCall: true,
  // `sandbox_mode: workspace-write` is a real filesystem boundary, which is more
  // than Claude Code provides on its own.
  providesTier: "sandboxed",
  // Neither, because nothing here runs. A stub claiming a bound it does not
  // apply would be `#89` written down on purpose.
  enforces: [],
};

export class CodexNotImplementedError extends Error {
  override readonly name = "CodexNotImplementedError";
  constructor() {
    super(
      "the Codex adapter is a stub — its capabilities are declared so the scheduler " +
        "can match against them, but nothing dispatches to it yet (#34).",
    );
  }
}

export function createCodexRuntime(options: { binary?: string } = {}): Runtime {
  const binary = options.binary ?? "codex";
  return {
    capabilities: CODEX_CAPABILITIES,
    run(_request: RunRequest): Promise<RunOutcome> {
      // Loudly, and naming the issue. A stub that returned a plausible-looking
      // outcome would be worse than one that refuses.
      return Promise.reject(new CodexNotImplementedError());
    },

    /**
     * `codex login status`, in the environment a run would get.
     *
     * Real, though the adapter is not: which runtimes are signed in decides
     * whether `runtime.agent` may be detected at all (0046 §3), and a machine
     * signed in to both must be asked rather than handed the one that happened
     * to have a probe. The exit code is the answer — 0 `Logged in using …`,
     * 1 `Not logged in` — and a missing binary is not signed in.
     */
    async checkAuth(env: Record<string, string>): Promise<AuthStatus> {
      return new Promise<AuthStatus>((resolve) => {
        const child = spawn(binary, ["login", "status"], {
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let out = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString()));
        child.stderr.on("data", (c: Buffer) => (out += c.toString()));

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ loggedIn: false, method: null, detail: "codex login status did not answer in 20s" });
        }, 20_000);

        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ loggedIn: false, method: null, detail: e.message });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          const detail = (out.trim() || "no output").slice(0, 300);
          resolve({ loggedIn: code === 0, method: null, detail });
        });
      });
    },
  };
}
