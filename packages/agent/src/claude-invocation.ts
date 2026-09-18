import { readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import {
  AgentInvocationStarted, InvocationConfiguration, InvocationOwnership,
  type InvocationContainment,
} from "@lingtai/domain";
import { renderSettings } from "./hook-config.ts";
import {
  InvocationRefused, UNKNOWN_OBSERVATION,
  type InvocationRequest, type InvocationOutcome, type PreparedInvocation, type RuntimeSelection,
} from "./invocation.ts";
import type { RunOutcome, RunRequest } from "./runtime.ts";

export function supportsClaudeInvocation(selection: RuntimeSelection): void {
  const config = InvocationConfiguration.parse(selection.configuration);
  if (config.agent !== "claude-code") throw new InvocationRefused("unsupported", `Claude Code cannot execute ${config.agent}`);
  if (!["development", "fix", "review", "discussion"].includes(selection.role)) {
    throw new InvocationRefused("unsupported", `Claude Code does not support role ${selection.role}`);
  }
  if (config.requiredTier === "sandboxed") throw new InvocationRefused("unsupported", "Claude Code does not provide a filesystem sandbox");
  if (config.limits.turns === null) throw new InvocationRefused("configuration", "Claude Code requires an effective agentic turn limit");
}

type Execute = (request: RunRequest, discussion: boolean) => Promise<RunOutcome>;

/** Settings content belongs here; path, filtered environment and hook proof come from the host. */
export async function prepareClaudeInvocation(request: InvocationRequest, execute: Execute): Promise<PreparedInvocation> {
  supportsClaudeInvocation(request);
  InvocationOwnership.parse(request.ownership);
  if (request.role !== request.ownership.role) throw new InvocationRefused("configuration", "request role and ownership disagree");
  if ("LINGTAI_DATABASE_URL" in request.env || "LINGTAI_TEST_DATABASE_URL" in request.env) {
    throw new InvocationRefused("configuration", "host database credentials cannot enter an agent environment");
  }
  if (!isAbsolute(request.settingsPath) || !isAbsolute(request.cwd)) {
    throw new InvocationRefused("configuration", "cwd and host settings path must be absolute");
  }
  const cwd = await realpath(request.cwd);
  const settingsDirectory = await realpath(dirname(request.settingsPath));
  const path = relative(cwd, settingsDirectory);
  if (path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))) {
    throw new InvocationRefused("configuration", "agent settings must live outside its working directory");
  }
  const discussion = request.role === "discussion";
  if (discussion && (await readdir(cwd)).length !== 0) {
    throw new InvocationRefused("configuration", "discussion requires an empty host-owned working directory");
  }
  // Discussion has its own no-tools containment. Other guarded calls need the
  // same proven fail-closed hook as development, rather than claiming the tier
  // from the adapter's static capabilities on an unhooked reviewer.
  if (!discussion && request.configuration.requiredTier === "guarded" && !request.hooks) {
    throw new InvocationRefused("unsupported", "guarded invocation requires host-proven fail-closed hook wiring");
  }
  const containment: InvocationContainment = discussion
    ? { tier: "guarded", mechanism: "safe-mode; no-tools; strict-mcp; no-skills; default-permissions; empty-cwd", filesystemSandbox: false, commands: false, fileChanges: false }
    : { tier: request.hooks ? "guarded" : "open", mechanism: request.hooks ? "fail-closed-prompt-hook; worktree; filtered-env" : "worktree; filtered-env", filesystemSandbox: false, commands: true, fileChanges: true };
  AgentInvocationStarted.parse({ ...request.ownership, invocationId: request.invocationId,
    configuration: request.configuration, containment, cwd, onSha: request.onSha, startedAt: new Date(0).toISOString() });
  const settings = discussion
    ? { permissions: { defaultMode: "default", deny: ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "Task"] } }
    : request.hooks ? renderSettings({ runId: request.invocationId, hookBinary: request.hooks.hookBinary }) : {};
  // wx refuses collisions instead of replacing another call's protection.
  await writeFile(request.settingsPath, `${JSON.stringify(settings)}\n`, { mode: 0o600, flag: "wx" });
  let executed = false;
  let closed = false;
  const controller = new AbortController();
  let running: Promise<RunOutcome> | null = null;
  let closing: Promise<void> | null = null;
  return {
    containment,
    async execute(): Promise<InvocationOutcome> {
      if (executed || closed) throw new InvocationRefused("configuration", "a prepared invocation executes once, before it is closed");
      executed = true;
      let prompt: string;
      switch (request.role) {
        case "development": prompt = request.materials.prompt; break;
        case "fix": prompt = `${request.materials.prompt}\n\nFindings to repair:\n${JSON.stringify(request.materials.findings)}`; break;
        // The fixed review rubric is still assembled by actions, not replaced here.
        case "review": prompt = `${request.materials.prompt}\n\nDiff at ${request.onSha}:\n${request.materials.diff}`; break;
        case "discussion": prompt = `${request.materials.context}\n\nQuestion:\n${request.materials.question}`; break;
      }
      running = execute({
        runId: request.invocationId, cwd, prompt,
        ...(request.configuration.model === null ? {} : { model: request.configuration.model }),
        settingsPath: request.settingsPath, log: request.log, traceTools: !request.hooks,
        env: request.hooks && !discussion ? { ...request.env, LINGTAI_HOOK_RUN_ID: request.invocationId, LINGTAI_HOOK_SOCKET: request.hooks.socketPath } : request.env,
        limits: { turns: request.configuration.limits.turns!, wallMs: request.configuration.limits.wallMs },
        signal: request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal,
      }, discussion);
      const outcome = await running;
      return { ...outcome.observation ?? UNKNOWN_OBSERVATION,
        state: outcome.failure?.kind === "aborted" ? "interrupted" : outcome.failure ? "failed" : "succeeded",
        exitCode: outcome.exitCode, durationMs: outcome.durationMs, costUsd: outcome.costUsd, text: outcome.text,
        failure: outcome.failure ? { ...outcome.failure, detail: outcome.originalFailureDetail ?? outcome.failure.detail } : null };
    },
    async close() {
      closing ??= (async () => {
        closed = true;
        controller.abort();
        if (running) await running.catch(() => {});
        await rm(request.settingsPath, { force: true });
      })();
      await closing;
    },
  };
}
