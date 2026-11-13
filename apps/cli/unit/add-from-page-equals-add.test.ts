/**
 * The board's step 2 and `lingtai add` write the same recipe for the same
 * answers (#971). `askRecipe` is driven with `--defaults` over a
 * chapter-garden-shaped repository; the page's answers are the proposal's own,
 * run through `setupAnswers`; both are written by `applySetup` over a `Map`,
 * and the two files are compared byte for byte, comments included.
 */
import { LIMIT_DEFAULTS, type RecipeFiles, recipePath } from '@lingtai/recipe'
import {
  applySetup,
  detectSetupEffect,
  LINGTAI_BASE,
  type RuntimeFound,
  type SetupForm,
  setupAnswers,
  type SetupReader,
} from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { QuestionWorld } from '../src/question.ts'
import { askRecipe } from '../src/recipe-flow.ts'
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
  has: async (p) => p in REPO,
  read: async (p) => REPO[p] ?? null,
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

async function viaAdd(project: string, local: boolean, seeds: SetupForm['target'] extends never ? never : unknown[]) {
  const files = mapFiles()
  const result = await askRecipe(world, {
    project,
    local,
    runtimes: RUNTIMES,
    reader,
    flags: { defaults: 'yes' },
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
    }))
    expect(written).toBe(expected)
  })
})
