/**
 * Doctor's per-project rows on a project with no owner (#357).
 *
 * `declaredEnvironment` and `recipeGovernsItsBase` used to `continue` past any
 * project with `owner: null` — `if (!project.project || !project.owner)
 * continue` — so a project registered from a directory (#394) got no row at
 * all, and no row reads as nothing wrong. Neither function ever needed the
 * owner for anything but the slug in a base divergence's remedy sentence:
 * `currentRecipe`, `resolveAgentEnv`, `extensionRow`, `limitsRow` and
 * `dispatchedAuthRow` all take the project name alone, and `baseDivergence`
 * compares two recorded values that the owner plays no part in.
 *
 * Through the `recipe`/`agentEnv`/`runtimes` seams on `DoctorReach` (#242),
 * so this never opens `~/.lingtai`, reads a real `~/.claude/settings.json` or
 * spawns `claude auth status` — and never builds a `GitHubClient`, which
 * `recipeFor` below proves by recording what it was handed.
 */
import type { RecipeFor } from '@lingtai/conductor'
import { currentRecipe } from '@lingtai/conductor'
import type { ProjectState } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { type DoctorReach, declaredEnvironment, recipeGovernsItsBase } from '../src/doctor.ts'

/**
 * A `RecipeFor` over the real `resolveLocalRecipe`, with an injected `read`
 * and `home` so nothing reaches the filesystem — the seam
 * `apps/cli/integration/doctor-recipe.test.ts` exercises through a real
 * `mkdtemp`, used here without one. Records every call's `client` argument,
 * so a test can assert that neither row ever tries to build a `GitHubClient`
 * for a project with no owner.
 */
function recipeOf(text: string): RecipeFor & { clients: unknown[] } {
  const clients: unknown[] = []
  const fn = (async (state: ProjectState, client: unknown) => {
    clients.push(client)
    return currentRecipe(state, client, undefined, {
      home: '/nonexistent-home',
      read: async (p: string) => (p.endsWith('recipe.yml') ? text : null),
      signedIn: async () => [],
    })
  }) as RecipeFor & { clients: unknown[] }
  fn.clients = clients
  return fn
}

/** `nothing required` — `declaredEnvironment` never reads a real env file through it. */
const agentEnvStub: DoctorReach['agentEnv'] = async () => ({
  values: {},
  merged: {},
  names: [],
  missing: [],
  deferred: [],
  file: '<unused>',
  refusal: null,
})

/** One runtime, signed in, found by `capabilities.id` rather than spawned. */
const runtimesStub: DoctorReach['runtimes'] = () =>
  [
    {
      capabilities: { id: 'claude-code', enforces: ['turns', 'wall', 'usd'] },
      checkAuth: async () => ({ loggedIn: true, detail: 'signed in' }),
    },
  ] as unknown as ReturnType<DoctorReach['runtimes']>

const RECIPE_OK = `
version: 2
repo: { base: main, remote: git@example.com:esctest/esctest.git }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
runtime: { agent: claude-code }
steps: {}
`

const RECIPE_NO_REMOTE = `
version: 2
repo: { base: main }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
runtime: { agent: claude-code }
steps: {}
`

describe('declaredEnvironment, a project with no owner', () => {
  it('asks the Codex CLI route about the CODEX_HOME a triage run is given', async () => {
    const recipe = recipeOf(`${RECIPE_OK}\ntriage: { agent: codex, tools: full }\n`)
    const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState
    const seen: Array<string | undefined> = []
    const saved = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = '/profile/codex'
    try {
      await declaredEnvironment({}, async () => [state], {
        recipe,
        agentEnv: agentEnvStub,
        runtimes: (() => [
          {
            capabilities: { id: 'codex', enforces: ['wall'] },
            checkAuth: async (env: Record<string, string>) => {
              seen.push(env['CODEX_HOME'])
              return { loggedIn: true, method: null, detail: 'ok' }
            },
          },
        ]) as unknown as DoctorReach['runtimes'],
      })
    } finally {
      if (saved === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = saved
    }
    expect(seen).toEqual(['/profile/codex'])
  })

  it('names the Codex CLI route for triage.tools: full, without reading codex_text', async () => {
    const recipe = recipeOf(`${RECIPE_OK}\ntriage: { agent: codex, tools: full }\n`)
    const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState
    let probes = 0
    let textReads = 0
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe,
      agentEnv: agentEnvStub,
      runtimes: (() => [
        {
          capabilities: { id: 'codex', enforces: ['wall'] },
          checkAuth: async () => {
            probes += 1
            return { loggedIn: true, method: null, detail: 'Logged in using ChatGPT' }
          },
        },
      ]) as unknown as DoctorReach['runtimes'],
      codexText: () => {
        textReads += 1
        return undefined
      },
    })
    expect(rows.find((row) => row.name === 'triage: esctest codex ready')).toBeUndefined()
    const signedIn = rows.find((row) => row.name === 'triage: esctest signed in')
    expect(signedIn?.status).toBe('ok')
    expect(signedIn?.detail).toContain('Codex CLI with tools in a disposable checkout')
    expect(signedIn?.detail).toContain('codex_text is not read')
    expect(signedIn?.detail).toContain('Logged in using ChatGPT')
    expect(probes).toBe(1)
    expect(textReads).toBe(0)
    const limits = rows.find((row) => row.name === 'triage: esctest limits')
    expect(limits?.status).toBe('warn')
    expect(limits?.detail).toContain('wall is enforced')
    expect(limits?.detail).toContain('usd is not observed')
  })

  it('reports each selected Codex role without exposing credentials or starting a paid call', async () => {
    const recipe = recipeOf(
      `${RECIPE_OK}\ndiscuss: { agent: codex, model: priced-model }\ntriage: { agent: codex, model: other-model }\n`,
    )
    const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState
    const configured = {
      apiKey: 'private-test-key',
      model: 'priced-model',
      maxOutputTokens: 32,
      maxUsd: 1,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    }
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe,
      agentEnv: agentEnvStub,
      runtimes: runtimesStub,
      codexText: () => configured,
    })
    expect(rows.find((row) => row.name === 'discuss: esctest codex ready')?.status).toBe('ok')
    expect(rows.find((row) => row.name === 'triage: esctest codex ready')).toMatchObject({
      status: 'fail',
      detail: 'triage.model differs from codex_text.model and its configured prices',
    })
    expect(JSON.stringify(rows)).not.toContain(configured.apiKey)

    const missing = await declaredEnvironment({}, async () => [state], {
      recipe,
      agentEnv: agentEnvStub,
      runtimes: runtimesStub,
      codexText: () => undefined,
    })
    expect(missing.filter((row) => row.name.endsWith('codex ready')).map((row) => row.status)).toEqual(['fail', 'fail'])
  })

  it('gives every row ok, by name, and builds no GitHub client', async () => {
    const recipe = recipeOf(RECIPE_OK)
    const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState
    const load = async () => [state]

    const rows = await declaredEnvironment({}, load, {
      recipe,
      agentEnv: agentEnvStub,
      runtimes: runtimesStub,
    } satisfies Partial<DoctorReach>)

    expect(rows.map((r) => r.name)).toEqual([
      'env: esctest',
      'env: esctest extensions',
      'runtime: esctest limits',
      'runtime: esctest signed in',
      'discuss: esctest signed in',
    ])
    for (const row of rows) expect(row.status, `${row.name}: ${row.detail}`).toBe('ok')
    // `currentRecipe` ignores its second argument (`projects.ts`), and this
    // row never builds one either way — there is no App to build one from.
    expect(recipe.clients).toEqual([undefined])
  })

  it('skips rather than continuing past a project with no name recorded', async () => {
    const state = { project: null, owner: null, base: null } as ProjectState
    const rows = await declaredEnvironment({}, async () => [state])

    expect(rows).toEqual([
      { name: 'env: (unnamed)', status: 'skip', detail: 'no repository name recorded — re-run lingtai add' },
    ])
  })
})

describe('recipeGovernsItsBase, a project with no owner', () => {
  it('is ok when the registered base agrees with the recipe, even with no repo.remote', async () => {
    // The restart-gating watch-out: a legacy owner-less GitHub project whose
    // bases agree must not fail for having no remote — that question belongs
    // to the `recipe:` row, not this one.
    const recipe = recipeOf(RECIPE_NO_REMOTE)
    const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState

    const [row] = await recipeGovernsItsBase({}, async () => [state], { recipe })

    expect(row?.name).toBe('base: esctest')
    expect(row?.status).toBe('ok')
  })

  it('fails, naming --local <dir>, when a --local project disagrees with its recipe', async () => {
    const recipe = recipeOf(RECIPE_OK)
    const state = { project: 'esctest', owner: null, base: 'develop' } as ProjectState

    const [row] = await recipeGovernsItsBase({}, async () => [state], { recipe })

    expect(row?.name).toBe('base: esctest')
    expect(row?.status).toBe('fail')
    expect(row?.detail).toContain('lingtai add --local <dir> --base main')
  })

  it('fails, naming <owner>/project, for an owner-less project with no remote', async () => {
    const recipe = recipeOf(RECIPE_NO_REMOTE)
    const state = { project: 'esctest', owner: null, base: 'develop' } as ProjectState

    const [row] = await recipeGovernsItsBase({}, async () => [state], { recipe })

    expect(row?.status).toBe('fail')
    expect(row?.detail).toContain('lingtai add <owner>/esctest --base main')
  })

  it('skips rather than continuing past a project with no name recorded', async () => {
    const state = { project: null, owner: null, base: null } as ProjectState
    const rows = await recipeGovernsItsBase({}, async () => [state])

    expect(rows).toEqual([
      { name: 'base: (unnamed)', status: 'skip', detail: 'no repository name recorded — re-run lingtai add' },
    ])
  })
})
