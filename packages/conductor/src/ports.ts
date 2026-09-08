/**
 * What the conductor needs from outside itself, named as interfaces.
 *
 * [0022](../../../doc/decisions/0022-the-seams.md) step 5. The conductor
 * decides; `repo` and `agent` touch the world. Before this, `run-once.ts`
 * imported `provisionWorktree`, `git`, `integrate`, `createHookServer` and
 * `resolveAgentEnv` directly, so **the only way to test a decision was to
 * perform it** — which is why every one of this package's tests appends real
 * events and the suite refuses to start without `TEST_DATABASE_URL`.
 *
 * `tellGitHub`'s `IssueChannel` (`f52229b`) drew the first port this way and
 * this copies its shape: the method set the caller actually uses, no wider.
 *
 * **The option and result types are imported rather than redeclared.** They are
 * data — a worktree's path and base sha, a merge's outcome — and copying them
 * here would give one shape two definitions and a drift nobody would notice.
 * What must not be imported is the *implementation*, and none is.
 */
import type { AgentEnv } from "@lingtai/agent-env";
import type {
  HookServer,
  HookServerOptions,
  HookWiring,
  RenderOptions,
} from "@lingtai/agent";
import type {
  GitRunOptions,
  IntegrateOptions,
  IntegrateResult,
  ProvisionOptions,
  Worktree,
} from "@lingtai/repo";

/** Everything a run does to a git repository. */
export interface RepoPort {
  provision(options: ProvisionOptions): Promise<Worktree>;
  /**
   * Removing is separate from provisioning and never optional.
   *
   * The worktree holds a branch checked out, which stops git updating that ref
   * — so it has to be gone *before* the integrator touches the lane, on every
   * path including a refusal. That ordering is the reason this is a port and
   * not a convenience: a fake can assert it.
   */
  remove(options: { project: string; runId: string; home?: string }): Promise<void>;
  git(args: string[], options?: GitRunOptions): Promise<string>;
  integrate(options: IntegrateOptions): Promise<IntegrateResult>;
}

/** Everything a run needs to start an agent and hear what it reports. */
export interface AgentHostPort {
  wire(options: RenderOptions): Promise<HookWiring>;
  /**
   * Proves the hook refuses when it cannot reach the socket.
   *
   * A hook that fails *open* records nothing and says nothing, which is the one
   * failure the whole hook exists to prevent — so this runs before every
   * dispatch rather than once at startup.
   */
  smokeTest(
    hookBinary: string,
    run: (bin: string, env: Record<string, string>, stdin: string) => Promise<{
      code: number | null;
      stderr: string;
    }>,
  ): Promise<{ ok: boolean; detail: string }>;
  serve(options: HookServerOptions): HookServer;
  resolveEnv(options: {
    project: string;
    required: readonly string[];
    source?: NodeJS.ProcessEnv;
    home?: string;
    patterns?: readonly string[];
  }): Promise<AgentEnv>;
}

/** The two together, which is what a run is handed. */
export interface RunPorts {
  repo: RepoPort;
  agent: AgentHostPort;
}
