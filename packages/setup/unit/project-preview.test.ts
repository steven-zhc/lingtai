import { keyIn, projectView, type RecipeDraft } from '@lingtai/project'
import { editRecipe, RECIPE_VERSION, type RecipeChange } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { EMPTY_SETUP_READER } from '../src/detect-setup.ts'
import {
  projectContext,
  projectList,
  PROJECT_QUESTION_IDS,
  type ProjectContext,
  type ProjectPorts,
} from '../src/project-list.ts'
import { forkProjectContext, runProjectList } from '../src/project-preview.ts'
import type { Proposal } from '../src/propose-setup.ts'
import { setupRows, type Asker, type SetupInput } from '../src/setup-list.ts'

const start = (text: string | null): RecipeDraft => ({
  path: '/h/acme/recipe.yml',
  text: () => text,
  get: (path) => keyIn(text, path),
  changes: () => [],
  set: () => Effect.die('a preview must never apply a draft'),
})
const detected = { install: null, build: [{ name: 'test', run: 'pnpm test', because: 'test' }], notes: [], skipped: [] }
const proposal = {
  detected: { known: true, value: detected },
  kinds: { known: true, value: ['bug'] },
  sandbox: { verdict: { can: true }, install: null, builtIns: ['github.com'] },
} as unknown as Proposal
const ports = (over: Partial<ProjectPorts> = {}): ProjectPorts => ({
  project: 'acme',
  location: 'o/acme',
  local: false,
  checkout: null,
  knownLogin: 'sam',
  hostname: 'studio',
  defaultBranch: Effect.succeed('main'),
  branchExists: () => Effect.succeed(true),
  commitsOnlyIn: () => Effect.succeed([]),
  reader: EMPTY_SETUP_READER,
  runtimes: Effect.succeed(
    ['codex', 'claude-code'].map((id) => ({ id, state: 'signed-in', signedIn: true, detail: '' })) as never,
  ),
  history: () => Effect.succeed([]),
  codexText: Effect.succeed(false),
  onPath: () => Effect.succeed(true),
  proposal,
  ...over,
})
const seeds: RecipeChange[] = [{ path: ['env', 'plantAt'], value: '.env.local' }]
const context = (p = ports(), text: string | null = null, flags: Record<string, string> = {}) =>
  projectContext({
    ports: p,
    start: start(text),
    flags,
    buildFlags: [],
    seeds: text === null ? seeds : [],
    kept: 'Nothing was written',
  })
const defaults: Record<string, Asker<ProjectContext>> = Object.fromEntries(
  PROJECT_QUESTION_IDS.map((id) => [
    id,
    (d: Parameters<Asker<ProjectContext>>[0]) => Effect.succeed({ answer: d.default ?? 'yes' }),
  ]),
)
const input = (askers = defaults, flags: Record<string, string> = {}): SetupInput<ProjectContext> => ({
  askers,
  flags,
  interactive: true,
  defaults: false,
  log: () => {},
  kept: () => ({ kept: 'Nothing was written' }),
})
const previewInput = { ...input(), interactive: false, defaults: true }
const run = (ctx: ProjectContext, askers = defaults) =>
  Effect.runPromise(runProjectList(ctx, input(askers, ctx.flags), { ...previewInput, flags: ctx.flags }))
const textOf = (ctx: ProjectContext) => editRecipe(`version: ${RECIPE_VERSION}\n`, ctx.pending)

describe('project preview boundary', () => {
  it('forks the entire pending state, answers and log independently, preserving the live view binding', () => {
    const ctx = context()
    ctx.answers.branch = { name: 'sam/studio', exists: true, main: 'main', from: null, onlyIn: ['abc work'] }
    ctx.log.push('original')
    ctx.pending.push({ path: ['source', 'kinds'], value: ['bug'] })
    const fork = forkProjectContext(ctx)
    ;(fork.pending[1]!.value as string[]).push('feature')
    fork.answers.branch!.onlyIn!.push('def work')
    fork.log.push('preview')
    expect(ctx.view.get(['source', 'kinds'])).toEqual(['bug'])
    expect(fork.view.get(['source', 'kinds'])).toEqual(['bug', 'feature'])
    expect(ctx.answers.branch.onlyIn).toEqual(['abc work'])
    expect(ctx.log).toEqual(['original'])
  })

  it('previews remaining rows, writes nothing and runs no trial; yes adopts precisely the shown values', async () => {
    let trials = 0
    const ctx = context(
      ports({
        trial: () => {
          trials++
          return Effect.die('not requested')
        },
      }),
    )
    let shown: readonly string[] = []
    let pending: RecipeChange[] = []
    const result = await run(ctx, {
      ...defaults,
      defaults: (d) => {
        shown = d.why
        pending = structuredClone(ctx.pending)
        expect(ctx.start.changes()).toEqual([])
        expect(trials).toBe(0)
        expect(ctx.answers.writer).toBeUndefined()
        expect(ctx.view.get(['steps', 'implement'])).toBeNull()
        return Effect.succeed({ answer: 'yes' })
      },
    })
    expect(result.refused).toBeUndefined()
    expect(trials).toBe(0)
    expect(shown.some((line) => line.startsWith('sandbox  on'))).toBe(true)
    const remaining = new Set(
      projectList(ctx.ports)
        .slice(7)
        .map((q) => q.id),
    )
    expect(result.rows.filter((r) => remaining.has(r.id as never)).map((r) => `${r.label}  ${r.text}`)).toEqual(shown)
    expect(ctx.pending.slice(0, pending.length)).toEqual(pending)
    expect(ctx.view.resolved()).not.toBeNull()
    expect(ctx.answers.trial).toEqual({ trial: 'not-run', because: 'declined' })
  })

  it('no discards the fork and asks the remaining descriptors in execution order', async () => {
    const ctx = context()
    const asked: string[] = []
    const askers = Object.fromEntries(
      Object.entries(defaults).map(([id, ask]) => [
        id,
        ((d) => {
          asked.push(id)
          return id === 'defaults' ? Effect.succeed({ answer: 'no' }) : ask(d)
        }) as Asker<ProjectContext>,
      ]),
    )
    const result = await run(ctx, askers)
    expect(result.refused).toBeUndefined()
    expect(asked).toEqual(result.entries.filter((e) => e.asked).map((e) => e.id))
    expect(ctx.answers.defaults).toBe('no')
  })

  it('accepting a preview still permits registration refusal and persists nothing', async () => {
    const ctx = context(ports(), null, { mode: 'solo', main: 'main' })
    const result = await run(ctx, { ...defaults, register: () => Effect.succeed({ answer: 'no' }) })
    expect(result.refused).toContain('nothing was written and nothing was registered')
    expect(ctx.start.changes()).toEqual([])
  })

  it('failed reads identify the descriptor and cannot be adopted; no can proceed after the read recovers', async () => {
    for (const answer of ['yes', 'no']) {
      const p = ports({
        proposal: undefined,
        reader: { has: () => Effect.succeed(true), read: () => Effect.fail(new Error('disk gone')) },
      })
      const ctx = context(p)
      let atChoice: RecipeChange[] = []
      const result = await run(ctx, {
        ...defaults,
        defaults: (d) => {
          expect(d.why).toHaveLength(1)
          expect(d.why[0]).toMatch(/install  could not read.*disk gone/)
          atChoice = structuredClone(ctx.pending)
          p.proposal = proposal
          return Effect.succeed({ answer })
        },
      })
      if (answer === 'yes') {
        expect(result.refused).toContain('disk gone')
        expect(ctx.pending).toEqual(atChoice)
        expect(ctx.answers.defaults).toBeUndefined()
      } else expect(result.refused).toBeUndefined()
    }
  })

  it('retains resolution failures instead of presenting an empty successful preview', async () => {
    const ctx = context()
    ctx.pending.push({ path: ['repo', 'submodules'], value: 'broken' })
    const result = await run(ctx, {
      ...defaults,
      defaults: (d) => {
        expect(d.why.join('\n')).toContain('does not resolve')
        return Effect.succeed({ answer: 'yes' })
      },
    })
    expect(result.refused).toContain('does not resolve')
    expect(ctx.answers.writer).toBeUndefined()
  })

  it('projects final rows after trial edits, including a trial explicitly requested by flag', async () => {
    let trials = 0
    const ctx = context(
      ports({
        trial: () => {
          trials++
          return Effect.succeed({
            install: 'npm ci',
            checks: [{ name: 'check', run: 'npm test' }],
            trial: { trial: 'passed', ms: 1 },
          })
        },
      }),
      null,
      { 'check-build': 'yes' },
    )
    const result = await run(ctx, {
      ...defaults,
      defaults: () => {
        expect(trials).toBe(0)
        return Effect.succeed({ answer: 'yes' })
      },
    })
    expect(result.refused).toBeUndefined()
    expect(trials).toBe(1)
    expect(result.rows.find((r) => r.id === 'checks')?.text).toBe('npm test')
    expect(result.rows.find((r) => r.id === 'install')?.text).toBe('npm ci')
  })

  it('keeps the team explanations with descriptor rows and local tickets with their own login rule', async () => {
    const team = await run(context())
    expect(team.rows.find((r) => r.id === 'login')?.text).toBe('issues assigned to sam')
    expect(team.rows.find((r) => r.id === 'branch')?.text).toContain('is brought in when you submit a PR')
    expect(team.rows.find((r) => r.id === 'branch')?.text).toContain('never pushes main')
    const local = await run(context(ports({ local: true, checkout: '/repo', knownLogin: null })))
    expect(local.refused).toBeUndefined()
    expect(local.rows.find((r) => r.id === 'login')?.text).toBe('every ticket — local tickets are yours')
    expect(local.rows.find((r) => r.id === 'tickets')?.text).toContain('Lingtai’s table')
  })

  it('keeps remote credentials out of projected row snapshots', async () => {
    const result = await run(context(ports({ location: 'https://me:secret@github.com/o/acme' })))
    expect(JSON.stringify(result.rows)).not.toContain('secret')
    expect(result.rows.find((r) => r.id === 'where')?.text).toContain('***@github.com')
  })

  it('projects the solo GitHub selection rule, including a named login that still takes all issues', async () => {
    const first = context(ports(), null, { mode: 'solo', main: 'main' })
    const result = await run(first)
    expect(result.refused).toBeUndefined()
    expect(result.rows.find((r) => r.id === 'login')?.text).toBe('every issue, whoever it is assigned to')
    const text = editRecipe(textOf(first), [{ path: ['source', 'assignee'], value: { take: 'all', login: 'sam' } }])
    const rerun = await run(context(ports(), text))
    expect(rerun.refused).toBeUndefined()
    expect(rerun.rows.find((r) => r.id === 'login')).toMatchObject({
      text: 'every issue, whoever it is assigned to',
      changed: false,
    })
  })

  it('compares settled composite and derived values on reruns, even when fixed entries have no before answer', async () => {
    const first = context(ports(), null, { agent: 'codex' })
    expect((await run(first)).refused).toBeUndefined()
    const text = textOf(first)
    const again = context(ports(), text)
    expect((await run(again)).rows.every((r) => !r.changed)).toBe(true)
    for (const flags of [
      { agent: 'claude-code' },
      { model: 'model-b' },
      { 'sandbox-hosts': 'api.example.com' },
      { personal: 'sam/other' },
      { wall: '30m' },
      { mode: 'solo', main: 'main', land: 'hold' },
    ] as Record<string, string>[]) {
      const ctx = context(ports(), text, flags)
      const result = await run(ctx)
      expect(result.refused).toBeUndefined()
      const rows = result.rows.filter((r) => r.changed)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.text.includes(' → '))).toBe(true)
      if ('agent' in flags) {
        expect(rows.find((r) => r.id === 'writer')?.text).toBe('codex → claude-code')
        expect(rows.find((r) => r.id === 'findings-judge')?.text).toContain('(codex → claude-code)')
      }
    }
    expect(projectView(start(text), []).resolved()).not.toBeNull()
    expect(setupRows(projectList(first.ports), first).map((r) => r.id)).not.toContain('writer-model')
  })
})
