import type { RecipeFor } from '@lingtai/conductor'
import { currentRecipe } from '@lingtai/conductor'
import type { ProjectState } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import {
  type CheckResult,
  type DoctorReach,
  codexRoleRow,
  declaredEnvironment,
  endStepRan,
  limitsRow,
  recipeGovernsItsBase,
  recipeRow,
  runtimeAuth,
  settingsSources,
} from '../src/doctor.ts'

/** What the title of any row in this ticket must not carry: an issue or ADR number, a hash, a path. */
const PLAIN = (title: string | undefined) => {
  expect(title).toBeTruthy()
  expect(title!.length).toBeLessThanOrEqual(60)
  expect(title).not.toMatch(/#\d|\b\d{4}\b|\b[0-9a-f]{7,40}\b|\//)
}
const firstLine = (r: CheckResult) => r.detail.split('\n')[0]!

describe('runtime: other settings in scope', () => {
  it('titles a settings file that does not parse, with the parser message on line 2', async () => {
    const row = await settingsSources(async () => '{ not json')
    expect(row).toMatchObject({ name: 'runtime: other settings in scope', status: 'warn' })
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
    expect(firstLine(row)).toBe('~/.claude/settings.json does not parse')
  })
})

describe('runtime: signed in', () => {
  it('titles the machine with nothing signed in, and offers no invented login command', async () => {
    const row = await runtimeAuth(
      () =>
        [
          {
            capabilities: { id: 'claude-code' },
            checkAuth: async () => ({ loggedIn: false, method: null, detail: 'not logged in' }),
          },
        ] as never,
    )
    expect(row).toMatchObject({ name: 'runtime: signed in', status: 'fail' })
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
    expect(firstLine(row)).not.toContain('claude-code')
  })
})

describe('steps: end ran on what landed', () => {
  it('titles the failure and replays each item under its own project and issue, once', async () => {
    const queries = {
      endedWithoutEndActions: async () => [
        { streamId: 'ticket-alpha-7', outcome: 'landed' },
        { streamId: 'ticket-beta-9', outcome: 'landed' },
        { streamId: 'ticket-beta-9', outcome: 'landed' },
      ],
    } as never
    const row = await endStepRan(queries, new Map())
    expect(row).toMatchObject({ name: 'steps: end ran on what landed', status: 'fail' })
    PLAIN(row.title)
    expect(row.fix).toBe('lingtai end replay alpha --issue 7\nlingtai end replay beta --issue 9')
    expect(firstLine(row)).toBe('3 item(s) landed with actions planned at end and none resolved')
  })
})

const filterOk = (agent: string) =>
  ({
    project: 'alpha',
    ok: true,
    configHash: 'abc',
    ref: 'main',
    provenance: {},
    kinds: [],
    exclude: [],
    recipe: { runtime: { agent }, steps: {} },
  }) as never

describe('recipe: <project>', () => {
  it('titles an agent this conductor will not dispatch, remedy on line 2 and no fix', () => {
    const row = recipeRow(filterOk('codex'), 'claude-code')
    expect(row).toMatchObject({ name: 'recipe: alpha', status: 'fail' })
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
    expect(firstLine(row)).toMatch(/nothing will be taken\.$/)
    expect(row.detail.split('\n')[1]).toContain('Name runtime.agent')
  })

  it('titles a recipe that does not resolve', () => {
    const row = recipeRow({ project: 'alpha', ok: false, problem: 'bad yaml' }, 'claude-code')
    expect(row.name).toBe('recipe: alpha')
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
  })
})

describe('runtime: <project> limits', () => {
  it('titles a runtime that ignores a limit, with the lever in the detail and no fix', () => {
    const recipe = { runtime: { limits: { turns: 5, wall: '1h' } }, steps: {} } as never
    const row = limitsRow('alpha', recipe, { id: 'codex', enforces: ['wall'] } as never)
    expect(row).toMatchObject({ name: 'runtime: alpha limits', status: 'fail' })
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
    expect(firstLine(row)).toMatch(/^Codex carries turns and bounds nothing with it, so the recipe declares/)
    expect(row.detail).toContain('The lever is runtime.agent')
  })
})

describe('codexRoleRow', () => {
  it('titles a role with no codex_text', () => {
    const row = codexRoleRow('alpha', 'discuss', undefined, () => undefined)
    expect(row).toMatchObject({ name: 'discuss: alpha codex ready', status: 'fail' })
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
  })

  it('titles a role whose runtime cannot be built, and a differing model, apart', () => {
    const bad = codexRoleRow('alpha', 'triage', undefined, () => ({ apiKey: '' }) as never)
    const other = codexRoleRow('alpha', 'discuss', 'other', () => ({ apiKey: 'k', model: 'priced' }) as never)
    for (const row of [bad, other]) {
      expect(row.status).toBe('fail')
      PLAIN(row.title)
      expect(row.fix).toBeUndefined()
    }
    expect(bad.title).not.toBe(other.title)
  })
})

function recipeOf(text: string): RecipeFor {
  return (async (state: ProjectState, client: unknown) =>
    currentRecipe(state, client, undefined, {
      home: '/nonexistent-home',
      read: async (p: string) => (p.endsWith('recipe.yml') ? text : null),
      signedIn: async () => [],
    })) as RecipeFor
}

const RECIPE = `
version: 2
repo: { base: main, remote: git@example.com:acme/alpha.git }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
runtime: { name: x, prompt: y, agent: claude-code }
steps: {}
`

const signedOut = (id: string) =>
  ({
    capabilities: { id, enforces: ['wall'] },
    checkAuth: async () => ({ loggedIn: false, method: null, detail: 'not logged in' }),
  }) as never

describe('per-project rows through declaredEnvironment', () => {
  const state = { project: 'alpha', owner: 'acme', base: 'main' } as ProjectState
  const agentEnv =
    (missing: string[]): DoctorReach['agentEnv'] =>
    async () => ({
      values: {},
      merged: {},
      names: missing.map((name) => ({ name, layer: 'not set' })),
      missing,
      deferred: [],
      file: '/x/alpha.env',
      refusal: null,
    })

  it('env: names each missing value as its own env set command', async () => {
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe: recipeOf(RECIPE),
      agentEnv: agentEnv(['TOKEN_A', 'TOKEN_B']),
      runtimes: (() => []) as never,
    })
    const row = rows.find((r) => r.name === 'env: alpha')!
    expect(row.status).toBe('fail')
    PLAIN(row.title)
    expect(row.fix).toBe('lingtai env set alpha TOKEN_A\nlingtai env set alpha TOKEN_B')
    expect(firstLine(row)).toBe('2 required names are not set')
  })

  it('env: an unreadable environment is titled and has no fix', async () => {
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe: recipeOf(RECIPE),
      agentEnv: async () => {
        throw new Error('boom')
      },
      runtimes: (() => []) as never,
    })
    const row = rows.find((r) => r.name === 'env: alpha')!
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
  })

  it('runtime and steps signed-in rows are titled and carry no fix', async () => {
    const recipe = recipeOf(RECIPE.replace('steps: {}', 'steps: { review: [{ name: x, prompt: y, agent: codex }] }'))
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe,
      agentEnv: agentEnv([]),
      runtimes: (() => [signedOut('claude-code'), signedOut('codex')]) as never,
    })
    const signed = rows.filter((r) => r.name.endsWith('signed in') && !r.name.startsWith('discuss'))
    expect(signed.map((r) => r.name)).toEqual(['runtime: alpha signed in', 'steps: alpha codex signed in'])
    for (const row of signed) {
      expect(row.status).toBe('fail')
      PLAIN(row.title)
      expect(row.fix).toBeUndefined()
      expect(firstLine(row)).not.toContain('needed by')
    }
    expect(signed[0]!.title).not.toBe(signed[1]!.title)
  })

  it('triage and discuss: signed out, limits and codex-ready rows are titled', async () => {
    const recipe = recipeOf(`${RECIPE}\ntriage: { agent: codex, tools: full }\ndiscuss: { agent: codex }\n`)
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe,
      agentEnv: agentEnv([]),
      runtimes: (() => [signedOut('claude-code'), signedOut('codex')]) as never,
      codexText: () => undefined,
    })
    for (const name of ['triage: alpha signed in', 'triage: alpha limits', 'discuss: alpha codex ready']) {
      const row = rows.find((r) => r.name === name)!
      expect(row.status).not.toBe('ok')
      PLAIN(row.title)
      expect(row.fix).toBeUndefined()
    }
  })

  it('discuss: signed out on a non-codex agent is titled', async () => {
    const rows = await declaredEnvironment({}, async () => [state], {
      recipe: recipeOf(`${RECIPE}\ndiscuss: { agent: claude-code }\n`),
      agentEnv: agentEnv([]),
      runtimes: (() => [signedOut('claude-code')]) as never,
    })
    const row = rows.find((r) => r.name === 'discuss: alpha signed in')!
    expect(row.status).toBe('fail')
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
  })
})

describe('base: <project>', () => {
  const recipe = recipeOf(RECIPE)

  it('gives an owned project the command, and a --local one none', async () => {
    const owned = { project: 'alpha', owner: 'acme', base: 'develop' } as ProjectState
    const local = { project: 'alpha', owner: null, base: 'develop' } as ProjectState
    const [a] = await recipeGovernsItsBase({}, async () => [owned], { recipe })
    const [b] = await recipeGovernsItsBase({}, async () => [local], { recipe })
    expect(a).toMatchObject({ name: 'base: alpha', status: 'fail', fix: 'lingtai add acme/alpha --base main' })
    expect(b).toMatchObject({ name: 'base: alpha', status: 'fail' })
    expect(b!.fix).toBeUndefined()
    for (const row of [a!, b!]) {
      PLAIN(row.title)
      expect(firstLine(row)).not.toContain('Re-register')
    }
  })
})
