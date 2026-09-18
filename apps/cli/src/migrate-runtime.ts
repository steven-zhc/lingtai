/** A configuration command. It reads registration but never claims or starts work. */
import { stateDir } from "@lingtai/env";
import { isPending, isRegistered, type ProjectState, type RuntimeId } from "@lingtai/domain";
import {
  applyRuntimeMigration, previewRuntimeMigration,
  type RuntimeMigrationOptions, type RuntimeMigrationPlan,
} from "@lingtai/recipe";

export const MIGRATE_RUNTIME_USAGE = "lingtai migrate-runtime [--dry-run | --apply] [--agent <project=claude-code|codex>]\nlingtai upgrade --migrate-runtime [--dry-run | --apply] [--agent <project=claude-code|codex>]";
export interface MigrationWorld extends RuntimeMigrationOptions { log: (line: string) => void }

function report(plan: RuntimeMigrationPlan, log: MigrationWorld["log"]) {
  log(`${plan.resuming ? "resuming" : "preview"}: ${plan.projects.length} registered/pending project(s) in ${plan.home}`);
  for (const change of plan.changes) {
    log(`${change.disposition}: ${change.path}:${change.field} ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)} ← ${change.source}`);
  }
  for (const problem of plan.problems) log(`unresolved: ${problem}`);
}
export async function migrateRuntimeCommand(argv: readonly string[], world: MigrationWorld): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { world.log(MIGRATE_RUNTIME_USAGE); return 0; }
  const agents: Record<string, RuntimeId> = {};
  let invalid = argv.includes("--apply") && argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply" || argv[i] === "--dry-run") continue;
    if (argv[i] !== "--agent") { invalid = true; break; }
    const match = /^([\w.-]+)=(claude-code|codex)$/.exec(argv[++i] ?? "");
    if (!match || match[1] === "." || match[1] === ".." || agents[match[1]!] !== undefined) { invalid = true; break; }
    agents[match[1]!] = match[2] as RuntimeId;
  }
  if (invalid) {
    world.log(MIGRATE_RUNTIME_USAGE); return 2;
  }
  const options = { ...world, agents: { ...world.agents, ...agents } };
  try {
    const preview = await previewRuntimeMigration(options);
    report(preview, world.log);
    if (preview.problems.length) return 1;
    if (!argv.includes("--apply")) {
      world.log("dry-run: nothing was written; lingtai migrate-runtime --apply backs up and applies every project before machine cleanup");
      return 0;
    }
    // Apply replans under the conductor lock and revalidates inputs; it never
    // treats a stale preview as authorization to overwrite newer bytes.
    await applyRuntimeMigration(options);
    world.log("runtime migration complete: project recipes are the runtime source; backups are under migrations/; no work was started");
    return 0;
  } catch (error) { world.log(error instanceof Error ? error.message : String(error)); return 1; }
}

/** Pending streams already own files from the old wizard and must migrate before Recheck. */
export function migrationProjects(states: readonly ProjectState[]) {
  return states.filter((p) => isRegistered(p) || isPending(p))
    .flatMap((p) => p.project ? [{ project: p.project, base: p.base }] : []);
}

export function liveMigrationWorld(): MigrationWorld {
  return {
    home: stateDir(), log: (line) => console.log(line),
    registered: async () => {
      const { loadAllProjects } = await import("@lingtai/conductor/projects");
      return migrationProjects(await loadAllProjects());
    },
    signedIn: async () => {
      const { signedInHere } = await import("@lingtai/conductor/projects");
      return signedInHere();
    },
  };
}
