import { keyIn, projectView, type RecipeDraft } from '@lingtai/project'
import { editRecipe, RECIPE_VERSION, type RecipeChange } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { EMPTY_SETUP_READER } from '../src/detect-setup.ts'
import {
  LANDING_LAND,
  LANDING_WAIT,
  PROJECT_FLAGS,
  PROJECT_QUESTION_IDS,
  projectContext,
  projectList,
  type ProjectContext,
  type ProjectPorts,
} from '../src/project-list.ts'
import type { Proposal } from '../src/propose-setup.ts'
import type { RuntimeFound } from '../src/runtimes.ts'
import { END_ACTIONS, LINGTAI_BASE } from '../src/setup-answers.ts'
import { type Asker, type Entry, runSetupList, type SetupInput } from '../src/setup-list.ts'

const PATH = '/tmp/lingtai-test/acme/recipe.yml'

const found = (id: RuntimeFound['id'], state: RuntimeFound['state'] = 'signed-in', detail = ''): RuntimeFound => ({
  id,
  state,
  signedIn: state === 'signed-in',
  detail,
})

const DETECTED = {
  install: { run: 'pnpm install', because: 'a pnpm lockfile' },
  build: [{ name: 'test', run: 'pnpm test', because: 'a test script' }],
  skipped: [],
  notes: [],
}

/** What `proposeSetup` would have said, only where a question reads it. */
const proposal = (over: Record<string, unknown> = {}): Proposal =>
  ({
    detected: { known: true, value: DETECTED, because: 'read' },
    kinds: { known: true, value: ['bug', 'feature'], because: 'read' },
    sandbox: null,
    ...over,
  }) as unknown as Proposal

const SANDBOX = { verdict: { can: true }, install: null, builtIns: ['github.com'] }

function ports(over: Partial<ProjectPorts> = {}): ProjectPorts {
  return {
    project: 'acme',
    local: false,
    checkout: null,
    knownLogin: 'alice',
    hostname: 'laptop.local',
    defaultBranch: Effect.succeed('main'),
    branchExists: (name) => Effect.succeed(name === 'main'),
    commitsOnlyIn: () => Effect.succeed([]),
    reader: EMPTY_SETUP_READER,
    runtimes: Effect.succeed([found('claude-code'), found('codex')]),
    history: () => Effect.succeed([]),
    codexText: Effect.succeed(false),
    onPath: () => Effect.succeed(true),
    proposal: proposal(),
    ...over,
  }
}

/** A draft over `text` whose `set` dies: the list never applies anything, and `changes()` says so. */
function draftOf(text: string | null): RecipeDraft {
  return {
    path: PATH,
    set: () => Effect.die('the list must not set the draft'),
    get: (path) => keyIn(text, path),
    text: () => text,
    changes: () => [],
  }
}

/** What the caller seeds before the walk (1525 §4): the first four keys no question answers. */
const FIRST_RUN_SEEDS: RecipeChange[] = [
  { path: ['branch', 'main'], value: 'main' },
  { path: ['env', 'plantAt'], value: '.env.local' },
  { path: ['steps', 'end'], value: END_ACTIONS },
]

const everyDefault: Record<string, Asker<ProjectContext>> = Object.fromEntries(
  PROJECT_QUESTION_IDS.map((id): [string, Asker<ProjectContext>] => [
    id,
    (d) => Effect.succeed({ answer: d.default ?? (id === 'defaults' ? 'no' : 'yes') }),
  ]),
)

interface WalkOpts {
  flags?: Record<string, string>
  buildFlags?: string[]
  interactive?: boolean
  askers?: Record<string, Asker<ProjectContext>>
  /** The recipe as the run began: null is a first run, and the seeds go in. */
  start?: string | null
  seeds?: RecipeChange[]
}

/** Walks the whole list over `ports`; the start's `set` dies, so a call to it fails the walk. */
async function walk(p: ProjectPorts, o: WalkOpts = {}) {
  const flags = o.flags ?? {}
  const text = o.start ?? null
  const start = draftOf(text)
  const ctx = projectContext({
    start,
    buildFlags: o.buildFlags ?? [],
    flags,
    ports: p,
    kept: 'Nothing was written',
    seeds: o.seeds ?? (text === null ? FIRST_RUN_SEEDS : []),
  })
  const input: SetupInput<ProjectContext> = {
    interactive: o.interactive ?? false,
    defaults: flags['defaults'] !== undefined,
    flags,
    askers: o.askers ?? {},
    log: (line) => ctx.log.push(line),
    // Nothing is applied by the list, so a refusal always says what was true before it.
    kept: () => ({ kept: ctx.kept }),
  }
  const result = await Effect.runPromise(runSetupList(projectList(p), input, ctx))
  expect(start.changes()).toEqual([])
  return { result, ctx, entry: (id: string): Entry | undefined => result.entries.find((e) => e.id === id) }
}

const DEFAULTS = { defaults: '' }
const paths = (changes: readonly RecipeChange[]) => changes.map((c) => c.path.join('.'))
const textOf = (pending: readonly RecipeChange[]) => editRecipe(`version: ${RECIPE_VERSION}\n`, pending)

/** A first run with every default, as the recipe text it writes. */
async function firstRunText(over: Partial<ProjectPorts> = {}, flags: Record<string, string> = {}) {
  const { result, ctx } = await walk(ports(over), { flags: { ...DEFAULTS, ...flags } })
  expect(result.refused).toBeUndefined()
  return textOf(ctx.pending)
}

describe('the list', () => {
  it('has the 25 ids in design order', () => {
    expect(PROJECT_QUESTION_IDS).toHaveLength(25)
    expect(projectList(ports()).map((q) => q.id)).toEqual([...PROJECT_QUESTION_IDS])
    expect(PROJECT_QUESTION_IDS.slice(0, 7)).toEqual([
      'where',
      'mode',
      'login',
      'branch',
      'make-branch',
      'move-landing',
      'defaults',
    ])
  })

  it('has `where` fixed with no flags, and the judge derived', () => {
    const list = projectList(ports())
    const where = list.find((q) => q.id === 'where')!
    expect(where.fixed).toBeDefined()
    expect(where.flags).toEqual([])
    expect(list.find((q) => q.id === 'findings-judge')!.derive).toBeDefined()
  })

  it('builds PROJECT_FLAGS from the entries, with no ports', () => {
    const fromList = projectList(ports()).flatMap((q) => q.flags)
    expect(fromList).toEqual([...PROJECT_FLAGS])
    expect(new Set(PROJECT_FLAGS).size).toBe(PROJECT_FLAGS.length)
    expect(projectList(ports()).find((q) => q.id === 'branch')!.flags).toEqual(['main', 'personal'])
    expect(projectList(ports()).find((q) => q.id === 'refusal-fixes')!.flags).toEqual(['refusal-fixes', 'rounds'])
    expect(projectList(ports()).find((q) => q.id === 'defaults')!.flags).toEqual(['defaults'])
  })

  it('never names the view-mutating call of the draft in its source', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/project-list.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/draft\.set|start\.set/)
  })
})

describe('a first run with every default', () => {
  it('walks every entry, and what it appends resolves', async () => {
    const { result, ctx } = await walk(ports(), { flags: DEFAULTS })
    expect(result.refused).toBeUndefined()
    expect(result.entries.map((e) => e.id)).toEqual([...PROJECT_QUESTION_IDS])
    const text = textOf(ctx.pending)
    expect(projectView(draftOf(text), []).resolved()).not.toBeNull()
    expect(projectView(draftOf(null), ctx.pending).resolved()).not.toBeNull()
    // The seeds are `pending`'s first entries.
    expect(ctx.pending.slice(0, FIRST_RUN_SEEDS.length)).toEqual(FIRST_RUN_SEEDS)
  })

  it('writes every system default, the ticket source included', async () => {
    const { ctx } = await walk(ports(), { flags: DEFAULTS })
    const written = paths(ctx.pending)
    expect(written).toEqual(
      expect.arrayContaining([
        'mode',
        'branch.personal',
        'source.assignee',
        'runtime.agent',
        'steps.implement',
        'steps.review',
        'steps.prepared',
        'steps.build',
        'source.tickets',
        'source.kinds',
        'steps.proposed',
      ]),
    )
    expect(ctx.view.get(['mode'])).toBe('team')
    expect(ctx.view.get(['branch', 'personal'])).toBe('alice/laptop')
    expect(ctx.view.get(['source', 'tickets'])).toBe('github')
    expect(ctx.view.get(['source', 'kinds'])).toEqual(['bug', 'feature'])
  })

  it('takes the same answers at a terminal that accepts every default', async () => {
    const { result } = await walk(ports(), { interactive: true, askers: everyDefault })
    expect(result.refused).toBeUndefined()
    const asked = result.entries.filter((e) => e.asked).map((e) => e.id)
    expect(asked).not.toContain('where')
    expect(asked).not.toContain('findings-judge')
  })

  it('resolves for a solo local project too', async () => {
    const local = ports({ local: true, checkout: '/work/acme', knownLogin: null })
    const { result, ctx } = await walk(local, {
      flags: { ...DEFAULTS, mode: 'solo', tickets: 'db' },
      seeds: [
        { path: ['branch', 'main'], value: LINGTAI_BASE },
        { path: ['repo', 'remote'], value: '/work/acme' },
        { path: ['env', 'plantAt'], value: '.env.local' },
      ],
    })
    expect(result.refused).toBeUndefined()
    expect(ctx.view.get(['source', 'tickets'])).toBe('db')
    expect(projectView(draftOf(null), ctx.pending).resolved()).not.toBeNull()
  })
})

describe('a rerun with every default', () => {
  it('appends nothing, headless and at a terminal', async () => {
    const start = await firstRunText()
    const headless = await walk(ports(), { start, flags: DEFAULTS })
    expect(headless.result.refused).toBeUndefined()
    expect(headless.ctx.pending).toEqual([])
    expect(headless.result.entries.filter((e) => e.wrote)).toEqual([])

    const asked = await walk(ports(), { start, interactive: true, askers: everyDefault })
    expect(asked.result.refused).toBeUndefined()
    expect(asked.ctx.pending).toEqual([])
  })

  it('appends nothing on a solo recipe either', async () => {
    const start = await firstRunText({}, { mode: 'solo' })
    expect(keyIn(start, ['mode'])).toBeNull()
    const again = await walk(ports(), { start, flags: DEFAULTS })
    expect(again.result.refused).toBeUndefined()
    expect(again.ctx.pending).toEqual([])
  })

  it('writes only what a flag changes', async () => {
    const start = await firstRunText()
    const { ctx, entry } = await walk(ports(), { start, flags: { ...DEFAULTS, wall: '30m', 'refusal-fixes': '2' } })
    expect(paths(ctx.pending)).toEqual(['runtime.limits.attempt.refusalFixes', 'runtime.limits.run.wall'])
    expect(entry('wall')).toMatchObject({ after: '30m', wrote: true })
  })
})

describe('where, mode and login', () => {
  it('fixes where from the ports and appends nothing', async () => {
    const { entry } = await walk(ports(), { flags: DEFAULTS })
    expect(entry('where')).toMatchObject({ after: 'github', asked: false, wrote: false })
    const local = await walk(ports({ local: true, knownLogin: null }), {
      flags: { ...DEFAULTS, mode: 'solo', tickets: 'db' },
    })
    expect(local.entry('where')).toMatchObject({ after: 'local' })
  })

  it('refuses where the log cannot be read, in the port’s words', async () => {
    const { result } = await walk(ports({ history: () => Effect.fail(new Error('the database is down')) }))
    expect(result.refused).toBe(
      'could not read the tickets already in the log for acme — the database is down. Nothing was written',
    )
  })

  it('answers the mode from a flag, refuses a bad one, and defaults to team', async () => {
    const solo = await walk(ports(), { flags: { ...DEFAULTS, mode: 'solo' } })
    expect(solo.entry('mode')).toMatchObject({ after: 'solo', wrote: false })
    expect(solo.entry('login')).toMatchObject({ applies: false })
    expect(solo.entry('make-branch')).toMatchObject({ applies: false })
    expect(solo.ctx.view.get(['mode'])).toBeNull()
    const bad = await walk(ports(), { flags: { ...DEFAULTS, mode: 'duo' } })
    expect(bad.result.refused).toBe('duo is not one of team, solo')
    const team = await walk(ports(), { flags: DEFAULTS })
    expect(team.entry('mode')).toMatchObject({ after: 'team', wrote: true })
  })

  it('switching a team recipe to solo removes the personal branch and the pr', async () => {
    const start = await firstRunText()
    const { ctx } = await walk(ports(), { start, flags: { ...DEFAULTS, mode: 'solo' } })
    expect(ctx.pending.find((c) => c.path.join('.') === 'mode')?.value).toBe('solo')
    expect(ctx.pending.find((c) => c.path.join('.') === 'branch.personal')).toMatchObject({ value: undefined })
    expect(ctx.view.get(['branch', 'personal'])).toBeNull()
  })

  it('fixes the login from the machine, and asks where a different one is known', async () => {
    const known = await walk(ports(), { flags: DEFAULTS })
    expect(known.entry('login')).toMatchObject({ after: 'alice', asked: false })
    expect(known.ctx.view.get(['source', 'assignee'])).toEqual({ login: 'alice', take: 'mine' })

    const start = await firstRunText()
    const other = await walk(ports({ knownLogin: 'bob' }), {
      start,
      interactive: true,
      askers: everyDefault,
      flags: {},
    })
    expect(other.entry('login')).toMatchObject({ asked: true, after: 'alice', wrote: false })
  })

  it('refuses a login nobody knows, naming --login, and takes a flag', async () => {
    const none = await walk(ports({ knownLogin: null }), { flags: DEFAULTS })
    expect(none.result.refused).toContain('--login <login>')
    const flagged = await walk(ports({ knownLogin: null }), { flags: { ...DEFAULTS, login: 'carol' } })
    expect(flagged.entry('login')).toMatchObject({ after: 'carol', wrote: true })
    const bad = await walk(ports({ knownLogin: null }), { flags: { ...DEFAULTS, login: '-x' } })
    expect(bad.result.refused).toBe('-x is not a GitHub login (letters, digits and single -)')
  })

  it('a flag beats a known login', async () => {
    const { entry } = await walk(ports(), { flags: { ...DEFAULTS, login: 'dave' } })
    expect(entry('login')).toMatchObject({ after: 'dave' })
  })
})

describe('branch, make-branch and move-landing', () => {
  it('cuts a new personal branch from main, and records where from', async () => {
    const { ctx, entry } = await walk(ports(), { flags: DEFAULTS })
    expect(entry('branch')).toMatchObject({ after: 'alice/laptop', wrote: true })
    expect(ctx.answers.branch).toEqual({
      name: 'alice/laptop',
      exists: false,
      from: 'main',
      onlyIn: null,
      main: 'main',
    })
    expect(entry('make-branch')).toMatchObject({ after: 'yes', applies: true })
    expect(ctx.answers.make).toEqual({ name: 'alice/laptop', from: 'main' })
  })

  it('uses a personal branch that exists as it is, with a line, and asks nothing about making it', async () => {
    const exists = ports({ branchExists: () => Effect.succeed(true) })
    const { ctx, entry } = await walk(exists, { flags: DEFAULTS })
    expect(entry('make-branch')).toMatchObject({ applies: false })
    expect(ctx.log).toContain(
      'alice/laptop exists already — Lingtai will use it as it is; main is brought into it at your first submit',
    )
  })

  it('refuses where the branch cannot be looked up', async () => {
    const down = ports({ branchExists: () => Effect.succeed('unreadable') })
    const { result } = await walk(down, { flags: DEFAULTS })
    expect(result.refused).toContain('could not read whether')
  })

  it('names --defaults where the branch is to be made and nobody can say yes', async () => {
    const { result } = await walk(ports(), { flags: {} })
    expect(result.refused).toContain('--defaults')
  })

  it('refuses a declined branch with the command that makes it, on GitHub and locally', async () => {
    const no: Record<string, Asker<ProjectContext>> = {
      ...everyDefault,
      'make-branch': () => Effect.succeed({ answer: 'no' }),
    }
    const gh = await walk(ports(), { interactive: true, askers: no })
    expect(gh.result.refused).toBe(
      'alice/laptop was not made — nothing was written and nothing was registered. ' +
        'Make it yourself with: git push origin origin/main:refs/heads/alice/laptop, then run this again',
    )
    const local = await walk(
      ports({ local: true, knownLogin: null, branchExists: (n) => Effect.succeed(n === 'trunk') }),
      {
        interactive: true,
        askers: no,
        flags: { mode: 'team', tickets: 'db' },
        seeds: [{ path: ['branch', 'main'], value: 'trunk' }],
      },
    )
    expect(local.result.refused).toContain(
      `Make it yourself with: git branch ${LINGTAI_BASE} trunk, then run this again`,
    )
  })

  it('refuses a personal branch git would refuse, and one that is main', async () => {
    const bad = await walk(ports(), { flags: { ...DEFAULTS, personal: 'a..b' } })
    expect(bad.result.refused).toContain('git refuses')
    const same = await walk(ports(), { flags: { ...DEFAULTS, personal: 'Main' } })
    expect(same.result.refused).toContain('is the same branch as main')
  })

  it('takes a typed --main in team, checked against GitHub', async () => {
    const ok = await walk(ports({ branchExists: (n) => Effect.succeed(n === 'develop') }), {
      flags: { ...DEFAULTS, main: 'develop' },
    })
    expect(ok.ctx.view.get(['branch', 'main'])).toBe('develop')
    expect(ok.ctx.answers.branch?.from).toBe('develop')
    const missing = await walk(ports(), { flags: { ...DEFAULTS, main: 'nope' } })
    expect(missing.result.refused).toBe('nope is not a branch on GitHub. Nothing was written')
  })

  it('cuts a rerun’s new branch from the old one, and lists what only the old one has', async () => {
    const start = await firstRunText()
    const moved = ports({ branchExists: (n) => Effect.succeed(n === 'main' || n === 'alice/laptop') })
    const made = await walk(moved, { start, flags: { ...DEFAULTS, personal: 'alice/desk' } })
    expect(made.ctx.answers.branch).toMatchObject({ name: 'alice/desk', exists: false, from: 'alice/laptop' })
    expect(made.ctx.view.get(['branch', 'personal'])).toBe('alice/desk')

    const both = ports({
      branchExists: () => Effect.succeed(true),
      commitsOnlyIn: () => Effect.succeed(['abc123 one']),
    })
    const there = await walk(both, { start, flags: { ...DEFAULTS, personal: 'alice/desk' } })
    expect(there.ctx.answers.branch).toMatchObject({ exists: true, onlyIn: ['abc123 one'] })
  })

  it('asks the solo base, defaulting to the repository’s own, and refuses when the port fails', async () => {
    const solo = { ...DEFAULTS, mode: 'solo' }
    const { entry, ctx } = await walk(ports(), { flags: solo, seeds: [], start: null })
    // No seed: the default comes from the port.
    expect(entry('branch')).toMatchObject({ after: 'main' })
    expect(ctx.view.get(['branch', 'main'])).toBe('main')
    const down = ports({ defaultBranch: Effect.fail(new Error('GitHub did not answer')) })
    const refused = await walk(down, { flags: solo, seeds: [] })
    expect(refused.result.refused).toBe(
      "could not read the repository's default branch — GitHub did not answer. Pass --main <branch>",
    )
    // A flag answers without reading the default, so the failing port does not hold it up.
    const flagged = await walk(down, { flags: { ...solo, main: 'main' }, seeds: [] })
    expect(flagged.result.refused).toBeUndefined()
    const none = await walk(ports({ defaultBranch: Effect.succeed(null) }), { flags: solo, seeds: [] })
    expect(none.result.refused).toContain('Pass --main <branch>')
  })

  it('looks a solo --main up, on GitHub and in the checkout, and makes only lingtai-base afterwards', async () => {
    const gone = await walk(ports(), { flags: { ...DEFAULTS, mode: 'solo', main: 'nope' }, seeds: [] })
    expect(gone.result.refused).toBe('nope is not a branch on GitHub')
    const unreadable = await walk(ports({ branchExists: () => Effect.succeed('unreadable') }), {
      flags: { ...DEFAULTS, mode: 'solo', main: 'nope' },
      seeds: [],
    })
    expect(unreadable.result.refused).toBe('could not read whether nope exists on GitHub')

    const flags = { ...DEFAULTS, mode: 'solo', tickets: 'db' }
    const local = (exists: (n: string) => boolean) =>
      ports({ local: true, knownLogin: null, branchExists: (n) => Effect.succeed(exists(n)) })
    const missing = await walk(
      local(() => false),
      { flags: { ...flags, main: 'fresh' }, seeds: [] },
    )
    expect(missing.result.refused).toBe('fresh is not a branch in this checkout')
    const there = await walk(
      local((n) => n === 'fresh'),
      { flags: { ...flags, main: 'fresh' }, seeds: [] },
    )
    expect(there.result.refused).toBeUndefined()
    expect(there.ctx.answers.branch).toMatchObject({ name: 'fresh', exists: true })
    const base = await walk(
      local(() => false),
      { flags: { ...flags, main: LINGTAI_BASE }, seeds: [] },
    )
    expect(base.result.refused).toBeUndefined()
    expect(base.ctx.answers.branch).toMatchObject({ name: LINGTAI_BASE, exists: false })
  })

  it("cuts a local solo rerun's new base from the one the recipe names, where that exists", async () => {
    const start = [`version: ${RECIPE_VERSION}`, 'branch:', `  main: ${LINGTAI_BASE}`, ''].join('\n')
    const flags = { ...DEFAULTS, mode: 'solo', tickets: 'db', main: 'fresh' }
    const local = (exists: (n: string) => boolean | 'unreadable') =>
      ports({ local: true, knownLogin: null, branchExists: (n) => Effect.succeed(exists(n)) })
    const cut = await walk(
      local((n) => n === LINGTAI_BASE),
      { start, flags, seeds: [] },
    )
    expect(cut.result.refused).toBeUndefined()
    expect(cut.ctx.answers.branch).toMatchObject({ name: 'fresh', exists: false, from: LINGTAI_BASE })
    expect(cut.entry('make-branch')).toMatchObject({ applies: true })
    expect(cut.ctx.answers.make).toEqual({ name: 'fresh', from: LINGTAI_BASE })
    // A first run has no base to cut from, and a gone base is no source.
    const first = await walk(
      local((n) => n === LINGTAI_BASE),
      { flags, seeds: [] },
    )
    expect(first.result.refused).toBe('fresh is not a branch in this checkout')
    const gone = await walk(
      local(() => false),
      { start, flags, seeds: [] },
    )
    expect(gone.result.refused).toBe('fresh is not a branch in this checkout')
    const lost = await walk(
      local((n) => (n === LINGTAI_BASE ? 'unreadable' : false)),
      { start, flags, seeds: [] },
    )
    expect(lost.result.refused).toContain('could not read whether the current base exists')
  })

  it("cuts a team→solo rerun's new base from the team recipe's personal branch, not its main", async () => {
    const start = [`version: ${RECIPE_VERSION}`, 'mode: team', 'branch:', '  main: main', '  personal: work', ''].join(
      '\n',
    )
    const flags = { ...DEFAULTS, mode: 'solo', tickets: 'db', main: 'fresh' }
    const { result, ctx } = await walk(
      ports({
        local: true,
        knownLogin: null,
        branchExists: (n) => Effect.succeed(n === 'main' || n === 'work'),
      }),
      { start, flags, seeds: [] },
    )
    expect(result.refused).toBeUndefined()
    expect(ctx.answers.branch).toMatchObject({ name: 'fresh', exists: false, from: 'work' })
    expect(ctx.answers.make).toEqual({ name: 'fresh', from: 'work' })
  })

  it('writes the existence the port said, and refuses a read that failed', async () => {
    const { ctx } = await walk(ports(), { flags: { ...DEFAULTS, mode: 'solo' }, seeds: [] })
    expect(ctx.answers.branch).toMatchObject({ name: 'main', exists: true })
    const lost = await walk(ports({ branchExists: () => Effect.succeed('unreadable') }), {
      flags: { ...DEFAULTS, mode: 'solo' },
      seeds: [],
    })
    expect(lost.result.refused).toBe('could not read whether main exists on GitHub')
    const absent = await walk(ports({ branchExists: () => Effect.succeed(false) }), {
      flags: { ...DEFAULTS, mode: 'solo' },
      seeds: [],
    })
    expect(absent.result.refused).toBe('main is not a branch on GitHub')
  })

  it('lands a local solo project on lingtai-base, not on the checked-out branch', async () => {
    const { result, ctx, entry } = await walk(
      ports({
        local: true,
        knownLogin: null,
        defaultBranch: Effect.succeed('main'),
        branchExists: () => Effect.succeed(false),
      }),
      { flags: { ...DEFAULTS, mode: 'solo', tickets: 'db' }, seeds: FIRST_RUN_SEEDS.slice(1) },
    )
    expect(result.refused).toBeUndefined()
    expect(entry('branch')).toMatchObject({ after: LINGTAI_BASE })
    expect(ctx.view.get(['branch', 'main'])).toBe(LINGTAI_BASE)
  })

  it('writes a team main the port detected, so the recipe resolves with no seed for it', async () => {
    const { result, ctx } = await walk(
      ports({ defaultBranch: Effect.succeed('develop'), branchExists: (n) => Effect.succeed(n === 'develop') }),
      { flags: DEFAULTS, seeds: FIRST_RUN_SEEDS.slice(1) },
    )
    expect(result.refused).toBeUndefined()
    expect(ctx.pending.map((c) => c.path.join('.'))).toContain('branch.main')
    expect(ctx.view.get(['branch', 'main'])).toBe('develop')
    expect(ctx.view.resolved()).not.toBeNull()
  })

  it('compares the personal branch with the main that is written, a typed --main included', async () => {
    const start = await firstRunText()
    const both = ports({ branchExists: (n) => Effect.succeed(n === 'main' || n === 'develop') })
    const kept = await walk(both, { start, flags: { ...DEFAULTS, main: 'develop', personal: 'main' } })
    expect(kept.result.refused).toBeUndefined()
    expect(kept.ctx.view.get(['branch', 'main'])).toBe('develop')
    const same = await walk(both, { start, flags: { ...DEFAULTS, main: 'develop', personal: 'develop' } })
    expect(same.result.refused).toContain('develop is the same branch as develop')
    const first = await walk(both, { flags: { ...DEFAULTS, main: 'develop', personal: 'develop' }, seeds: [] })
    expect(first.result.refused).toContain('is the same branch as develop')
  })

  it('refuses with the port’s words when the default branch cannot be read, and not as a missing main', async () => {
    const down = ports({ defaultBranch: Effect.fail(new Error('GitHub rate limit')) })
    const team = await walk(down, { flags: DEFAULTS, seeds: FIRST_RUN_SEEDS.slice(1) })
    expect(team.result.refused).toContain('GitHub rate limit')
    expect(team.result.refused).not.toContain('no main branch')
    const typed = await walk(down, {
      flags: { ...DEFAULTS, main: 'main', personal: 'alice/laptop' },
      seeds: FIRST_RUN_SEEDS.slice(1),
    })
    expect(typed.result.refused).toBeUndefined()
  })

  it('applies move-landing to a local rerun from another checkout, and refuses it with no terminal', async () => {
    const text = [`version: ${RECIPE_VERSION}`, 'repo:', '  remote: /old/acme', ''].join('\n')
    const local = ports({ local: true, checkout: '/new/acme', knownLogin: null })
    const refused = await walk(local, { start: text, flags: { mode: 'solo' } })
    expect(refused.result.refused).toContain('--defaults')
    expect(refused.entry('move-landing')).toBeUndefined()

    const declined = await walk(local, {
      start: text,
      interactive: true,
      flags: {},
      askers: { ...everyDefault, 'move-landing': () => Effect.succeed({ answer: 'no' }) },
    })
    expect(declined.result.refused).toBe("acme's landing was not moved. Nothing was written")

    const same = await walk(ports({ local: true, checkout: '/old/acme', knownLogin: null }), {
      start: text,
      flags: { mode: 'solo' },
    })
    expect(same.entry('move-landing')).toMatchObject({ applies: false })
    const github = await walk(ports(), { flags: DEFAULTS })
    expect(github.entry('move-landing')).toMatchObject({ applies: false })
  })

  it('answers the defaults switch from the flag, and skips it with no terminal', async () => {
    const on = await walk(ports(), { flags: DEFAULTS })
    expect(on.entry('defaults')).toMatchObject({ after: 'yes', asked: false, wrote: false })
    expect(on.ctx.answers.defaults).toBe('yes')
    const none = await walk(ports(), { flags: { mode: 'solo', main: 'main' } })
    expect(none.entry('defaults')).toMatchObject({ after: null, asked: false })
    expect(none.ctx.answers.defaults).toBeUndefined()
  })
})

describe('the writer and the reviewer', () => {
  it('writes the first run’s agent and actions, and offers no model', async () => {
    const { ctx, entry } = await walk(ports(), { flags: DEFAULTS })
    expect(entry('writer')).toMatchObject({ after: 'claude-code', wrote: true })
    expect(entry('writer-model')).toMatchObject({ after: '', wrote: false })
    expect(ctx.view.get(['runtime', 'agent'])).toBe('claude-code')
    expect(ctx.view.get(['steps', 'implement'])).toEqual([
      { name: 'write the change', agent: 'claude-code', prompt: '' },
    ])
    expect(entry('reviewer')).toMatchObject({ after: 'codex' })
    expect(ctx.view.get(['steps', 'review'])).toEqual([{ name: 'review', agent: 'codex', prompt: '' }])
  })

  it('writes the model beside the action the writer just wrote, and nothing for the runtime’s own', async () => {
    const { ctx, entry } = await walk(ports(), { flags: { ...DEFAULTS, model: 'opus', 'reviewer-model': 'gpt-x' } })
    expect(entry('writer-model')).toMatchObject({ after: 'opus', wrote: true })
    expect(ctx.view.get(['steps', 'implement', 0, 'model'])).toBe('opus')
    expect(ctx.view.get(['steps', 'review', 0, 'model'])).toBe('gpt-x')
    const rerun = await firstRunText({}, { model: 'opus' })
    const same = await walk(ports(), { start: rerun, flags: { ...DEFAULTS, model: 'opus' } })
    expect(same.ctx.pending).toEqual([])
    const dropped = await walk(ports(), { start: rerun, flags: { ...DEFAULTS, model: '' } })
    expect(dropped.ctx.pending).toEqual([{ path: ['steps', 'implement', 0, 'model'], value: undefined }])
  })

  it('offers a model back only where the writer kept its agent', async () => {
    const start = await firstRunText({}, { model: 'opus' })
    const kept = await walk(ports(), { start, interactive: true, askers: everyDefault, flags: { reviewer: 'codex' } })
    expect(kept.entry('writer-model')).toMatchObject({ before: { value: 'opus' }, after: 'opus' })
    const changed = await walk(ports(), { start, flags: { ...DEFAULTS, agent: 'codex', reviewer: 'claude-code' } })
    expect(changed.entry('writer-model')).toMatchObject({ before: null, after: '', wrote: true })
    expect(changed.ctx.view.get(['steps', 'implement', 0, 'model'])).toBeNull()
  })

  it('logs every runtime that is not signed in, and offers only the signed-in ones', async () => {
    const some = ports({
      runtimes: Effect.succeed([found('claude-code'), found('codex', 'signed-out'), found('copilot')]),
    })
    const { ctx, result } = await walk(some, { flags: DEFAULTS })
    expect(result.refused).toBeUndefined()
    expect(ctx.log.some((l) => l.includes('codex'))).toBe(true)
    const refused = await walk(some, { flags: { ...DEFAULTS, agent: 'codex' } })
    expect(refused.result.refused).toContain('choose one of claude-code')
    const copilot = await walk(some, { flags: { ...DEFAULTS, agent: 'copilot' } })
    expect(copilot.result.refused).toContain('choose one of claude-code')
  })

  it('refuses a machine with nothing signed in, with no flag able to change that', async () => {
    const none = ports({
      runtimes: Effect.succeed([found('claude-code', 'signed-out'), found('codex', 'not-installed')]),
    })
    const { result, ctx } = await walk(none, { flags: { ...DEFAULTS, agent: 'codex' } })
    expect(result.refused).toContain('no agent runtime is signed in on this machine')
    expect(ctx.log.length).toBe(2)
  })

  it('names Codex as the first run’s discuss agent only where claude-code cannot run and codex_text is set', async () => {
    const codexOnly = (text: Effect.Effect<boolean, unknown>) =>
      ports({ runtimes: Effect.succeed([found('claude-code', 'signed-out'), found('codex')]), codexText: text })
    const yes = await walk(codexOnly(Effect.succeed(true)), { flags: DEFAULTS })
    expect(yes.ctx.view.get(['discuss', 'agent'])).toBe('codex')
    const no = await walk(codexOnly(Effect.succeed(false)), { flags: DEFAULTS })
    expect(no.ctx.view.get(['discuss', 'agent'])).toBeNull()
    // A read that throws answers false.
    const threw = await walk(codexOnly(Effect.fail(new Error('unreadable'))), { flags: DEFAULTS })
    expect(threw.result.refused).toBeUndefined()
    expect(threw.ctx.view.get(['discuss', 'agent'])).toBeNull()
    const signed = await walk(ports({ codexText: Effect.succeed(true) }), { flags: DEFAULTS })
    expect(signed.ctx.view.get(['discuss', 'agent'])).toBeNull()
  })

  it('writes an unbounded turn ceiling for a runtime that cannot hold one, once', async () => {
    const copilotBound = ports({ runtimes: Effect.succeed([found('claude-code'), found('codex')]) })
    const { ctx } = await walk(copilotBound, { flags: { ...DEFAULTS, agent: 'codex' } })
    const turns = ctx.pending.find((c) => c.path.join('.') === 'runtime.limits.run.turns')
    // Whether codex enforces turns is the runtime's own fact: what matters is that the write is never repeated.
    const again = await walk(copilotBound, { start: textOf(ctx.pending), flags: { ...DEFAULTS, agent: 'codex' } })
    expect(again.ctx.pending.find((c) => c.path.join('.') === 'runtime.limits.run.turns')).toBeUndefined()
    expect(turns === undefined || turns.value === 'unbounded').toBe(true)
  })

  it('takes the other runtime as the reviewer, and the writer’s own where there is one', async () => {
    const one = ports({ runtimes: Effect.succeed([found('claude-code')]) })
    const { ctx, entry } = await walk(one, { flags: DEFAULTS })
    expect(entry('reviewer')).toMatchObject({ after: 'claude-code' })
    expect(ctx.log).toContain(
      "the reviewer runs the writer's runtime, on its own default model, unless a model is named here",
    )
    const two = await walk(ports(), { flags: DEFAULTS })
    expect(two.ctx.log.some((l) => l.includes("the reviewer runs the writer's runtime"))).toBe(false)
  })

  it('answers none with an empty review, and refuses a model beside it', async () => {
    const none = await walk(ports(), { flags: { ...DEFAULTS, reviewer: 'none' } })
    expect(none.entry('reviewer')).toMatchObject({ after: 'none', wrote: true })
    expect(none.entry('reviewer-model')).toMatchObject({ applies: false })
    expect(none.ctx.view.get(['steps', 'review'])).toEqual([])
    const clash = await walk(ports(), { flags: { ...DEFAULTS, reviewer: 'none', 'reviewer-model': 'x' } })
    expect(clash.result.refused).toBe(
      "--reviewer-model names a model for a reviewer --reviewer none says there isn't one. Nothing was written",
    )
    const start = await firstRunText({}, { reviewer: 'none' })
    const again = await walk(ports(), { start, flags: { ...DEFAULTS, reviewer: 'none' } })
    expect(again.ctx.pending).toEqual([])
  })

  it('refuses a second agent left beside the writer that is not signed in, and says one that is', async () => {
    const hand = [
      `version: ${RECIPE_VERSION}`,
      'steps:',
      '  implement:',
      '    - name: write',
      '      agent: claude-code',
      '      prompt: ""',
      '    - name: second',
      '      agent: codex',
      '      prompt: ""',
      '',
    ].join('\n')
    const signed = await walk(ports(), { start: hand, flags: { ...DEFAULTS, mode: 'solo' }, seeds: [] })
    expect(signed.ctx.log).toContain(
      'steps.implement\'s "second" also names agent codex — only the first agent: entry is asked about here, so this one is left as written',
    )
    const out = ports({ runtimes: Effect.succeed([found('claude-code'), found('codex', 'signed-out')]) })
    const refused = await walk(out, { start: hand, flags: { ...DEFAULTS, mode: 'solo' }, seeds: [] })
    expect(refused.result.refused).toContain('also names agent codex, which is not signed in here')
    expect(refused.result.refused).toContain('Nothing was written')
    // Before the reviewer model question: nothing after the reviewer was walked.
    expect(refused.entry('reviewer-model')).toBeUndefined()
  })
})

describe('the findings judge', () => {
  const FIRST = { ...DEFAULTS, mode: 'solo', main: 'main' }

  it('appends one for claude-code where there is none, and logs no "also names" line', async () => {
    // A recipe whose writer cannot judge has none; a rerun that switches to claude-code appends one.
    const start = [
      `version: ${RECIPE_VERSION}`,
      'steps:',
      '  implement:',
      '    - name: write the change',
      '      agent: codex',
      '      prompt: ""',
      '',
    ].join('\n')
    const { ctx } = await walk(ports(), {
      start,
      seeds: [],
      flags: { ...FIRST, agent: 'claude-code', reviewer: 'codex' },
    })
    const proposed = ctx.view.get(['steps', 'proposed']) as { judge?: string; when?: string }[]
    expect(proposed.filter((a) => a.when === 'findings').map((a) => a.judge)).toEqual(['claude-code'])
    expect(ctx.log.some((l) => l.includes('also names'))).toBe(false)
  })

  it('rewrites codex to claude-code in place, and logs no "also names" line', async () => {
    const start = await firstRunText({}, { agent: 'codex', reviewer: 'claude-code' })
    expect(keyIn(start, ['steps', 'proposed', 0, 'judge'])).toBe('codex')
    const { ctx, entry } = await walk(ports(), {
      start,
      flags: { ...DEFAULTS, agent: 'claude-code', reviewer: 'claude-code' },
    })
    expect(entry('findings-judge')).toMatchObject({ after: 'claude-code', asked: false, wrote: true })
    expect(ctx.view.get(['steps', 'proposed', 0, 'judge'])).toBe('claude-code')
    expect(paths(ctx.pending)).toContain('steps.proposed.0.judge')
    expect(ctx.log.some((l) => l.includes('also names'))).toBe(false)
  })

  it('removes it for a writer that runs only at implement, and keeps a judge a person wrote', async () => {
    const start = await firstRunText()
    const list = projectList(ports())
    const judge = list.find((q) => q.id === 'findings-judge')!
    const ctx = projectContext({
      start: draftOf(start),
      buildFlags: [],
      flags: {},
      ports: ports(),
      kept: 'k',
      seeds: [],
    })
    ctx.answers.writer = 'copilot'
    expect(judge.derive!(ctx)).toBe('copilot')
    await Effect.runPromise(judge.write('copilot', null, ctx))
    expect(ctx.view.get(['steps', 'proposed'])).toEqual([])

    const theirs = start.replace('judge: claude-code', 'judge: codex')
    const kept = await walk(ports(), { start: theirs, flags: { ...DEFAULTS, agent: 'codex', reviewer: 'claude-code' } })
    expect(kept.ctx.view.get(['steps', 'proposed', 0, 'judge'])).toBe('codex')
    const other = await walk(ports(), { start: theirs, flags: DEFAULTS })
    expect(paths(other.ctx.pending)).not.toContain('steps.proposed.0.judge')
  })

  it('leaves a judge the operator removed removed while the writer stays', async () => {
    const start = await firstRunText()
    const without = editRecipe(start, [{ path: ['steps', 'proposed'], value: [] }])
    const { ctx } = await walk(ports(), { start: without, flags: DEFAULTS })
    expect(ctx.pending).toEqual([])
  })
})

describe('the sandbox', () => {
  const withSandbox = (over: Record<string, unknown> = {}) =>
    ports({ proposal: proposal({ sandbox: SANDBOX, ...over }) })

  it('does not apply where the host was not read', async () => {
    const { entry } = await walk(ports(), { flags: DEFAULTS })
    expect(entry('sandbox')).toMatchObject({ applies: false })
    expect(entry('sandbox-hosts')).toMatchObject({ applies: false })
  })

  it('writes the block on, with its extra hosts, on a first run', async () => {
    const on = await walk(withSandbox(), { flags: DEFAULTS })
    expect(on.entry('sandbox')).toMatchObject({ after: 'on', wrote: true })
    expect(on.entry('sandbox-hosts')).toMatchObject({ after: 'none', wrote: false })
    expect(on.ctx.view.get(['sandbox'])).toEqual({ enabled: true })
    const hosts = await walk(withSandbox(), { flags: { ...DEFAULTS, 'sandbox-hosts': 'a.example, b.example' } })
    expect(hosts.ctx.view.get(['sandbox'])).toEqual({ enabled: true, network: { allow: ['a.example', 'b.example'] } })
    const bad = await walk(withSandbox(), { flags: { ...DEFAULTS, 'sandbox-hosts': 'https://x' } })
    expect(bad.result.refused).toContain('is not a host the sandbox accepts')
  })

  it('writes off with its one line, and ignores hosts beside it', async () => {
    const off = await walk(withSandbox(), { flags: { ...DEFAULTS, sandbox: 'off', 'sandbox-hosts': 'a.example' } })
    expect(off.entry('sandbox')).toMatchObject({ after: 'off' })
    expect(off.entry('sandbox-hosts')).toMatchObject({ applies: false })
    expect(off.ctx.view.get(['sandbox'])).toEqual({ enabled: false })
    expect(off.ctx.log.some((l) => l.startsWith('Agents and build commands will reach anything your user can'))).toBe(
      true,
    )
    const bad = await walk(withSandbox(), { flags: { ...DEFAULTS, sandbox: 'maybe' } })
    expect(bad.result.refused).toBe('maybe is not one of on, off')
  })

  it('says a host that cannot sandbox, and only where no flag answers', async () => {
    const cannot = withSandbox({
      sandbox: { verdict: { can: false, reason: 'no bwrap', sentences: [] }, install: null, builtIns: [] },
    })
    const said = await walk(cannot, { flags: DEFAULTS })
    expect(said.ctx.log.some((l) => l.startsWith('This machine cannot run the sandbox yet'))).toBe(true)
    const flagged = await walk(cannot, { flags: { ...DEFAULTS, sandbox: 'on' } })
    expect(flagged.ctx.log.some((l) => l.startsWith('This machine cannot run the sandbox yet'))).toBe(false)
  })

  it('on a rerun writes only what changed', async () => {
    const start = await firstRunText({ proposal: proposal({ sandbox: SANDBOX }) })
    const same = await walk(withSandbox(), { start, flags: DEFAULTS })
    expect(same.ctx.pending).toEqual([])
    const changed = await walk(withSandbox(), { start, flags: { ...DEFAULTS, 'sandbox-hosts': 'a.example' } })
    expect(changed.ctx.pending).toEqual([{ path: ['sandbox', 'network', 'allow'], value: ['a.example'] }])
    const off = await walk(withSandbox(), { start, flags: { ...DEFAULTS, sandbox: 'off' } })
    expect(off.ctx.pending).toEqual([{ path: ['sandbox', 'enabled'], value: false }])
    const offStart = editRecipe(start, [{ path: ['sandbox'], value: { enabled: false } }])
    const stays = await walk(withSandbox(), { start: offStart, flags: { ...DEFAULTS, sandbox: 'off' } })
    expect(stays.ctx.pending).toEqual([])
  })
})

describe('install, checks and the trial', () => {
  it('takes the detected install and checks, and says a tool that is not on the PATH', async () => {
    const missing = ports({ onPath: (tool) => Effect.succeed(tool !== 'pnpm') })
    const { ctx, entry } = await walk(missing, { flags: DEFAULTS })
    expect(entry('install')).toMatchObject({ after: 'pnpm install', wrote: true })
    expect(entry('checks')).toMatchObject({ after: '["pnpm test"]' })
    expect(ctx.view.get(['steps', 'prepared'])).toEqual([{ name: 'install', run: 'pnpm install' }])
    expect(ctx.view.get(['steps', 'build'])).toEqual([{ name: 'test', run: 'pnpm test' }])
    expect(ctx.log).toContain("pnpm is not on this machine's PATH; the conductor runs these commands here")
    const probe = await walk(ports({ onPath: () => Effect.fail(new Error('boom')) }), { flags: DEFAULTS })
    expect(probe.result.refused).toBeUndefined()
  })

  it('takes none where nothing is detected', async () => {
    const bare = ports({
      proposal: proposal({ detected: { known: true, value: { install: null, build: [], skipped: [], notes: [] } } }),
    })
    const { ctx, entry } = await walk(bare, { flags: DEFAULTS })
    expect(entry('install')).toMatchObject({ after: 'none' })
    expect(entry('checks')).toMatchObject({ after: '[]' })
    expect(ctx.answers.trial).toEqual({ trial: 'not-run', because: 'no checks' })
    expect(ctx.log).toContain('nothing will check a diff before review')
  })

  it('reads the repository where there is no proposal', async () => {
    const reader = {
      ...EMPTY_SETUP_READER,
      has: (path: string) => Effect.succeed(path === 'pnpm-lock.yaml'),
    }
    const { entry } = await walk(ports({ proposal: undefined, reader }), { flags: DEFAULTS })
    expect(entry('install')?.after).not.toBeNull()
  })

  it('answers every --build, a comma surviving, and refuses the combinations', async () => {
    const two = await walk(ports(), { flags: DEFAULTS, buildFlags: ['pnpm -r a,b', 'pnpm lint'] })
    expect(two.entry('checks')).toMatchObject({ after: '["pnpm -r a,b","pnpm lint"]' })
    expect(two.ctx.answers.checks).toEqual(['pnpm -r a,b', 'pnpm lint'])
    const none = await walk(ports(), { flags: DEFAULTS, buildFlags: ['none'] })
    expect(none.ctx.answers.checks).toEqual([])
    const both = await walk(ports(), { flags: DEFAULTS, buildFlags: ['none', 'pnpm test'] })
    expect(both.result.refused).toBe('--build none cannot be combined with another --build value')
    const empty = await walk(ports(), { flags: DEFAULTS, buildFlags: [''] })
    expect(empty.result.refused).toBe('--build takes a command, or none — not empty')
    const noInstall = await walk(ports(), { flags: { ...DEFAULTS, install: '' } })
    expect(noInstall.result.refused).toBe('type a command, or none')
  })

  it('says there is no checkout when a list is given and there is no trial port', async () => {
    const { ctx, entry } = await walk(ports(), { flags: DEFAULTS })
    expect(ctx.log).toContain(
      'the trial run was not run — no checkout on this machine; the first attempt’s `build` is where these first run',
    )
    expect(entry('trial')).toMatchObject({ applies: false })
    expect(ctx.answers.trial).toEqual({ trial: 'not-run', because: 'no checkout' })
  })

  const PASSED = {
    install: 'pnpm install',
    checks: [{ name: 'test', run: 'pnpm test' }],
    trial: { trial: 'passed', ms: 3 },
  } as const

  it('is no under the defaults and without a terminal, and runs nothing then', async () => {
    let ran = 0
    const trial: ProjectPorts['trial'] = () => {
      ran += 1
      return Effect.succeed({ ...PASSED, checks: [...PASSED.checks] })
    }
    const defaults = await walk(ports({ trial }), { flags: DEFAULTS })
    expect(defaults.entry('trial')).toMatchObject({ after: 'no', asked: false, wrote: false })
    expect(defaults.ctx.answers.trial).toEqual({ trial: 'not-run', because: 'declined' })
    const headless = await walk(ports({ trial }), { flags: { mode: 'solo', main: 'main', tickets: 'github' } })
    expect(headless.entry('trial')).toMatchObject({ after: 'no' })
    expect(ran).toBe(0)
  })

  it('does not apply with no checks, and is yes at a terminal', async () => {
    const trial: ProjectPorts['trial'] = () => Effect.succeed({ ...PASSED, checks: [...PASSED.checks] })
    const none = await walk(ports({ trial }), { flags: DEFAULTS, buildFlags: ['none'] })
    expect(none.entry('trial')).toMatchObject({ applies: false })
    const typed = await walk(ports({ trial }), {
      interactive: true,
      askers: { ...everyDefault, defaults: () => Effect.succeed({ answer: 'no' }) },
    })
    expect(typed.entry('trial')).toMatchObject({ after: 'yes', asked: true })
    expect(typed.ctx.answers.trial).toEqual({ trial: 'passed', ms: 3 })
  })

  it('appends what the port returned, which wins over the earlier entries’ changes', async () => {
    const trial: ProjectPorts['trial'] = (at) => {
      expect(at.checks).toEqual([{ name: 'test', run: 'pnpm test' }])
      expect(at.given).toEqual({ install: null, build: null, check: 'yes' })
      expect(at.view.get(['steps', 'build'])).not.toBeNull()
      return Effect.succeed({
        install: 'pnpm i --frozen-lockfile',
        checks: [{ name: 'check', run: 'pnpm check' }],
        trial: { trial: 'failed-kept', command: 'pnpm check', ms: 9 },
      })
    }
    const { ctx, entry } = await walk(ports({ trial }), { flags: { ...DEFAULTS, 'check-build': 'yes' } })
    expect(entry('trial')).toMatchObject({ after: 'yes', wrote: true })
    expect(ctx.view.get(['steps', 'prepared'])).toEqual([{ name: 'install', run: 'pnpm i --frozen-lockfile' }])
    expect(ctx.view.get(['steps', 'build'])).toEqual([{ name: 'check', run: 'pnpm check' }])
    expect(ctx.answers.trial).toEqual({ trial: 'failed-kept', command: 'pnpm check', ms: 9 })
    expect(ctx.log).toContain(
      `kept the list as tried — it goes into ${PATH} when the project is added; nothing is written yet`,
    )
    expect(projectView(draftOf(null), ctx.pending).resolved()).not.toBeNull()
  })

  it('refuses with the port’s words, and a flag that is neither yes nor no', async () => {
    const trial: ProjectPorts['trial'] = () =>
      Effect.succeed({ refused: 'the trial run was interrupted. Nothing was written' })
    const refused = await walk(ports({ trial }), { flags: { ...DEFAULTS, 'check-build': 'yes' } })
    expect(refused.result.refused).toBe('the trial run was interrupted. Nothing was written')
    const bad = await walk(ports({ trial }), { flags: { ...DEFAULTS, 'check-build': 'maybe' } })
    expect(bad.result.refused).toBe('maybe is not one of yes, no')
  })

  it('on a rerun with the list unchanged appends nothing, and a typed list changes only what differs', async () => {
    const start = await firstRunText()
    const same = await walk(ports(), { start, flags: DEFAULTS, buildFlags: ['pnpm test'] })
    expect(same.ctx.pending).toEqual([])
    const changed = await walk(ports(), {
      start,
      flags: { ...DEFAULTS, install: 'none' },
      buildFlags: ['pnpm test', 'pnpm lint'],
    })
    expect(paths(changed.ctx.pending)).toEqual(['steps.prepared', 'steps.build'])
    expect(changed.ctx.view.get(['steps', 'prepared'])).toEqual([])
    const nothing = await walk(ports(), { start, flags: DEFAULTS, buildFlags: ['none'] })
    expect(nothing.ctx.view.get(['steps', 'build'])).toEqual([])
    expect(nothing.ctx.log).toContain('nothing will check a diff before review')
  })
})

describe('tickets and kinds', () => {
  it('writes the ticket source on a first run even where it is the default', async () => {
    const { ctx, entry } = await walk(ports(), { flags: DEFAULTS })
    expect(entry('tickets')).toMatchObject({ after: 'github', wrote: true })
    expect(ctx.pending.find((c) => c.path.join('.') === 'source.tickets')?.value).toBe('github')
  })

  it('refuses a source that is neither', async () => {
    const { result } = await walk(ports(), { flags: { ...DEFAULTS, tickets: 'jira' } })
    expect(result.refused).toBe('jira is not one of github, db')
  })

  it('fixes db locally, and refuses github there', async () => {
    const local = ports({ local: true, knownLogin: null })
    const solo = { ...DEFAULTS, mode: 'solo' }
    const { entry } = await walk(local, { flags: solo })
    expect(entry('tickets')).toMatchObject({ after: 'db', asked: false, wrote: true })
    const refused = await walk(local, { flags: { ...solo, tickets: 'github' } })
    expect(refused.result.refused).toContain('a project with no owner cannot take its tickets from GitHub')
  })

  it('keeps the source a log with tickets proves, says so, and refuses a differing flag', async () => {
    const used = ports({ history: () => Effect.succeed(['db ticket #1']) })
    const { ctx, entry } = await walk(used, { flags: DEFAULTS })
    expect(entry('tickets')).toMatchObject({ after: 'db', asked: false })
    expect(ctx.view.get(['source', 'tickets'])).toBe('db')
    expect(ctx.log.some((l) => l.includes('kept: the log already has tickets for this project (db ticket #1)'))).toBe(
      true,
    )
    const clash = await walk(used, { flags: { ...DEFAULTS, tickets: 'github' } })
    expect(clash.result.refused).toContain('--tickets github, but acme already has')
    const same = await walk(used, { flags: { ...DEFAULTS, tickets: 'db' } })
    expect(same.result.refused).toBeUndefined()
  })

  it('takes the proposal’s kinds, then SETUP_KINDS, and writes a changed list in place on a rerun', async () => {
    const proposed = await walk(ports(), { flags: DEFAULTS })
    expect(proposed.entry('kinds')).toMatchObject({ after: 'bug, feature' })
    const plain = await walk(ports({ proposal: undefined }), { flags: DEFAULTS })
    expect(plain.entry('kinds')).toMatchObject({ after: 'bug, feature, tech-debt, documentation' })
    const start = await firstRunText()
    const changed = await walk(ports(), { start, flags: { ...DEFAULTS, kinds: 'bug, docs' } })
    expect(changed.ctx.pending).toEqual([{ path: ['source', 'kinds'], value: ['bug', 'docs'] }])
    const twice = await walk(ports(), { start, flags: { ...DEFAULTS, kinds: 'bug,bug' } })
    expect(twice.result.refused).toBe('bug is named twice — list each label once')
    const unchanged = await walk(ports(), { start, flags: { ...DEFAULTS, kinds: 'bug,feature' } })
    expect(unchanged.ctx.pending).toEqual([])
  })
})

describe('the landing', () => {
  const SOLO = { ...DEFAULTS, mode: 'solo', main: 'main' }

  it('does not apply in team mode, and refuses --land <branch> there', async () => {
    const team = await walk(ports(), { flags: DEFAULTS })
    expect(team.entry('landing')).toMatchObject({ applies: false })
    const refused = await walk(ports(), { flags: { ...DEFAULTS, land: 'develop' } })
    expect(refused.result.refused).toBe(
      'a team project lands on branch.personal, not on develop — pass --personal <branch> to name it. Nothing was written',
    )
    const hold = await walk(ports(), { flags: { ...DEFAULTS, land: 'hold' } })
    expect(hold.entry('landing')).toMatchObject({ applies: true, after: 'hold' })
    expect((hold.ctx.view.get(['steps', 'proposed']) as { human?: string }[])[0]).toHaveProperty('human')
  })

  it('lands unattended by default in solo, and writes no hold', async () => {
    const { ctx, entry } = await walk(ports(), { flags: SOLO })
    expect(entry('landing')).toMatchObject({ after: LANDING_LAND, wrote: false })
    expect(ctx.view.get(['steps', 'proposed'])).not.toBeNull()
    expect((ctx.view.get(['steps', 'proposed']) as Record<string, unknown>[]).some((a) => 'human' in a)).toBe(false)
  })

  it('holds with --land hold, lands on a named branch, and keeps a hold first before the judge', async () => {
    const hold = await walk(ports(), { flags: { ...SOLO, land: 'hold' } })
    const proposed = hold.ctx.view.get(['steps', 'proposed']) as Record<string, unknown>[]
    expect(Object.keys(proposed[0]!)).toContain('human')
    expect(proposed[1]).toMatchObject({ when: 'findings' })
    const on = await walk(ports({ branchExists: () => Effect.succeed(true) }), { flags: { ...SOLO, land: 'trunk' } })
    expect(on.ctx.view.get(['branch', 'main'])).toBe('trunk')
    const blank = await walk(ports(), { flags: { ...SOLO, land: ' ' } })
    expect(blank.result.refused).toBe('needs a branch name, or "hold"')
  })

  it('writes the typed choice, and defaults to what the recipe already does', async () => {
    const start = await firstRunText({}, { mode: 'solo', land: 'hold' })
    const same = await walk(ports(), { start, flags: { ...SOLO } })
    // The recipe holds: that is the default, and keeping it writes nothing.
    expect(same.entry('landing')).toMatchObject({ after: LANDING_WAIT })
    expect(same.ctx.pending).toEqual([])
    const land = await walk(ports(), {
      start,
      interactive: true,
      askers: { ...everyDefault, landing: () => Effect.succeed({ answer: LANDING_LAND }) },
      flags: { mode: 'solo', main: 'main' },
    })
    expect((land.ctx.view.get(['steps', 'proposed']) as Record<string, unknown>[]).some((a) => 'human' in a)).toBe(
      false,
    )
    expect(land.entry('landing')).toMatchObject({ asked: true, wrote: true })
  })
})

describe('the limits', () => {
  it('writes nothing for the schema’s defaults, and the change for a different answer', async () => {
    const start = await firstRunText()
    const { ctx, entry } = await walk(ports(), {
      start,
      flags: { ...DEFAULTS, 'refusal-fixes': '3', 'conflict-resolutions': '4', wall: '30m', budget: '$5' },
    })
    expect(entry('refusal-fixes')).toMatchObject({ after: '3', wrote: true })
    expect(paths(ctx.pending)).toEqual([
      'runtime.limits.attempt.refusalFixes',
      'runtime.limits.attempt.conflictResolutions',
      'runtime.limits.run.wall',
      'runtime.limits.run.usd',
    ])
    expect(ctx.pending.at(-1)?.value).toBe(5)
    const plain = await walk(ports(), { flags: DEFAULTS })
    for (const id of ['refusal-fixes', 'conflict-resolutions', 'wall', 'budget'])
      expect(plain.entry(id)).toMatchObject({ wrote: false })
  })

  it('refuses --rounds by name, and a figure that is not a figure', async () => {
    const rounds = await walk(ports(), { flags: { ...DEFAULTS, rounds: '3' } })
    expect(rounds.result.refused).toContain('--rounds is gone')
    expect((await walk(ports(), { flags: { ...DEFAULTS, 'refusal-fixes': 'x' } })).result.refused).toBe(
      'that is not a whole number 0 or greater',
    )
    expect((await walk(ports(), { flags: { ...DEFAULTS, 'conflict-resolutions': '-1' } })).result.refused).toBe(
      'that is not a whole number 0 or greater',
    )
    expect((await walk(ports(), { flags: { ...DEFAULTS, wall: 'soon' } })).result.refused).toBe(
      'that is not a duration like 30s, 15m or 2h',
    )
    expect((await walk(ports(), { flags: { ...DEFAULTS, budget: '-3' } })).result.refused).toContain(
      'not a dollar amount',
    )
  })

  it('removes the dollar ceiling with none, and says where only claude-code holds one', async () => {
    const start = await firstRunText({}, { budget: '5' })
    const { ctx } = await walk(ports(), { start, flags: { ...DEFAULTS, budget: 'none' } })
    expect(ctx.pending).toEqual([{ path: ['runtime', 'limits', 'run', 'usd'], value: undefined }])
    const codex = await walk(ports(), { flags: { ...DEFAULTS, agent: 'codex', budget: '5', reviewer: 'claude-code' } })
    expect(codex.ctx.log.some((l) => l.includes('codex cannot hold a dollar ceiling on one run'))).toBe(true)
  })
})

describe('register', () => {
  it('applies under the defaults where nothing checks a diff, and answers yes from the flag', async () => {
    const bare = ports({
      proposal: proposal({ detected: { known: true, value: { install: null, build: [], skipped: [], notes: [] } } }),
    })
    const empty = await walk(bare, { flags: DEFAULTS })
    expect(empty.entry('register')).toMatchObject({ applies: true, after: 'yes', asked: false })
    // A person who named `--build none` chose it: nothing to confirm.
    const chosen = await walk(ports(), { flags: DEFAULTS, buildFlags: ['none'] })
    expect(chosen.entry('register')).toMatchObject({ applies: false })
    const checked = await walk(ports(), { flags: DEFAULTS })
    // Team lands on the person's own branch, and a list is there: nothing to confirm.
    expect(checked.entry('register')).toMatchObject({ applies: false })
  })

  it('applies under the defaults where a solo landing is unattended, unless --land chose it', async () => {
    const solo = { ...DEFAULTS, mode: 'solo', main: 'main' }
    const unattended = await walk(ports(), { flags: solo })
    expect(unattended.entry('register')).toMatchObject({ applies: true })
    const chosen = await walk(ports(), { flags: { ...solo, land: 'hold' } })
    expect(chosen.entry('register')).toMatchObject({ applies: false })
    const typed = await walk(ports(), { flags: { ...solo, land: 'main' } })
    expect(typed.entry('register')).toMatchObject({ applies: false })
  })

  it('is asked after a typed yes to use this setup, and refused with no terminal and no flag', async () => {
    const typedYes = await walk(ports(), {
      interactive: true,
      flags: { mode: 'solo', main: 'main' },
      askers: { ...everyDefault, defaults: () => Effect.succeed({ answer: 'yes' }) },
    })
    expect(typedYes.entry('register')).toMatchObject({ applies: true, asked: true })
    const declined = await walk(ports(), {
      interactive: true,
      flags: { mode: 'solo', main: 'main' },
      askers: {
        ...everyDefault,
        defaults: () => Effect.succeed({ answer: 'yes' }),
        register: () => Effect.succeed({ answer: 'no' }),
      },
    })
    expect(declined.result.refused).toBe('stopped before registering — nothing was written and nothing was registered')
    // No terminal and no --defaults: the switch is never asked, so nobody has looked, and the confirmation is refused.
    const headless = await walk(ports(), { flags: { mode: 'solo', main: 'main' } })
    expect(headless.result.refused).toContain('--defaults')
    // The same where nothing checks a diff, whichever landing is unattended.
    const bare = ports({
      proposal: proposal({ detected: { known: true, value: { install: null, build: [], skipped: [], notes: [] } } }),
    })
    const noChecks = await walk(bare, { flags: { mode: 'solo', main: 'main', land: 'hold' } })
    expect(noChecks.result.refused).toContain('--defaults')
  })
})

describe('a repository no App can read yet', () => {
  it('does not look the main up, so setup reaches the App it creates after the list', async () => {
    const down = ports({ branchExists: () => Effect.succeed('unreadable'), notReadableYet: true })
    const { result, ctx } = await walk(down, { flags: { ...DEFAULTS, mode: 'solo', main: 'main' } })
    expect(result.refused).toBeUndefined()
    expect(ctx.answers.branch).toMatchObject({ name: 'main' })
  })
})

describe('no terminal, no flag', () => {
  it('takes every default where one exists, and refuses naming what is missing', async () => {
    const solo = await walk(ports(), { flags: { mode: 'solo', main: 'main', land: 'hold' } })
    expect(solo.result.refused).toBeUndefined()
    expect(solo.result.entries.filter((e) => e.asked)).toEqual([])
    const noLogin = await walk(ports({ knownLogin: null }), { flags: { mode: 'team' } })
    expect(noLogin.result.refused).toBe('your GitHub login needs an answer: pass --login <login>. Nothing was written')
    const noBranch = await walk(ports(), { flags: { mode: 'team' } })
    expect(noBranch.result.refused).toContain('making the personal branch needs an answer: pass --defaults')
  })
})

describe('a port that fails refuses with its own words', () => {
  const down = (what: string) => Effect.fail(new Error(what))

  it('says the runtimes probe failed, whatever step reads it', async () => {
    const walked = await walk(ports({ runtimes: down('no probe') }), { flags: DEFAULTS })
    expect(walked.result.refused).toContain('no probe')
    const flagged = await walk(ports({ runtimes: down('no probe') }), {
      flags: { ...DEFAULTS, agent: 'claude-code', reviewer: 'codex' },
    })
    expect(flagged.result.refused).toContain('no probe')
    // Past the writer's own read, every later read of the port refuses by name too.
    let reads = 0
    const later = ports({
      runtimes: Effect.suspend(() =>
        ++reads > 1 ? down('probe died later') : Effect.succeed([found('claude-code'), found('codex')]),
      ),
    })
    const second = await walk(later, { flags: { ...DEFAULTS, agent: 'claude-code', reviewer: 'codex' } })
    expect(second.result.refused).toContain('probe died later')
  })

  it('says the detection read failed', async () => {
    const reader = { has: () => Effect.succeed(true), read: () => Effect.fail(new Error('disk gone')) }
    const walked = await walk(ports({ proposal: undefined, reader }), { flags: DEFAULTS })
    expect(walked.result.refused).toContain('disk gone')
  })

  it('says the trial failed to run', async () => {
    const trial: ProjectPorts['trial'] = () => Effect.fail(new Error('worktree gone'))
    const walked = await walk(ports({ trial }), {
      interactive: false,
      flags: { ...DEFAULTS, 'check-build': 'yes' },
    })
    expect(walked.result.refused).toBe('the trial build failed to run — worktree gone. Nothing was written')
    const died = await walk(ports({ trial: () => Effect.die(new Error('worktree died')) }), {
      flags: { ...DEFAULTS, 'check-build': 'yes' },
    })
    expect(died.result.refused).toContain('worktree died')
  })
})
