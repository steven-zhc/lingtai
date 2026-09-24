/**
 * The recipe a run was given, on `GatesResolved` (#191, ADR 0047).
 *
 * Three promises 0047 makes, and each is a test here rather than a sentence
 * there, because each fails silently:
 *
 * - **It verifies itself.** The body is what `hashRecipe` hashed, so a reader
 *   checks it against `configHash` on the same event without trusting the
 *   writer — including after Postgres's `jsonb` has reordered every key.
 * - **It holds no secret.** The log is permanent and the board's public
 *   snapshot is downstream of it, so being wrong once is unbounded (§4).
 * - **Nothing decides from it.** A conductor that resolves from the log has
 *   recreated what `projects.ts`'s `currentRecipe` refuses (§1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePayload } from "@lingtai/domain";
import { RECIPE_PATH, type Recipe, hashRecipe, resolveRecipe } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { gatesResolved } from "../src/gates-resolved.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OWN = readFileSync(join(ROOT, ".lingtai/config.yaml"), "utf8");

/** Every environment surface the recipe has: `required`, `allow`, `deny`, and an action's own. */
const DECLARING = `
version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  required: [SECRET_REQUIRED_URL]
  allow: [SECRET_ALLOWED_TOKEN, SECRET_REQUIRED_URL]
  deny: [SECRET_DENIED_KEY]
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
      env: [SECRET_ACTION_TOKEN]
runtime:
  agent: claude-code
`;

const resolve = (source: string) =>
  resolveRecipe(async (path, ref) => (path === RECIPE_PATH && ref === "main" ? source : null), "main");

/** What the store hands back: `jsonb` keeps no key order, so neither does this. */
function shuffled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffled);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, shuffled(v)]));
}

describe("the recipe on GatesResolved", () => {
  it.each([
    ["this repository's own recipe", OWN],
    ["a recipe declaring every env surface", DECLARING],
  ])("is the body its configHash is the hash of — %s", async (_, source) => {
    const resolved = await resolve(source);
    const payload = parsePayload("GatesResolved", gatesResolved("run-1", resolved));

    expect(payload.recipe).toBeDefined();
    // Out through the log and back, keys in whatever order the store likes.
    const read = shuffled(JSON.parse(JSON.stringify(payload))) as typeof payload;
    expect(hashRecipe(read.recipe as unknown as Recipe)).toBe(read.configHash);
    expect(read.configHash).toBe(resolved.configHash);
  });

  it("changes when the recipe does, so the hash is proving something", async () => {
    const before = gatesResolved("run-1", await resolve(DECLARING));
    const after = gatesResolved("run-1", await resolve(DECLARING.replace("pnpm test", "pnpm test:db")));
    expect(after.recipe).not.toEqual(before.recipe);
    expect(hashRecipe(before.recipe as unknown as Recipe)).not.toBe(after.configHash);
  });

  /**
   * 0021: the recipe names variables and never holds their values. Every
   * declared name is given a value in the process this resolves in, and none of
   * those values may reach the payload — while the *names* must, which is what
   * shows the test would see a value if a schema ever put one beside them.
   */
  it("holds no value for any name the recipe declares", async () => {
    const values: Record<string, string> = {
      SECRET_REQUIRED_URL: "postgres://u:sentinel-required@db.example:5432/x",
      SECRET_ALLOWED_TOKEN: "sentinel-allowed-9f3a",
      SECRET_DENIED_KEY: "sentinel-denied-4c1e",
      SECRET_ACTION_TOKEN: "sentinel-action-77b2",
      LINGTAI_TEST_DATABASE_URL: "postgres://u:sentinel-test@db.example:5432/t",
      LINGTAI_TEST_DIRECT_DATABASE_URL: "postgres://u:sentinel-direct@db.example:5432/t",
    };
    const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
    Object.assign(process.env, values);
    try {
      for (const source of [DECLARING, OWN]) {
        const appended = JSON.stringify(
          parsePayload("GatesResolved", gatesResolved("run-1", await resolve(source))),
        );
        for (const value of Object.values(values)) expect(appended).not.toContain(value);
        expect(appended).not.toContain("sentinel");
      }
      const declaring = JSON.stringify(gatesResolved("run-1", await resolve(DECLARING)));
      for (const name of ["SECRET_REQUIRED_URL", "SECRET_ALLOWED_TOKEN", "SECRET_DENIED_KEY", "SECRET_ACTION_TOKEN"]) {
        expect(declaring).toContain(name);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

/**
 * Nothing that decides reads the recorded recipe back (0047 §1). Only a view
 * may; `conductor`, `recipe` and `actions` are the packages that decide.
 *
 * A reading of the source rather than of types, so it is a tripwire and not a
 * proof: it catches the three ways this codebase reads a payload — a parsed
 * `GatesResolved`, a binding made from one, and SQL over `events.data` — and
 * the checker is itself tested against each, so a pattern that stops matching
 * fails here rather than passing everything.
 */
describe("nothing decides from the recorded recipe", () => {
  const PACKAGES = ["packages/conductor/src", "packages/recipe/src", "packages/actions/src"];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /** Every place a source reads `recipe` off the log. Empty is the only passing answer. */
  function readsOfTheRecord(source: string): string[] {
    const src = code(source);
    const found: string[] = [];
    const field = String.raw`\s*(?:\?\.|\.|\[\s*["'\`])\s*recipe\b`;
    // SQL: `data->'recipe'`, `data->>'recipe'`, `data #> '{recipe}'`.
    for (const m of src.matchAll(/->>?\s*'recipe'|#>>?\s*'\{recipe/g)) found.push(m[0]);
    if (!/["'`]GatesResolved["'`]/.test(src)) return found;
    // A parsed payload, read in place.
    const parsed = new RegExp(String.raw`Payload\(\s*["'\`]GatesResolved["'\`][^;]*?\)` + field, "g");
    for (const m of src.matchAll(parsed)) found.push(m[0]);
    // Anything bound on a line that names the event, then read — or destructured.
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=[^;]*["'`]GatesResolved["'`]/g)) {
      const name = m[1]!;
      const read = new RegExp(String.raw`\b${name}\b(?:\s*(?:\?\.|\.)\s*data)?` + field, "g");
      for (const r of src.matchAll(read)) found.push(r[0]);
    }
    for (const m of src.matchAll(/\{[^{}]*\brecipe\b[^{}]*\}\s*=[^;]*["'`]GatesResolved["'`]/g)) found.push(m[0]);
    return found;
  }

  it("the checker sees each way a payload is read", () => {
    const reads = [
      `const r = parseStoredPayload("GatesResolved", 3, e.data).recipe;`,
      `const plan = events.filter((e) => e.type === "GatesResolved").at(-1);\nuse(plan?.data.recipe);`,
      `const p = parsePayload("GatesResolved", row.data);\nuse(p["recipe"]);`,
      `const { recipe } = parsePayload("GatesResolved", row.data);`,
      `sql\`select data->'recipe' from events where type = 'GatesResolved'\``,
    ];
    for (const read of reads) expect(readsOfTheRecord(read), read).not.toEqual([]);
    // What the conductor legitimately does, and must not be mistaken for it.
    expect(readsOfTheRecord(`const plan = events.filter((e) => e.type === "GatesResolved").at(-1);\nconst points = plan.data.points;\nconst x = resolved.recipe;`)).toEqual([]);
  });

  it.each(PACKAGES)("%s never reads it", (dir) => {
    const offenders = walk(join(ROOT, dir)).flatMap((file) =>
      readsOfTheRecord(readFileSync(file, "utf8")).map((read) => `${file.slice(ROOT.length)}: ${read}`),
    );
    expect(offenders).toEqual([]);
  });
});
