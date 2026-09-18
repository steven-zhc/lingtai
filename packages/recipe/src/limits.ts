/** Browser-safe limit defaults. Declarations stay sparse until a role is selected. */
import type { RuntimeId } from "@lingtai/domain";
import type { Recipe } from "./recipe.ts";
import { parseDuration } from "./duration.ts";

export const LIMIT_DEFAULTS = { turns: 300, wall: "2h", rounds: 2, restarts: 0 } as const;
type RunLimits = { turns?: number; wall?: string };

export function roleLimits(
  agent: RuntimeId,
  role: "development" | "review" | "discussion",
  project: RunLimits,
  own?: RunLimits,
): { turns: number | null; wall: string; wallMs: number } {
  const turns = own?.turns ?? project.turns
    ?? (agent === "claude-code" ? (role === "discussion" ? 40 : LIMIT_DEFAULTS.turns) : null);
  const wall = own?.wall ?? project.wall ?? (role === "discussion" ? "5m" : LIMIT_DEFAULTS.wall);
  return { turns, wall, wallMs: parseDuration(wall) };
}

/** Project defaults for existing readers awaiting role-aware dispatch (#204). */
export function projectLimits(recipe: { runtime: Pick<Recipe["runtime"], "agent" | "limits"> }): {
  turns: number | null; wall: string; rounds: number; restarts: number;
} {
  const { turns, wall } = roleLimits(recipe.runtime.agent, "development", recipe.runtime.limits);
  return { turns, wall, rounds: recipe.runtime.limits.rounds, restarts: recipe.runtime.limits.restarts };
}
