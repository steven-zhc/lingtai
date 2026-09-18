/** Explicit, all-project migration. The log supplies membership, never runtime choices. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";
import { createFileLocker } from "@lingtai/env/lock";
import { RuntimeId } from "@lingtai/domain";
import { LIMIT_DEFAULTS } from "./limits.ts";
import { applyPreset } from "./presets.ts";
import { resolveSource } from "./resolve.ts";
import { AgentUnresolvedError, legacyRuntimeFields, machinePath, parseMachineConfig, recipePath, resolveAgent, type SignedIn } from "./local.ts";

export interface MigrationProject { project: string; base?: string | null }
export interface MigrationChange {
  project: string | null; path: string; field: string;
  before: unknown; after: unknown; source: string; disposition: "migrate" | "preserve" | "conflict";
}
const File = z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable(), kind: z.enum(["recipe", "machine"]) });
const Journal = z.object({ version: z.literal(1), id: z.string().uuid(), home: z.string(), projects: z.array(z.string()), files: z.array(File), complete: z.boolean() });
type Journal = z.infer<typeof Journal>;
export interface RuntimeMigrationPlan {
  home: string; projects: string[]; files: z.infer<typeof File>[];
  changes: MigrationChange[]; problems: string[]; resuming: boolean;
}
export interface RuntimeMigrationOptions {
  /** Required: tests and callers cannot accidentally migrate the real home. */
  home: string;
  registered: () => Promise<readonly MigrationProject[]>;
  signedIn: SignedIn;
  /** Explicit migration choices, independent of existing recipe intent. */
  agents?: Readonly<Record<string, RuntimeId>>;
}
export class RuntimeMigrationRefused extends Error {
  override readonly name = "RuntimeMigrationRefused";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`runtime migration refused:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}
const journalPath = (home: string) => join(home, "migrations", "runtime-v1.json");
async function read(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function projectNames(projects: readonly MigrationProject[]): string[] {
  const names = projects.map((p) => p.project).sort();
  if (new Set(names).size !== names.length || names.some((n) => !/^[\w.-]+$/.test(n) || n === "." || n === "..")) {
    throw new RuntimeMigrationRefused(["registered projects must have distinct, safe project names"]);
  }
  return names;
}
async function loadJournal(home: string): Promise<Journal | null> {
  const source = await read(journalPath(home));
  if (source === null) return null;
  const parsed = Journal.parse(JSON.parse(source));
  if (parsed.home !== home || !isDeepStrictEqual(parsed.projects, projectNames(parsed.projects.map((project) => ({ project }))))) {
    throw new RuntimeMigrationRefused([`${journalPath(home)} has a different home or invalid project list`]);
  }
  const expected = [...parsed.projects.map((p) => recipePath(p, home)), machinePath(home)];
  if (!isDeepStrictEqual(parsed.files.map((f) => f.path), expected)
    || parsed.files.some((f, i) => f.kind !== (i === expected.length - 1 ? "machine" : "recipe") || (f.kind === "recipe" && (f.before === null || f.after === null)))) {
    throw new RuntimeMigrationRefused([`${journalPath(home)} has invalid migration-owned paths`]);
  }
  return parsed;
}

/** Reads everything before planning. Preview never creates directories, backups, journals or locks. */
export async function previewRuntimeMigration(options: RuntimeMigrationOptions): Promise<RuntimeMigrationPlan> {
  const home = resolve(options.home);
  const registered = await options.registered();
  const projects = projectNames(registered);
  const paths = [...projects.map((p) => recipePath(p, home)), machinePath(home)];
  const sources = await Promise.all(paths.map(read));
  const journal = await loadJournal(home);
  const problems: string[] = [];
  const plan: RuntimeMigrationPlan = { home, projects, files: [], changes: [], problems, resuming: journal !== null && !journal.complete };
  for (const [project, agent] of Object.entries(options.agents ?? {})) {
    if (!projects.includes(project)) problems.push(`${project}: migration agent choice has no registered/pending project`);
    if (!RuntimeId.safeParse(agent).success) problems.push(`${project}: invalid migration agent ${agent}`);
  }
  if (journal && !journal.complete) {
    if (!isDeepStrictEqual(projects, journal.projects)) problems.push("registered projects changed during migration; restore the original membership before resuming; legacy sources are retained");
    journal.files.forEach((file, i) => {
      if (sources[i] !== file.before && sources[i] !== file.after) problems.push(`${file.path} changed since migration began; restore its original or planned bytes before resuming`);
    });
    if (problems.length) return plan;
  }
  // The journal retains the pre-migration source. A partly written recipe must
  // not become a spurious conflict with the still-present global source.
  const original = journal && !journal.complete ? journal.files.map((f) => f.before) : sources;
  const machineSource = original[original.length - 1]!;
  const machine = parseMachineConfig(machineSource, machinePath(home), projects[0] ?? "project", home);
  const legacy = legacyRuntimeFields(machine);
  if (legacy.length && !projects.length) problems.push("legacy runtime fields have no registered project to receive them; register the projects before applying");
  for (const name of Object.keys(machine.projects ?? {})) {
    if (!projects.includes(name) && legacy.some((f) => f.startsWith(`projects.${name}.runtime.`))) problems.push(`projects.${name}.runtime has recorded choices but ${name} is not registered; its fields will not be deleted`);
  }
  let detected: Promise<readonly RuntimeId[]> | undefined;
  const signedIn: SignedIn = () => detected ??= options.signedIn();
  for (const [i, project] of projects.entries()) {
    const path = recipePath(project, home);
    const source = original[i]!;
    if (source === null) { problems.push(`${project}: missing registered project recipe ${path}`); continue; }
    const doc = parseDocument(source);
    try {
      if (doc.errors.length || !isMap(doc.contents)) throw new Error(`${path} must parse as a YAML mapping: ${doc.errors.map((e) => e.message).join("; ")}`);
      const base = registered.find((p) => p.project === project)?.base ?? path;
      // Validate declarations before detection or any transformation can hide a typo.
      resolveSource(source, base, path, (raw) => {
        if (raw["runtime"] === undefined) raw["runtime"] = {};
        return (raw["runtime"] as Record<string, unknown> | null)?.["assignee"] !== undefined
          ? ["runtime.assignee belongs in the machine file; migration does not move it"] : [];
      });
      const preset = applyPreset(doc.toJS());
      const expanded = preset.recipe as { runtime?: { agent?: RuntimeId; model?: string; limits?: Record<string, unknown> }; discussion?: {runtime?: {agent?: RuntimeId; model?: string; limits?: {turns?: number; wall?: string}}} };
      const declared = expanded.runtime ?? {};
      const shared = machine.runtime;
      const scoped = machine.projects?.[project]?.runtime;
      const hasLegacy = scoped?.agent !== undefined || scoped?.limits !== undefined || shared?.agent !== undefined || shared?.limits !== undefined;
      // Already configured recipes without an applicable old source are new
      // project intent. They must not acquire old discussion/default limits.
      const selected = options.agents?.[project];
      const resumeWrite = plan.resuming && journal!.files[i]!.before !== journal!.files[i]!.after;
      if (!hasLegacy && declared.agent !== undefined && selected === undefined && !resumeWrite) {
        plan.files.push({ path, before: source, after: source, kind: "recipe" });
        plan.changes.push({ project, path, field: "runtime.agent", before: declared.agent, after: declared.agent, source: path, disposition: "preserve" });
        continue;
      }
      const savedAgent = plan.resuming ? (parseDocument(journal!.files[i]!.after!).toJS() as { runtime?: { agent?: RuntimeId } }).runtime?.agent : undefined;
      const recordedAgent = scoped?.agent ?? shared?.agent;
      if (selected !== undefined && recordedAgent !== undefined && selected !== recordedAgent) problems.push(`${project}: --agent ${project}=${selected} conflicts with recorded machine agent ${recordedAgent}; adjust that recorded source explicitly`);
      if (selected !== undefined && savedAgent !== undefined && selected !== savedAgent) problems.push(`${project}: --agent ${project}=${selected} conflicts with journaled agent ${savedAgent}; resume with the recorded choice`);
      const namedAgent = recordedAgent ?? selected ?? (declared.agent === undefined ? savedAgent : undefined);
      const agentSource = scoped?.agent !== undefined ? `${machinePath(home)}:projects.${project}.runtime.agent`
        : shared?.agent !== undefined ? `${machinePath(home)}:runtime.agent` : selected !== undefined ? `--agent ${project}=${selected}` : `${journalPath(home)}:recorded runtime.agent`;
      const agent = await resolveAgent(namedAgent !== undefined ? { agent: namedAgent, from: agentSource }
        : declared.agent !== undefined ? { agent: declared.agent, from: path } : null, signedIn, path)
        .catch((error: unknown) => {
          if (!(error instanceof AgentUnresolvedError)) throw error;
          throw new Error(`${path}: no unique agent choice; preview with lingtai migrate-runtime --agent ${project}=<claude-code|codex>, then repeat with --apply; this preserves legacy discussion without editing recipe intent`);
        });
      const put = (field: string, value: unknown, from: string, existing?: unknown) => {
        const at = field.split(".");
        const before = existing;
        const conflict = before !== undefined && !isDeepStrictEqual(before, value);
        plan.changes.push({ project, path, field, before: before ?? null, after: conflict ? before : value, source: from, disposition: conflict ? "conflict" : before === undefined ? "migrate" : "preserve" });
        if (conflict) problems.push(`${path}:${field} = ${JSON.stringify(before)} conflicts with ${from} = ${JSON.stringify(value)}; nothing will be overwritten`);
        else if (before === undefined) doc.setIn(at, value);
      };
      put("runtime.agent", agent.agent, agent.from, declared.agent);
      if (declared.agent === undefined && declared.model !== undefined && doc.getIn(["runtime", "model"]) === undefined) {
        put("runtime.model", declared.model, `preset:${preset.preset}`);
      }
      for (const key of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
        const recorded = scoped?.limits?.[key] ?? shared?.limits?.[key];
        const from = scoped?.limits?.[key] !== undefined ? `${machinePath(home)}:projects.${project}.runtime.limits.${key}`
          : shared?.limits?.[key] !== undefined ? `${machinePath(home)}:runtime.limits.${key}`
          : declared.limits?.[key] !== undefined ? doc.getIn(["runtime", "limits", key]) !== undefined ? path : `preset:${preset.preset}` : "legacy default";
        // No Claude default is manufactured as an explicit Codex turn bound.
        const value = recorded ?? declared.limits?.[key] ?? (key === "turns" && agent.agent === "codex" ? undefined : LIMIT_DEFAULTS[key]);
        if (value !== undefined) put(`runtime.limits.${key}`, value, from, declared.limits?.[key]);
      }
      const discussion = expanded.discussion?.runtime;
      // A role block replaces its preset wholesale. Materialize that declared
      // role before adding old fields, retaining its model and sparse limits.
      if (expanded.discussion !== undefined && doc.getIn(["discussion"]) === undefined) doc.setIn(["discussion"], doc.createNode(expanded.discussion));
      put("discussion.runtime.agent", "claude-code", "legacy discussion: fixed Claude Code", discussion?.agent);
      put("discussion.runtime.limits.turns", 40, "legacy discussion: 40 turns", discussion?.limits?.turns);
      put("discussion.runtime.limits.wall", "5m", "legacy discussion: 5m", discussion?.limits?.wall);
      const after = doc.toString({ lineWidth: 0 });
      const resolved = resolveSource(after, base, path);
      const roles = resolved.runtimes!;
      for (const [role, runtime] of [["development", roles.development], ["discussion", roles.discussion],
        ...roles.reviews.map((r) => [`gates.${r.point}.${r.index}`, r.runtime] as const)] as const) {
        if (runtime.agent === "codex" && runtime.limits.turns !== null) problems.push(`${path}:${role}: Codex cannot enforce explicit/inherited turns ${runtime.limits.turns}; adjust the recorded source explicitly; migration retains that bound`);
      }
      plan.files.push({ path, before: source, after, kind: "recipe" });
    } catch (error) { problems.push(`${project}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let machineAfter = machineSource;
  if (machineSource !== null && legacy.length) {
    const doc = parseDocument(machineSource);
    const expected = structuredClone(doc.toJS()) as { runtime?: Record<string, unknown>; projects?: Record<string, {runtime?: Record<string, unknown>}> };
    // Detach only the migration-owned maps. Aliases elsewhere must retain
    // their original values even when they reference one of these maps.
    if (expected.runtime) expected.runtime = { ...expected.runtime };
    if (expected.projects) expected.projects = Object.fromEntries(Object.entries(expected.projects)
      .map(([name, scope]) => [name, { ...scope, ...(scope.runtime ? { runtime: { ...scope.runtime } } : {}) }]));
    for (const field of legacy) {
      // Project names may contain dots. Never split a name as a YAML path.
      const at = field.startsWith("runtime.") ? ["runtime", field.slice("runtime.".length)]
        : ["projects", Object.keys(machine.projects ?? {}).find((name) => ["agent", "limits"].some((key) => field === `projects.${name}.runtime.${key}`))!, "runtime", field.endsWith(".agent") ? "agent" : "limits"];
      const before = doc.getIn(at);
      const runtime = at.length === 2 ? expected.runtime : expected.projects?.[at[1]!]?.runtime;
      if (runtime) delete runtime[at[at.length - 1]!];
      doc.deleteIn(at);
      plan.changes.push({ project: null, path: machinePath(home), field, before: before ?? null, after: null, source: "only after every registered recipe is validated", disposition: "migrate" });
    }
    machineAfter = doc.toString({ lineWidth: 0 });
    if (!isDeepStrictEqual(parseDocument(machineAfter).toJS(), expected)) problems.push(`${machinePath(home)}: YAML aliases would change unrelated machine fields; expand those aliases before migrating; nothing was written`);
  }
  plan.files.push({ path: machinePath(home), before: machineSource, after: machineAfter, kind: "machine" });
  if (plan.resuming && !isDeepStrictEqual(plan.files, journal!.files)) problems.push("planned output changed since migration began; restore the original configuration/preset before resuming");
  return plan;
}

/** Same-directory rename + fsync; no file is exposed half-written. */
async function atomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${randomUUID()}.new`;
  try {
    const file = await open(next, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(next, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(next, { force: true }); }
}

/** Holds the existing conductor lock: neither another migration nor a pass can race these writes. */
export async function applyRuntimeMigration(options: RuntimeMigrationOptions & {
  /** Fault-injection/host progress seam; never used to alter planned bytes. */
  written?: (path: string) => Promise<void>;
}): Promise<RuntimeMigrationPlan> {
  const home = resolve(options.home);
  const held = await createFileLocker({ dir: join(home, "locks") }).tryLock("lingtai:daemon", "lingtai runtime migration");
  if (!held.ok) throw new RuntimeMigrationRefused([`${held.holder ?? "another conductor or migration"} holds the conductor lock; drain it before applying`]);
  try {
    const plan = await previewRuntimeMigration(options);
    if (plan.problems.length) throw new RuntimeMigrationRefused(plan.problems);
    if (plan.files.every((f) => f.before === f.after)) return plan;
    const old = await loadJournal(home);
    const journal: Journal = { version: 1, id: old && !old.complete ? old.id : randomUUID(), home, projects: plan.projects, files: plan.files, complete: false };
    // Journal is durable before the first backup or recipe mutation.
    await atomic(journalPath(home), JSON.stringify(journal, null, 2) + "\n");
    for (const [i, file] of plan.files.entries()) {
      if (file.before === file.after || file.before === null) continue;
      const backup = join(home, "migrations", journal.id, `${i}.bak`);
      const existing = await read(backup);
      if (existing !== null && existing !== file.before) throw new RuntimeMigrationRefused([`${backup} contains a different original; no backup was overwritten`]);
      if (existing === null) await atomic(backup, file.before);
    }
    for (const file of plan.files.filter((f) => f.kind === "recipe")) {
      const current = await read(file.path);
      if (current !== file.before && current !== file.after) throw new RuntimeMigrationRefused([`${file.path} changed after preview; no changes were overwritten`]);
      if (current !== file.after) { await atomic(file.path, file.after!); await options.written?.(file.path); }
      if (await read(file.path) !== file.after) throw new RuntimeMigrationRefused([`${file.path} failed read-back validation; legacy source retained`]);
      resolveSource(file.after!, file.path, file.path);
    }
    // Recheck *all* recipes and membership immediately before global cleanup.
    if (!isDeepStrictEqual(projectNames(await options.registered()), plan.projects)) throw new RuntimeMigrationRefused(["registered projects changed before machine cleanup; legacy source retained"]);
    for (const file of plan.files.filter((f) => f.kind === "recipe")) {
      if (await read(file.path) !== file.after) throw new RuntimeMigrationRefused([`${file.path} changed before machine cleanup; legacy source retained`]);
    }
    const machine = plan.files[plan.files.length - 1]!;
    const current = await read(machine.path);
    if (current !== machine.before && current !== machine.after) throw new RuntimeMigrationRefused([`${machine.path} changed before cleanup; no fields were removed`]);
    if (current !== machine.after) { await atomic(machine.path, machine.after!); await options.written?.(machine.path); }
    if (await read(machine.path) !== machine.after) throw new RuntimeMigrationRefused([`${machine.path} failed read-back validation`]);
    parseMachineConfig(machine.after, machine.path, plan.projects[0] ?? "project", home);
    journal.complete = true;
    await atomic(journalPath(home), JSON.stringify(journal, null, 2) + "\n");
    return plan;
  } finally { await held.lock.release(); }
}
