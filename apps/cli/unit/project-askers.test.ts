/**
 * `project-askers.ts` (#1529): the project list, walked through the terminal's askers over a fake terminal, draws the
 * prompts today's `askRecipeEffect` draws — same words, same choices, same bracketed default. No filesystem, by 0060
 * §1: the file seam is a `Map`, the trial is a fake, and the world records each prompt and answers from a script.
 *
 * **Enter everywhere tests almost nothing**: the runner answers every question itself once *use every default?* is yes,
 * so each case runs twice — (a) Enter everywhere, (b) `no` at *use every default?* and Enter elsewhere, which is the
 * run that reaches the agent, sandbox, install, checks, trial, tickets, landing and limit askers.
 */
import { ProjectFiles, draftRecipe, keyIn, recipePath, type RecipeDraft } from '@lingtai/project'
import { type RecipeChange, type RecipeFiles, RECIPE_VERSION, editRecipe } from '@lingtai/recipe'
import {
  EMPTY_SETUP_READER,
  END_ACTIONS,
  PROJECT_QUESTION_IDS,
  type Proposal,
  type ProjectPorts,
  type RuntimeFound,
  type Trial,
  type TrialReport,
  defaultPersonalBranch,
  projectContext,
  projectList,
  runSetupList,
} from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type ProjectAskers, projectAskers, trialPortOver } from '../src/project-askers.ts'
import type { QuestionWorld } from '../src/question.ts'
import { askRecipeEffect, type RecipeAt } from '../src/recipe-flow.ts'
import { askInstallAndBuildEffect } from '../src/setup-build.ts'

const HOME = '/home/me/.lingtai'
const PROJECT = 'acme'

const signedIn = (id: RuntimeFound['id']): RuntimeFound => ({ id, state: 'signed-in', signedIn: true, detail: '' })
const RUNTIMES = [signedIn('claude-code'), signedIn('codex')]

const DETECTED = {
  install: { run: 'pnpm install', because: 'a pnpm lockfile' },
  build: [{ name: 'test', run: 'pnpm test', because: 'a test script' }],
  skipped: [],
  notes: [],
}
const PROPOSAL = {
  detected: { known: true, value: DETECTED, because: 'read' },
  kinds: { known: true, value: ['bug', 'feature'], because: 'read' },
  sandbox: null,
} as unknown as Proposal

// ---------------------------------------------------------------------------------------------------------------
// A fake terminal

interface Drawn {
  prompt: string
  choices: readonly string[] | undefined
  defaultValue: string | undefined
}
/** Answers are consumed in order per pattern; a prompt no pattern names is answered with Enter. */
type Script = { match: RegExp; answers: string[] }[]

function terminal(script: Script): QuestionWorld & { drawn: Drawn[]; logged: string[] } {
  const drawn: Drawn[] = []
  const logged: string[] = []
  const queues = script.map((s) => ({ match: s.match, answers: [...s.answers] }))
  return {
    drawn,
    logged,
    log: (line) => logged.push(line),
    ask: (prompt, opts) => {
      drawn.push({ prompt, choices: opts?.choices, defaultValue: opts?.defaultValue })
      const queue = queues.find((q) => q.match.test(opts?.message ?? prompt))
      return Promise.resolve(queue?.answers.shift() ?? '')
    },
  }
}

const EVERY_DEFAULT = /use every default/
/** (a) Enter everywhere. (b) `no` at *use every default?*, Enter elsewhere. */
const RUNS = { a: [] as Script, b: [{ match: EVERY_DEFAULT, answers: ['no'] }] as Script }

// ---------------------------------------------------------------------------------------------------------------
// A fake trial: one report, handed to both sides

const passed = (commands: readonly string[]): TrialReport => ({
  results: commands.map((command) => ({ command, outcome: 'passed' as const, evidence: '' })),
  nothingDeclared: false,
})
const fakeTrial = (reports: TrialReport[] = []): Trial & { ran: number } => {
  const trial = {
    ran: 0,
    base: Effect.succeed('main'),
    run: (install: string | null, build: string[]) =>
      Effect.sync(() => passed([...(install === null ? [] : [install]), ...build])).pipe(
        Effect.map((fallback) => reports[trial.ran++] ?? fallback),
      ),
  }
  return trial
}

// ---------------------------------------------------------------------------------------------------------------
// The two sides

function mapFiles(initial: Record<string, string> = {}): RecipeFiles {
  const store = new Map(Object.entries(initial))
  return {
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => void store.set(path, text),
  }
}

const SEEDS: RecipeChange[] = [
  { path: ['branch', 'main'], value: 'main' },
  { path: ['env', 'plantAt'], value: '.env.local' },
  { path: ['steps', 'end'], value: END_ACTIONS },
]

interface Shape {
  local: boolean
  /** The recipe text the run began with; null is a first run. */
  start: string | null
  /** What the mode prompt is answered with (Enter would be team). */
  mode: 'solo' | 'team'
}

const branchExists = (name: string) => Effect.succeed(name === 'main' || name === 'lingtai-base')

function portsFor(shape: Shape, trial: ProjectPorts['trial']): ProjectPorts {
  return {
    project: PROJECT,
    local: shape.local,
    checkout: shape.local ? '/work/acme' : null,
    knownLogin: 'alice',
    hostname: 'laptop.local',
    defaultBranch: Effect.succeed(shape.local ? null : 'main'),
    branchExists,
    commitsOnlyIn: () => Effect.succeed([]),
    reader: EMPTY_SETUP_READER,
    runtimes: Effect.succeed(RUNTIMES),
    history: () => Effect.succeed([]),
    proposal: PROPOSAL,
    codexText: Effect.succeed(false),
    onPath: () => Effect.succeed(true),
    ...(trial === undefined ? {} : { trial }),
  }
}

const draftOf = (text: string | null): RecipeDraft => ({
  path: recipePath(PROJECT, HOME),
  set: () => Effect.die('the list must not set the draft'),
  get: (path) => keyIn(text, path),
  text: () => text,
  changes: () => [],
})

/** The list, walked through `projectAskers`, over a terminal that answers from `script`. */
async function walkList(shape: Shape, script: Script, trial: Trial) {
  const world = terminal([...script, { match: /does anyone else work/i, answers: [shape.mode] }])
  const ports = portsFor(
    shape,
    trialPortOver(world, { project: PROJECT, home: HOME }, () => trial),
  )
  const ctx = projectContext({
    start: draftOf(shape.start),
    buildFlags: [],
    flags: {},
    ports,
    kept: 'Nothing was written',
    seeds: shape.start === null ? SEEDS : [],
  })
  const result = await Effect.runPromise(
    runSetupList(
      projectList(ports),
      {
        interactive: true,
        defaults: false,
        flags: {},
        askers: projectAskers(world),
        log: (line) => ctx.log.push(line),
        kept: () => ({ kept: ctx.kept }),
      },
      ctx,
    ),
  )
  return { world, ctx, result }
}

/** Today's flow, over the same world: `askRecipeEffect`. */
async function walkToday(shape: Shape, script: Script, trial: Trial) {
  const world = terminal([...script, { match: /does anyone else work/i, answers: [shape.mode] }])
  const files = mapFiles(shape.start === null ? {} : { [recipePath(PROJECT, HOME)]: shape.start })
  const at: RecipeAt = {
    project: PROJECT,
    home: HOME,
    local: shape.local,
    runtimes: RUNTIMES,
    reader: EMPTY_SETUP_READER,
    flags: {},
    buildFlags: [],
    defaultBranch: async () => (shape.local ? null : 'main'),
    proposal: PROPOSAL,
    tryBuild: trial,
    history: async () => [],
    seeds: shape.start === null ? SEEDS : [],
    kept: 'Nothing was written',
    keptBeforeWrite: 'Nothing was written',
    again: 'lingtai add',
    rates: () => [],
    ...(shape.local ? { mode: shape.mode } : {}),
    codexText: () => undefined,
    team: {
      knownLogin: 'alice',
      hostname: () => 'laptop.local',
      branchExists,
      commitsOnlyIn: () => Effect.succeed([]),
    },
  }
  const result = await Effect.runPromise(askRecipeEffect(world, at).pipe(Effect.provideService(ProjectFiles, files)))
  return { world, result }
}

/** What a rerun starts from: the recipe the list writes under every default, for this shape. */
async function recipeFor(shape: Omit<Shape, 'start'>): Promise<string> {
  const { ctx, result } = await walkList({ ...shape, start: null }, RUNS.a, fakeTrial())
  expect(result.refused).toBeUndefined()
  return editRecipe(`version: ${RECIPE_VERSION}\n`, ctx.pending)
}

const lines = (drawn: readonly Drawn[]) =>
  drawn.map((d) => `${d.prompt} | ${d.choices?.join('/') ?? ''} | ${d.defaultValue ?? ''}`)

// ---------------------------------------------------------------------------------------------------------------

describe('the record is typed over every id the terminal asks', () => {
  it('a missing key fails tsc', () => {
    // @ts-expect-error `where` and `findings-judge` are left out on purpose; every other id has an asker
    const partial: ProjectAskers = { mode: () => Effect.succeed({ answer: 'team' }) }
    expect(Object.keys(partial)).toEqual(['mode'])
  })

  it('covers every id of the list but the two that are never asked', () => {
    const asked = Object.keys(projectAskers(terminal([]))).sort()
    expect(asked).toEqual(PROJECT_QUESTION_IDS.filter((id) => id !== 'where' && id !== 'findings-judge').sort())
  })
})

describe('the list through PROJECT_ASKERS draws what askRecipeEffect draws', () => {
  const shapes: { name: string; shape: Omit<Shape, 'start'> }[] = [
    { name: 'solo GitHub', shape: { local: false, mode: 'solo' } },
    { name: 'team GitHub', shape: { local: false, mode: 'team' } },
    { name: 'local', shape: { local: true, mode: 'solo' } },
  ]

  for (const { name, shape } of shapes) {
    for (const run of ['first run', 'rerun'] as const) {
      for (const [which, script] of Object.entries(RUNS)) {
        it(`${name}, ${run}, (${which})`, async () => {
          const full: Shape = { ...shape, start: run === 'first run' ? null : await recipeFor(shape) }
          const list = await walkList(full, script, fakeTrial())
          const today = await walkToday(full, script, fakeTrial())
          expect(list.result.refused).toBeUndefined()
          expect(today.result).toHaveProperty('ok', true)

          let drawn = lines(list.world.drawn)
          if (shape.local) {
            // `init --local` asks the mode, the base, the branch and the landing move before `askRecipe`, in
            // `first-project.ts`, through the same pieces: only what `askRecipe` asks is compared here.
            const from = list.world.drawn.findIndex((d) => EVERY_DEFAULT.test(d.prompt))
            expect(from).toBeGreaterThan(0)
            drawn = lines(list.world.drawn.slice(from))
          }
          expect(drawn).toEqual(lines(today.world.drawn))
          // Every run is more than the switch: (b) reaches the questions after it.
          if (which === 'b') expect(drawn.length).toBeGreaterThan(8)
        })
      }
    }
  }

  it('team GitHub names the personal branch the machine would', async () => {
    const list = await walkList({ local: false, start: null, mode: 'team' }, RUNS.a, fakeTrial())
    expect(list.ctx.pending.find((c) => c.path.join('.') === 'branch.personal')?.value).toBe(
      defaultPersonalBranch('alice', 'laptop.local'),
    )
  })
})

describe('the trial answered edit', () => {
  const FAILED: TrialReport = {
    results: [
      { command: 'pnpm install', outcome: 'passed', evidence: '' },
      { command: 'pnpm test', outcome: 'failed', evidence: 'red' },
    ],
    nothingDeclared: false,
  }
  /** Run the trial, fail it, edit the list to `pnpm lint`, and pass the second time. */
  const script: Script = [
    { match: /keep the list as it is, edit it/, answers: ['edit'] },
    { match: /keep this list/, answers: ['', 'no'] },
    { match: /a command that must pass/, answers: ['pnpm lint', ''] },
  ]
  const ticks = (d: readonly Drawn[]) => lines(d)

  it('re-asks the checks through the askers, asks the trial once a round, and keeps the edited list', async () => {
    const trial = fakeTrial([FAILED, passed(['pnpm install', 'pnpm lint'])])
    const list = await walkList({ local: false, start: null, mode: 'solo' }, [...RUNS.b, ...script], trial)
    expect(list.result.refused).toBeUndefined()
    expect(trial.ran).toBe(2)

    const drawn = ticks(list.world.drawn)
    const tried = drawn.filter((l) => l.startsWith('Try them once now'))
    // Once for the entry's own question and once after the edit — never twice in a round.
    expect(tried).toHaveLength(2)

    const builds = list.ctx.pending.filter((c) => c.path.join('.') === 'steps.build')
    expect(JSON.stringify(builds.at(-1)?.value)).toContain('pnpm lint')
    expect(JSON.stringify(builds.at(-1)?.value)).not.toContain('pnpm test')
    expect(list.ctx.answers.checks).toEqual(['pnpm lint'])

    // What is drawn from the failed run on is what today's loop draws for the same report and answers.
    const world = terminal(script)
    const todayTrial = fakeTrial([FAILED, passed(['pnpm install', 'pnpm lint'])])
    const files = mapFiles()
    const draft = await Effect.runPromise(
      draftRecipe(PROJECT, { home: HOME }).pipe(Effect.provideService(ProjectFiles, files)),
    )
    const today = await Effect.runPromise(
      askInstallAndBuildEffect(world, {
        project: PROJECT,
        reader: EMPTY_SETUP_READER,
        detected: DETECTED,
        given: { install: null, build: null, check: null },
        tryBuild: todayTrial,
        recipeExisted: false,
        home: HOME,
        draft,
      }),
    )
    expect('refused' in today).toBe(false)
    const after = (all: readonly string[]) =>
      all.slice(all.findIndex((l) => l.startsWith('keep the list as it is, edit it')))
    expect(after(drawn).slice(0, after(ticks(world.drawn)).length)).toEqual(after(ticks(world.drawn)))
  })
})

describe('the trial port, called directly', () => {
  const view = (values: Record<string, unknown>) => ({
    get: (path: readonly string[]) => values[path.join('.')] ?? null,
    resolved: () => null,
  })
  const failedThenPassed = () =>
    fakeTrial([
      {
        results: [
          { command: 'pnpm install', outcome: 'failed', evidence: 'red' },
          { command: 'pnpm test', outcome: 'skipped' as never, evidence: '' },
        ],
        nothingDeclared: false,
      },
    ])

  it('a --build answer is not asked again when the install is edited', async () => {
    const world = terminal([
      { match: /keep the list as it is, edit it/, answers: ['edit'] },
      { match: /install/, answers: ['pnpm i --frozen-lockfile'] },
      { match: /keep this list/, answers: ['no'] },
    ])
    const port = trialPortOver(world, { project: PROJECT, home: HOME }, () => failedThenPassed())
    const out = await Effect.runPromise(
      port({
        view: view({}),
        install: 'pnpm install',
        checks: [{ name: 'test', run: 'pnpm test' }],
        given: { install: null, build: ['pnpm test'], check: null },
        make: null,
        recipeExisted: false,
        kept: 'Nothing was written',
      } as never),
    )
    expect('refused' in out).toBe(false)
    expect(world.drawn.some((d) => /keep this list/.test(d.prompt))).toBe(false)
    if (!('refused' in out)) expect(out.checks.map((c) => c.run)).toEqual(['pnpm test'])
  })

  it('a solo local branch still to be made is the base the trial cuts from', async () => {
    let base: string | null = null
    const world = terminal([])
    const port = trialPortOver(world, { project: PROJECT, home: HOME }, (draft, b) => {
      base = (draft.get(['branch', 'main']) as string | null) ?? b
      return fakeTrial()
    })
    await Effect.runPromise(
      port({
        view: view({ 'branch.main': 'new-base' }),
        install: null,
        checks: [{ name: 'test', run: 'pnpm test' }],
        given: { install: null, build: null, check: 'yes' },
        make: { name: 'new-base', from: 'old-base' },
        recipeExisted: true,
        kept: 'Nothing was written',
      } as never),
    )
    expect(base).toBe('old-base')
  })
})
