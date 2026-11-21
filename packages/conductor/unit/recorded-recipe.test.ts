/**
 * The recipe a run ran under, carried on its own `StepsResolved` (0128 §4, after #191, ADR 0047, #930).
 * `RecipeRecorded` is retired: still parsed, appended never.
 *
 * Three promises 0047 makes, and each is a test here rather than a sentence
 * there, because each fails silently:
 *
 * - **It verifies itself.** The body is what `hashRecipe` hashed, so a reader
 *   checks it against `configHash` on the same event without trusting the
 *   writer — including after Postgres's `jsonb` has reordered every key.
 * - **It holds no secret.** The log is permanent and the board's public
 *   snapshot is downstream of it, so being wrong once is unbounded (§4).
 * - **Nothing decides from it.** A run's record is never a source: an attempt
 *   resolves from the Project's declared recipe (0128 §4, §6), and a conductor
 *   that resolves from the log has recreated what `projects.ts` refuses (§1).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RETIRED, parsePayload, projectStream, recipeStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ProjectFiles, recipePath } from '@lingtai/project'
import {
  RECIPE_PATH,
  RecipeMissingError,
  type Recipe,
  type RecipeFiles,
  hashRecipe,
  resolveRecipe,
} from '@lingtai/recipe'
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'

import { currentRecipeEffect } from '../src/projects.ts'
import { stepsResolved } from '../src/steps-resolved.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OWN = readFileSync(join(ROOT, '.lingtai/config.yaml'), 'utf8')

/** Every environment surface the recipe has: `required`, `allow`, `deny`, and an action's own. */
const DECLARING = `
version: 2
branch:
  main: main
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
`

const resolve = (source: string) =>
  resolveRecipe(async (path, ref) => (path === RECIPE_PATH && ref === 'main' ? source : null), 'main')

/** What the store hands back: `jsonb` keeps no key order, so neither does this. */
function shuffled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffled)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, shuffled(v)]),
  )
}

const recipeOf = (resolved: Awaited<ReturnType<typeof resolve>>) =>
  parsePayload('StepsResolved', stepsResolved('pass-1', resolved))

describe('the recipe on StepsResolved', () => {
  it.each([
    ["this repository's own recipe", OWN],
    ['a recipe declaring every env surface', DECLARING],
  ])('is the body its configHash is the hash of — %s', async (_, source) => {
    const resolved = await resolve(source)
    const payload = recipeOf(resolved)

    expect(payload.recipe).toBeDefined()
    // Out through the log and back, keys in whatever order the store likes.
    const read = shuffled(JSON.parse(JSON.stringify(payload))) as typeof payload
    expect(hashRecipe(read.recipe as unknown as Recipe)).toBe(read.configHash)
    expect(read.configHash).toBe(resolved.configHash)
  })

  it('changes when the recipe does, so the hash is proving something', async () => {
    const before = recipeOf(await resolve(DECLARING))
    const after = recipeOf(await resolve(DECLARING.replace('pnpm test', 'pnpm test:db')))
    expect(after.recipe).not.toEqual(before.recipe)
    expect(hashRecipe(before.recipe as unknown as Recipe)).not.toBe(after.configHash)
  })

  /**
   * 0021: the recipe names variables and never holds their values. Every
   * declared name is given a value in the process this resolves in, and none of
   * those values may reach the payload — while the *names* must, which is what
   * shows the test would see a value if a schema ever put one beside them.
   */
  it('holds no value for any name the recipe declares', async () => {
    const values: Record<string, string> = {
      SECRET_REQUIRED_URL: 'postgres://u:sentinel-required@db.example:5432/x',
      SECRET_ALLOWED_TOKEN: 'sentinel-allowed-9f3a',
      SECRET_DENIED_KEY: 'sentinel-denied-4c1e',
      SECRET_ACTION_TOKEN: 'sentinel-action-77b2',
      LINGTAI_TEST_DATABASE_URL: 'postgres://u:sentinel-test@db.example:5432/t',
      LINGTAI_TEST_DIRECT_DATABASE_URL: 'postgres://u:sentinel-direct@db.example:5432/t',
    }
    const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]))
    Object.assign(process.env, values)
    try {
      for (const source of [DECLARING, OWN]) {
        const appended = JSON.stringify(recipeOf(await resolve(source)))
        for (const value of Object.values(values)) expect(appended).not.toContain(value)
        expect(appended).not.toContain('sentinel')
      }
      const declaring = JSON.stringify(recipeOf(await resolve(DECLARING)))
      for (const name of ['SECRET_REQUIRED_URL', 'SECRET_ALLOWED_TOKEN', 'SECRET_DENIED_KEY', 'SECRET_ACTION_TOKEN']) {
        expect(declaring).toContain(name)
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('the plan and the stream', () => {
  it('stepsResolved carries the recipe, and a stored plan without one still parses', async () => {
    const resolved = await resolve(DECLARING)
    const plan = stepsResolved('pass-1', resolved)
    expect('recipe' in plan).toBe(true)
    expect(parsePayload('StepsResolved', plan).recipe).toBeDefined()
    // Written between #930 and 0128 §4: no recipe, and the log still reads.
    const { recipe: _, ...older } = plan
    expect(() => parsePayload('StepsResolved', older)).not.toThrow()
  })

  it('appending a plan writes nothing to rcp-, and RecipeRecorded is refused at append', async () => {
    const store = createMemoryEventStore()
    const a = await resolve(DECLARING)
    for (const run of ['pass-1', 'pass-2']) {
      await store.append(run, 0, [
        { type: 'StepsResolved', actor: 'conductor', data: parsePayload('StepsResolved', stepsResolved(run, a)) },
      ])
    }
    expect(await store.read(recipeStream(a.configHash))).toHaveLength(0)
    expect(RETIRED.has('RecipeRecorded')).toBe(true)
    await expect(
      store.append(recipeStream(a.configHash), 0, [
        {
          type: 'RecipeRecorded',
          actor: 'conductor',
          data: { configHash: a.configHash, recipe: stepsResolved('pass-1', a).recipe },
        },
      ]),
    ).rejects.toThrow()
  })
})

/**
 * 0128 §4: the Project's declared source is what an attempt resolves from. The
 * read is `currentRecipeEffect`, which `conduct.ts` makes when it is handed no
 * recipe; a failure of it is answered `stage: 'recipe'` at `conduct.ts`'s recipe
 * read, held by `conduct-a-recipe-read-that-dies.test.ts`.
 */
describe('an attempt resolves from the Project’s declared recipe', () => {
  const HOME = '/h'
  const state = { project: 'lingtai', owner: null, base: 'main' } as Parameters<typeof currentRecipeEffect>[0]
  const A = 'version: 2\nbranch:\n  main: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'

  const run = (map: Map<string, string>) => {
    const writes: string[] = []
    const files: RecipeFiles = {
      read: async (p) => map.get(p) ?? null,
      replace: async (p, text) => void (writes.push(p), map.set(p, text)),
    }
    const store = createMemoryEventStore()
    const exit = Effect.runPromiseExit(
      currentRecipeEffect(state, undefined, undefined, {
        home: HOME,
        store,
        host: 'skip',
        signedIn: async () => ['claude-code'],
      }).pipe(Effect.provideService(ProjectFiles, files)),
    )
    return { exit, store, writes }
  }

  it('records the file’s source A on prj- and resolves A’s configHash', async () => {
    const { exit, store } = run(new Map([[recipePath('lingtai', HOME), A]]))
    const result = await exit
    expect(Exit.isSuccess(result)).toBe(true)
    if (!Exit.isSuccess(result)) return
    const changed = (await store.read(projectStream('lingtai'))).filter((e) => e.type === 'ProjectRecipeChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.data).toMatchObject({ by: 'file' })
    expect(JSON.stringify(result.value)).toContain((await resolve(A)).configHash)
  })

  it('with no file on disk fails with RecipeMissingError and writes nothing', async () => {
    const { exit, store, writes } = run(new Map())
    const result = await exit
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(RecipeMissingError)
    expect(await store.read(projectStream('lingtai'))).toHaveLength(0)
    expect(writes).toEqual([])
  })
})

/**
 * Nothing that decides reads a run's recorded recipe back (0047 §1, 0128 §4). Only a view
 * may; `conductor`, `recipe`, `actions` and `project` are the packages that decide.
 *
 * A reading of the source rather than of types, so it is a tripwire and not a
 * proof: it catches the three ways this codebase reads a payload — a parsed
 * `StepsResolved`, a binding made from one, and SQL over `events.data` — and
 * the checker is itself tested against each, so a pattern that stops matching
 * fails here rather than passing everything.
 */
describe('nothing decides from the recorded recipe', () => {
  const PACKAGES = ['packages/conductor/src', 'packages/recipe/src', 'packages/actions/src', 'packages/project/src']

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    )

  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  /** Every place a source reads `recipe` off the log. Empty is the only passing answer. */
  function readsOfTheRecord(source: string): string[] {
    const src = code(source)
    const found: string[] = []
    const field = String.raw`\s*(?:\?\.|\.|\[\s*["'\`])\s*recipe\b`
    // SQL: `data->'recipe'`, `data->>'recipe'`, `data #> '{recipe}'`.
    for (const m of src.matchAll(/->>?\s*'recipe'|#>>?\s*'\{recipe/g)) found.push(m[0])
    const TYPE = String.raw`["'\`](?:StepsResolved|RecipeRecorded)["'\`]`
    if (!new RegExp(TYPE).test(src)) return found
    // A parsed payload, read in place.
    const parsed = new RegExp(String.raw`Payload\(\s*${TYPE}[^;]*?\)` + field, 'g')
    for (const m of src.matchAll(parsed)) found.push(m[0])
    // Anything bound on a line that names the event, then read — or destructured.
    for (const m of src.matchAll(
      /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=[^;]*["'`](?:StepsResolved|RecipeRecorded)["'`]/g,
    )) {
      const name = m[1]!
      const read = new RegExp(String.raw`\b${name}\b(?:\s*(?:\?\.|\.)\s*data)?` + field, 'g')
      for (const r of src.matchAll(read)) found.push(r[0])
    }
    for (const m of src.matchAll(/\{[^{}]*\brecipe\b[^{}]*\}\s*=[^;]*["'`](?:StepsResolved|RecipeRecorded)["'`]/g))
      found.push(m[0])
    return found
  }

  it('the checker sees each way a payload is read', () => {
    const reads = [
      `const r = parseStoredPayload("StepsResolved", 3, e.data).recipe;`,
      `const plan = events.filter((e) => e.type === "StepsResolved").at(-1);\nuse(plan?.data.recipe);`,
      `const p = parsePayload("StepsResolved", row.data);\nuse(p["recipe"]);`,
      `const { recipe } = parsePayload("StepsResolved", row.data);`,
      `const r = parsePayload("RecipeRecorded", row.data).recipe;`,
      `sql\`select data->'recipe' from events where type = 'StepsResolved'\``,
    ]
    for (const read of reads) expect(readsOfTheRecord(read), read).not.toEqual([])
    // What the conductor legitimately does, and must not be mistaken for it.
    expect(
      readsOfTheRecord(
        `const plan = events.filter((e) => e.type === "StepsResolved").at(-1);\nconst points = plan.data.steps;\nconst x = resolved.recipe;`,
      ),
    ).toEqual([])
  })

  it.each(PACKAGES)('%s never reads it', (dir) => {
    const offenders = walk(join(ROOT, dir)).flatMap((file) =>
      readsOfTheRecord(readFileSync(file, 'utf8')).map((read) => `${file.slice(ROOT.length)}: ${read}`),
    )
    expect(offenders).toEqual([])
  })
})
