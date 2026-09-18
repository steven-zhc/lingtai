import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  PRESETS, RecipeInvalidError, editRecipe, emitRecipe, resolveSource,
  type RuntimeOverride,
} from "../src/index.ts";

const base = {
  version: 1, repo: { base: "main" }, source: { kinds: ["feature"] }, env: { plantAt: ".env" },
  runtime: { agent: "claude-code", model: "project-model", tier: "guarded" },
};
const resolve = (value: unknown) => resolveSource(stringify(value), "main", "/test/recipe.yml");

describe("role inheritance (0053)", () => {
  const choices: { name: string; override?: RuntimeOverride; agent: string; model: string | null; agentPath: string; modelPath: string | null }[] = [
    { name: "absent", agent: "claude-code", model: "project-model", agentPath: "runtime.agent", modelPath: "runtime.model" },
    { name: "model only", override: { model: "role-model" }, agent: "claude-code", model: "role-model", agentPath: "runtime.agent", modelPath: ".model" },
    { name: "limits only", override: { limits: { wall: "15m" } }, agent: "claude-code", model: "project-model", agentPath: "runtime.agent", modelPath: "runtime.model" },
    { name: "explicit same agent", override: { agent: "claude-code" }, agent: "claude-code", model: null, agentPath: ".agent", modelPath: null },
    { name: "cross agent", override: { agent: "codex" }, agent: "codex", model: null, agentPath: ".agent", modelPath: null },
    { name: "agent and model", override: { agent: "codex", model: "role-model" }, agent: "codex", model: "role-model", agentPath: ".agent", modelPath: ".model" },
  ];
  for (const role of ["development", "discussion", "review"] as const) {
    it.each(choices)(`${role}: $name`, ({ override, agent, model, agentPath, modelPath }) => {
      const raw = role === "review"
        ? { ...base, gates: { proposed: [{ name: "review", agent: "Check failure paths", runtime: override }] } }
        : { ...base, [role]: { runtime: override } };
      const resolved = resolve(raw).runtimes!;
      const binding = role === "review" ? resolved.reviews[0]!.runtime : resolved[role];
      const path = role === "review" ? "gates.proposed.0.runtime" : `${role}.runtime`;
      expect(binding.agent).toBe(agent);
      expect(binding.model).toBe(model);
      expect(binding.modelSelection).toBe(model === null ? "agent-default" : "requested");
      expect(binding.provenance.agent.path).toBe(agentPath.startsWith(".") ? path + agentPath : agentPath);
      expect(binding.provenance.model.path).toBe(modelPath?.startsWith(".") ? path + modelPath : modelPath);
      expect(binding.provenance["limits.wall"].path).toBe(override?.limits ? `${path}.limits.wall` : null);
      expect(resolved.fix).toBe(resolved.development);
    });
  }

  it("inherits explicit limits across agents, by field, without claiming Codex can enforce turns", () => {
    const { runtimes } = resolve({
      ...base, runtime: { ...base.runtime, limits: { turns: 150, wall: "1h", rounds: 3, restarts: 1 } },
      development: { runtime: { agent: "codex", limits: { wall: "20m" } } },
      gates: { proposed: [{ name: "review", agent: "Prompt", runtime: { agent: "codex", limits: { turns: 7 } } }] },
    });
    expect(runtimes!.development.limits).toEqual({ turns: 150, wall: "20m", wallMs: 1_200_000 });
    expect(runtimes!.development.provenance["limits.turns"].path).toBe("runtime.limits.turns");
    expect(runtimes!.reviews[0]!.runtime.limits).toEqual({ turns: 7, wall: "1h", wallMs: 3_600_000 });
    expect(runtimes!.reviews[0]!.runtime.provenance["limits.turns"].path).toBe("gates.proposed.0.runtime.limits.turns");
    expect(runtimes!.reviews[0]!.runtime.provenance["limits.wall"].path).toBe("runtime.limits.wall");
  });

  it("applies role defaults only after selecting the agent; emission keeps absence absent", () => {
    const resolved = resolve({ ...base, development: { runtime: { agent: "codex" } } });
    expect(resolved.recipe.runtime.limits).toEqual({ rounds: 2, restarts: 0 });
    expect(resolved.runtimes!.development.limits).toEqual({ turns: null, wall: "2h", wallMs: 7_200_000 });
    expect(resolved.runtimes!.development.provenance["limits.turns"]).toEqual({ kind: "absent", path: null });
    expect(resolved.runtimes!.discussion.limits).toEqual({ turns: 40, wall: "5m", wallMs: 300_000 });
    const again = resolveSource(emitRecipe(resolved.recipe), "main", "/test/recipe.yml");
    expect(again.runtimes!.development.limits.turns).toBeNull();
    expect(again.runtimes!.discussion.limits.turns).toBe(40);
    const claude = resolve(base);
    expect(claude.runtimes!.development.limits.turns).toBe(300);
    expect(claude.runtimes!.development.provenance["limits.turns"]).toEqual({ kind: "default", path: null });
    const codex = resolve({ ...base, runtime: { agent: "codex" } });
    expect(codex.runtimes!.discussion.limits).toEqual({ turns: null, wall: "5m", wallMs: 300_000 });
    expect(codex.runtimes!.discussion.model).toBeNull();
  });

  it("resolves every agent gate in order and keeps review choices separate from fixes", () => {
    const { runtimes, recipe } = resolve({
      ...base, development: { runtime: { agent: "codex" } },
      gates: {
        prepared: [{ name: "prepare review", agent: "First", runtime: { model: "first-model" } }],
        proposed: [
          { name: "build", run: "pnpm test" },
          { name: "correctness", agent: "Check correctness", runtime: { agent: "claude-code" } },
          { name: "security", agent: "Check security", runtime: { agent: "codex" } },
        ],
      },
    });
    expect(runtimes!.reviews.map(({ point, index, name }) => [point, index, name])).toEqual([
      ["prepared", 0, "prepare review"], ["proposed", 1, "correctness"], ["proposed", 2, "security"],
    ]);
    expect(runtimes!.fix.agent).toBe("codex");
    expect(runtimes!.reviews[1]!.runtime.agent).toBe("claude-code");
    expect(recipe.gates.proposed[1]).toMatchObject({ agent: "Check correctness" });
  });

  it("distinguishes schema defaults, preset fields and declarations", () => {
    PRESETS["test-runtimes"] = { runtime: { agent: "codex", model: "preset-model", limits: { wall: "1h", turns: 9 } } };
    try {
      const resolved = resolve({ ...base, extends: "test-runtimes", runtime: { limits: { wall: "20m" } } });
      const provenance = resolved.runtimes!.development.provenance;
      expect(provenance.agent).toEqual({ kind: "preset", path: "runtime.agent", location: "preset:test-runtimes" });
      expect(provenance["limits.turns"].kind).toBe("preset");
      expect(provenance["limits.wall"].kind).toBe("configured");
      expect(provenance.tier).toEqual({ kind: "default", path: null });
      const ownAgent = resolve({ ...base, extends: "test-runtimes", runtime: { agent: "codex" } });
      expect(ownAgent.runtimes!.development.model).toBeNull();
    } finally { delete PRESETS["test-runtimes"]; }
  });

  it("carries preset role and gate choices, while preserving malformed own sections for validation", () => {
    PRESETS["test-role-preset"] = {
      runtime: { agent: "codex" },
      development: { runtime: { model: "preset-dev" } },
      discussion: { runtime: { agent: "claude-code" } },
      gates: { admit: [], prepared: [], merge: [], end: [], proposed: [{ name: "review", agent: "Preset prompt", runtime: { agent: "claude-code" } }] },
    };
    try {
      const raw = { ...base, extends: "test-role-preset", runtime: {} };
      const resolved = resolve(raw);
      expect(resolved.runtimes!.development.model).toBe("preset-dev");
      expect(resolved.runtimes!.development.provenance.model.kind).toBe("preset");
      expect(resolved.runtimes!.discussion.agent).toBe("claude-code");
      expect(resolved.runtimes!.reviews[0]!.runtime.provenance.agent.kind).toBe("preset");
      expect(resolveSource(emitRecipe(resolved.recipe), "main", "test").recipe).toEqual(resolved.recipe);
      for (const [key, value] of [["runtime", []], ["development", null], ["discussion", null], ["gates", null]] as const) {
        expect(() => resolve({ ...raw, [key]: value })).toThrow(key);
      }
    } finally { delete PRESETS["test-role-preset"]; }
  });

  it("hashes effective invocation values stably while the recipe hash retains declaration intent", () => {
    const a = resolve({ ...base, development: { runtime: { limits: { wall: "1h" } } } });
    const b = resolve({ ...base, runtime: { ...base.runtime, limits: { wall: "60m" } } });
    expect(a.runtimes!.development.configHash).toBe(b.runtimes!.development.configHash);
    expect(a.configHash).not.toBe(b.configHash);
    for (const runtime of [{ agent: "codex" }, { ...base.runtime, model: "other" }, { ...base.runtime, limits: { turns: 5 } }, { ...base.runtime, tier: "sandboxed" }]) {
      expect(resolve({ ...base, runtime }).runtimes!.development.configHash).not.toBe(resolve(base).runtimes!.development.configHash);
    }
    const reordered = `# comment\n${stringify({ runtime: base.runtime, env: base.env, source: base.source, repo: base.repo, version: 1 })}`;
    expect(resolveSource(reordered, "main", "elsewhere").configHash).toBe(resolve(base).configHash);
  });
});

describe("actionable runtime validation", () => {
  it.each([
    ["agent", "typo"], ["model", "  "], ["tier", "isolated"], ["rounds", 1], ["args", ["--unsafe"]],
    ["agnt", "codex"], ["limits.rounds", 1], ["limits.restarts", 1], ["limits.wal", "1h"],
    ["limits.wall", "0m"], ["limits.wall", "garbage"], ["limits.turns", 0], ["limits.turns", 1.5],
  ])("names the complete role path for %s", (field, value) => {
    for (const role of ["development", "discussion", "review"]) {
      const [parent, child] = field.split(".");
      const override = child ? { [parent!]: { [child]: value } } : { [parent!]: value };
      const raw = role === "review"
        ? { ...base, gates: { proposed: [{ name: "review", agent: "Prompt", runtime: override }] } }
        : { ...base, [role]: { runtime: override } };
      const path = role === "review" ? "gates.proposed.0.runtime" : `${role}.runtime`;
      expect(() => resolve(raw)).toThrow(RecipeInvalidError);
      expect(() => resolve(raw)).toThrow(`${path}.${field}`);
    }
  });

  it.each([
    { run: "pnpm test" }, { watch: ["**" ] }, { human: "Approve?" }, { close: true }, { labels: ["done"] },
  ])("refuses runtime on a non-agent action: %j", (action) => {
    expect(() => resolve({ ...base, gates: { end: [{ name: "action", ...action, runtime: { agent: "codex" } }] } }))
      .toThrow("gates.end.0.runtime");
  });

  it("rejects new section typos, unknown top runtime fields, non-finite durations and a sixth gate", () => {
    for (const [raw, path] of [
      [{ ...base, development: { runtim: {} } }, "development.runtim"],
      [{ ...base, gates: { development: [] } }, "gates.development"],
      [{ ...base, runtime: { ...base.runtime, modle: "x" } }, "runtime.modle"],
      [{ ...base, runtime: { ...base.runtime, limits: { wall: `${"9".repeat(400)}h` } } }, "runtime.limits.wall"],
      [{ ...base, development: null }, "development"],
      [{ ...base, gates: { proposed: [{ name: "build", run: "pnpm test", runtim: {} }] } }, "gates.proposed.0.runtim"],
    ] as const) expect(() => resolve(raw)).toThrow(path);
    expect(() => resolve({ ...base, runtime: { ...base.runtime, prompt: "Instructions", budget: { findings: 3 } } })).not.toThrow();
  });
});

describe("role configuration through YAML", () => {
  it("round-trips choices and preserves comments when a role model is edited by path", () => {
    const resolved = resolve({
      ...base, development: { runtime: { agent: "codex", model: "dev-model" } },
      discussion: { runtime: { model: "discussion-model", limits: { wall: "3m" } } },
      gates: { proposed: [{ name: "review", agent: "Supplemental prompt", runtime: { agent: "claude-code", limits: { turns: 12 } } }] },
    });
    const text = emitRecipe(resolved.recipe, { "development.runtime": "The development choice", "discussion.runtime": "Read only discussion" });
    expect(resolveSource(text, "main", "/test/recipe.yml").recipe).toEqual(resolved.recipe);
    const edited = editRecipe(text, [{ path: ["development", "runtime", "model"], value: "new-model" }]);
    expect(edited).toContain("# The development choice");
    expect(edited).toContain("# Read only discussion");
    expect(resolveSource(edited, "main", "/test/recipe.yml").runtimes!.development.model).toBe("new-model");
    expect(resolveSource(edited, "main", "/test/recipe.yml").recipe.gates.proposed[0]).toMatchObject({ agent: "Supplemental prompt" });
  });
});
