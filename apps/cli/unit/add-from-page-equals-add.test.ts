/**
 * The board's step 2 and `lingtai add` write the same recipe for the same
 * answers (#971). `askRecipe` is driven with `--defaults` over a
 * chapter-garden-shaped repository; the page's answers are the proposal's own,
 * run through `setupAnswers`; both are written by `applySetup` over a `Map`,
 * and the two files are compared byte for byte, comments included.
 */
import { LIMIT_DEFAULTS, type RecipeFiles, recipePath, resolveSource } from '@lingtai/recipe'
import { SandboxUnavailable } from '@lingtai/sandbox'
import {
  applySetup,
  detectSetupEffect,
  LINGTAI_BASE,
  type ProposalReaders,
  proposeSetup,
  type RuntimeFound,
  type SetupForm,
  setupAnswers,
  type SetupReader,
} from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { QuestionWorld } from '../src/question.ts'
import { askRecipeEffect, type RecipeAt } from '../src/recipe-flow.ts'
import { ENV_PLANT_AT } from '../src/recipe-flow.ts'

const HOME = '/home/me/.lingtai'

const REPO: Record<string, string> = {
  'package.json': JSON.stringify({
    scripts: {
      'fmt:check': 'oxfmt --check',
      lint: 'oxlint',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      dev: 'next',
    },
  }),
  'pnpm-lock.yaml': '',
}
const reader: SetupReader = {
  has: (p) => Effect.succeed(p in REPO),
  read: (p) => Effect.succeed(REPO[p] ?? null),
}

const RUNTIMES: readonly RuntimeFound[] = [
  { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' },
  { id: 'codex', state: 'signed-in', signedIn: true, detail: 'signed in' },
]

function mapFiles(): RecipeFiles & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    read: async (p) => store.get(p) ?? null,
    replace: async (p, t) => {
      store.set(p, t)
    },
  }
}

const world: QuestionWorld = { ask: async () => '', log: () => {} }
const askRecipe = (w: QuestionWorld, at: RecipeAt) => Effect.runPromise(askRecipeEffect(w, at))

/** A host that can sandbox, one that cannot, and one that dies — never the real check (#1160). */
const HOST_CAN = Effect.void
const HOST_CANNOT = Effect.fail(new SandboxUnavailable({ reason: 'bwrap is missing', sentences: ['no bwrap on PATH'] }))
const hostReader = (
  answer: ProposalReaders['host'] extends infer H ? (H extends { answer: infer A } ? A : never) : never,
) =>
  ({
    answer,
    install: { missing: ['bwrap'], command: 'apt install bubblewrap' },
    builtIns: ['api.example.com'],
  }) as const

const proposalWith = (answer: Parameters<typeof hostReader>[0] | null) =>
  Effect.runPromise(
    proposeSetup(
      { kind: 'github', owner: 'acme', repo: 'chapter-garden' },
      {
        setupReader: reader,
        defaultBranch: () => Effect.succeed('main'),
        runtimes: () => Effect.succeed(RUNTIMES),
        history: () => Effect.succeed([]),
        origin: () => Effect.succeed(null),
        ...(answer === null ? {} : { host: hostReader(answer) }),
      },
    ),
  )

async function viaAdd(
  project: string,
  local: boolean,
  seeds: SetupForm['target'] extends never ? never : unknown[],
  extra: {
    flags?: Record<string, string>
    proposal?: Awaited<ReturnType<typeof proposalWith>>
    files?: ReturnType<typeof mapFiles>
  } = {},
) {
  const files = extra.files ?? mapFiles()
  const result = await askRecipe(world, {
    ...(extra.proposal === undefined ? {} : { proposal: extra.proposal }),
    project,
    local,
    runtimes: RUNTIMES,
    reader,
    flags: { defaults: 'yes', ...extra.flags },
    buildFlags: [],
    defaultBranch: async () => 'main',
    history: async () => [],
    seeds: seeds as never,
    kept: 'kept',
    keptBeforeWrite: 'Nothing was written',
    again: 'lingtai add',
    home: HOME,
    files,
  })
  if (!('ok' in result)) throw new Error(JSON.stringify(result))
  await Effect.runPromise(applySetup({ home: HOME, files }, result.answers, Effect.void))
  return files.store.get(recipePath(project, HOME))
}

async function viaPage(form: (checks: { name: string; run: string }[], install: string) => SetupForm) {
  const detected = await Effect.runPromise(detectSetupEffect(reader))
  const files = mapFiles()
  const f = form(
    detected.build.map(({ name, run }) => ({ name, run })),
    detected.install?.run ?? '',
  )
  await Effect.runPromise(applySetup({ home: HOME, files }, setupAnswers(f), Effect.void))
  return files.store.get(recipePath(f.project, HOME))
}

const LIMITS = { ...LIMIT_DEFAULTS, turns: 300 as number | 'unbounded' }

describe('the page writes what lingtai add writes (#971)', () => {
  it('a GitHub repository, every default', async () => {
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      {
        path: ['steps', 'end'],
        value: [
          { name: 'close the ticket', when: 'landed', close: true },
          { name: 'close the ticket a person ended', when: 'closed', close: true },
        ],
      },
    ]
    const expected = await viaAdd('chapter-garden', false, seeds)
    const written = await viaPage((checks, install) => ({
      project: 'chapter-garden',
      target: { kind: 'github', owner: 'acme', repo: 'chapter-garden' },
      base: 'main',
      remote: null,
      install,
      checks,
      writer: 'claude-code',
      reviewer: 'codex',
      tickets: 'github',
      kinds: ['bug', 'feature', 'tech-debt', 'documentation'],
      heldBy: '',
      closeOnEnd: true,
      personApprovesMerge: false,
      limits: LIMITS,
      turnsUnbounded: false,
      sandbox: null,
    }))
    expect(expected).toBeDefined()
    expect(written).toBe(expected)
  })

  it('a local directory, every default', async () => {
    const seeds = [
      { path: ['repo', 'base'], value: LINGTAI_BASE },
      { path: ['repo', 'remote'], value: '/work/chapter-garden' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]
    const expected = await viaAdd('chapter-garden', true, seeds)
    const written = await viaPage((checks, install) => ({
      project: 'chapter-garden',
      target: { kind: 'local', path: '/work/chapter-garden' },
      base: LINGTAI_BASE,
      remote: '/work/chapter-garden',
      install,
      checks,
      writer: 'claude-code',
      reviewer: 'codex',
      tickets: 'db',
      kinds: ['bug', 'feature', 'tech-debt', 'documentation'],
      heldBy: '',
      closeOnEnd: false,
      personApprovesMerge: false,
      limits: LIMITS,
      turnsUnbounded: false,
      sandbox: null,
    }))
    expect(written).toBe(expected)
  })
})

describe('the sandbox step, new recipe (#1160)', () => {
  const GH_SEEDS = [
    { path: ['repo', 'base'], value: 'main' },
    { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
  ]
  const form =
    (sandbox: SetupForm['sandbox']) =>
    (checks: { name: string; run: string }[], install: string): SetupForm => ({
      project: 'chapter-garden',
      target: { kind: 'github', owner: 'acme', repo: 'chapter-garden' },
      base: 'main',
      remote: null,
      install,
      checks,
      writer: 'claude-code',
      reviewer: 'codex',
      tickets: 'github',
      kinds: ['bug', 'feature', 'tech-debt', 'documentation'],
      heldBy: '',
      closeOnEnd: false,
      personApprovesMerge: false,
      limits: LIMITS,
      turnsUnbounded: false,
      sandbox,
    })
  const sandboxOf = (text: string | undefined) => {
    const path = recipePath('chapter-garden', HOME)
    return resolveSource(text ?? '', path, path).recipe.sandbox
  }

  it('on: both inputs write `sandbox: { enabled: true }` and nothing about required or network', async () => {
    const proposal = await proposalWith(HOST_CAN)
    const expected = await viaAdd('chapter-garden', false, GH_SEEDS, { proposal })
    const written = await viaPage(form({ enabled: true, allow: [] }))
    expect(sandboxOf(expected)).toMatchObject({ enabled: true, required: false })
    expect(expected).not.toContain('allow')
    expect(sandboxOf(written)).toEqual(sandboxOf(expected))
  })

  it('on with extra hosts: both write network.allow', async () => {
    const proposal = await proposalWith(HOST_CAN)
    const expected = await viaAdd('chapter-garden', false, GH_SEEDS, {
      proposal,
      flags: { 'sandbox-hosts': 'a.example.com,b.example.com' },
    })
    const written = await viaPage(form({ enabled: true, allow: ['a.example.com', 'b.example.com'] }))
    expect(sandboxOf(expected)?.network.allow).toEqual(['a.example.com', 'b.example.com'])
    expect(sandboxOf(written)).toEqual(sandboxOf(expected))
  })

  it('off: both write `sandbox: { enabled: false }`, so the choice is on record', async () => {
    const proposal = await proposalWith(HOST_CAN)
    const expected = await viaAdd('chapter-garden', false, GH_SEEDS, { proposal, flags: { sandbox: 'off' } })
    const written = await viaPage(form({ enabled: false, allow: [] }))
    expect(sandboxOf(expected)).toMatchObject({ enabled: false })
    expect(sandboxOf(written)).toEqual(sandboxOf(expected))
  })

  it('a host that cannot still gets the block written, and says why with the install command', async () => {
    const proposal = await proposalWith(HOST_CANNOT)
    const lines: string[] = []
    const files = mapFiles()
    const result = await askRecipe(
      { ask: async () => '', log: (l) => lines.push(l) },
      {
        project: 'chapter-garden',
        local: false,
        proposal,
        runtimes: RUNTIMES,
        reader,
        flags: { defaults: 'yes' },
        buildFlags: [],
        defaultBranch: async () => 'main',
        history: async () => [],
        seeds: GH_SEEDS as never,
        kept: 'kept',
        keptBeforeWrite: 'Nothing was written',
        again: 'lingtai add',
        home: HOME,
        files,
      },
    )
    if (!('ok' in result)) throw new Error(JSON.stringify(result))
    expect(lines.join('\n')).toContain('cannot run the sandbox yet: bwrap is missing; no bwrap on PATH')
    expect(lines.join('\n')).toContain('apt install bubblewrap')
    await Effect.runPromise(applySetup({ home: HOME, files }, result.answers, Effect.void))
    expect(sandboxOf(files.store.get(recipePath('chapter-garden', HOME)))).toMatchObject({
      enabled: true,
      required: false,
    })
  })

  it('an existing recipe is not asked, and its block is neither added nor changed', async () => {
    const files = mapFiles()
    await viaAdd('chapter-garden', false, GH_SEEDS, { files })
    const before = files.store.get(recipePath('chapter-garden', HOME))
    expect(sandboxOf(before)).toBeUndefined()
    const proposal = await proposalWith(HOST_CAN)
    // `--sandbox off` would write `enabled: false` if the step were asked.
    await viaAdd('chapter-garden', false, [], { files, proposal, flags: { sandbox: 'off' } })
    expect(sandboxOf(files.store.get(recipePath('chapter-garden', HOME)))).toBeUndefined()
  })
})
