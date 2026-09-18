/**
 * Resolve role choices without I/O. Defaults are applied here rather than put
 * in the declaration: emitting a default Claude turn limit as YAML would make
 * it an explicit limit inherited by Codex on the next read (0053).
 *
 * This resolves intent, not capability. An explicit Codex turns is retained;
 * its adapter/host must refuse a limit it cannot enforce before claiming work.
 */
import { createHash } from "node:crypto";
import type { GatePoint, RuntimeId, Tier, RuntimeFieldSource } from "@lingtai/domain";
export type { RuntimeFieldSource } from "@lingtai/domain";
import type { Recipe, RuntimeOverride } from "./recipe.ts";
import { roleLimits } from "./limits.ts";
export { projectLimits } from "./limits.ts";

export type RuntimeRole = "development" | "review" | "discussion";
export type RuntimeSources = ReadonlyMap<string, RuntimeFieldSource>;
type RuntimeDefaults = { runtime: Pick<Recipe["runtime"], "agent" | "model" | "tier" | "limits"> };

export interface ResolvedRuntime {
  agent: RuntimeId;
  /** Null means the agent default is requested; its actual model is not known yet. */
  model: string | null;
  modelSelection: "requested" | "agent-default";
  requiredTier: Tier;
  limits: { turns: number | null; wall: string; wallMs: number };
  provenance: {
    agent: RuntimeFieldSource;
    model: RuntimeFieldSource;
    tier: RuntimeFieldSource;
    "limits.turns": RuntimeFieldSource;
    "limits.wall": RuntimeFieldSource;
  };
  /** Effective invocation configuration; source paths/comments do not change it. */
  configHash: string;
}

export interface ResolvedRuntimes {
  development: ResolvedRuntime;
  /** A review cannot redirect the development agent's repairs. */
  fix: ResolvedRuntime;
  discussion: ResolvedRuntime;
  reviews: { point: GatePoint; index: number; name: string; runtime: ResolvedRuntime }[];
}

const configured = (path: string): RuntimeFieldSource => ({ kind: "configured", path });
const defaultSource = (): RuntimeFieldSource => ({ kind: "default", path: null });

/** Resolve one role; `path` identifies its override, including its gate index. */
export function resolveRuntime(
  recipe: RuntimeDefaults,
  role: RuntimeRole,
  override?: RuntimeOverride,
  path = `${role}.runtime`,
  /** When resolving source bytes, distinguish schema defaults from configured fields. */
  supplied?: RuntimeSources,
): ResolvedRuntime {
  const project = recipe.runtime;
  const source = (field: string) => supplied?.get(field) ?? (supplied ? defaultSource() : configured(field));
  const ownAgent = override?.agent !== undefined;
  const agent = override?.agent ?? project.agent;
  const model = override?.model ?? (ownAgent ? undefined : project.model) ?? null;
  const turnPath = override?.limits?.turns !== undefined
    ? `${path}.limits.turns`
    : project.limits.turns !== undefined ? "runtime.limits.turns" : null;
  const wallPath = override?.limits?.wall !== undefined
    ? `${path}.limits.wall`
    : project.limits.wall !== undefined ? "runtime.limits.wall" : null;
  const limits = roleLimits(agent, role, project.limits, override?.limits);
  const { turns } = limits;
  const effective = { agent, model, requiredTier: project.tier, limits };
  return {
    ...effective,
    modelSelection: model === null ? "agent-default" : "requested",
    provenance: {
      agent: source(ownAgent ? `${path}.agent` : "runtime.agent"),
      model: model === null
        ? { kind: "agent-default", path: null }
        : source(override?.model !== undefined ? `${path}.model` : "runtime.model"),
      tier: source("runtime.tier"),
      "limits.turns": turnPath !== null ? source(turnPath)
        : turns === null ? { kind: "absent", path: null } : defaultSource(),
      "limits.wall": wallPath !== null ? source(wallPath) : defaultSource(),
    },
    configHash: createHash("sha256").update(JSON.stringify({
      agent, model, requiredTier: project.tier, turns, wallMs: limits.wallMs,
    })).digest("hex"),
  };
}

/** Resolve every agent action, preserving gate order, full paths and independent choices. */
export function resolveRuntimes(recipe: Recipe, supplied?: RuntimeSources): ResolvedRuntimes {
  const development = resolveRuntime(recipe, "development", recipe.development?.runtime, "development.runtime", supplied);
  return {
    development,
    fix: development,
    discussion: resolveRuntime(recipe, "discussion", recipe.discussion?.runtime, "discussion.runtime", supplied),
    reviews: (Object.entries(recipe.gates) as [GatePoint, Recipe["gates"][GatePoint]][])
      .flatMap(([point, actions]) => actions.flatMap((action, index) => "agent" in action ? [{
        point, index, name: action.name,
        runtime: resolveRuntime(recipe, "review", action.runtime, `gates.${point}.${index}.runtime`, supplied),
      }] : [])),
  };
}
