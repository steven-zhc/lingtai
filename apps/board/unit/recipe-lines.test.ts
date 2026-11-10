import { STEPS } from '@lingtai/domain'
import { resolveRecipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { recipeLines } from '../src/lib/recipe-lines.ts'

const BASE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug, tech-debt], exclude: [blocked, agent:hold] }
env: { required: [], plantAt: .env.local }
steps:
  prepared:
    - { name: install, run: "pnpm install", timeout: 5m }
  build:
    - { name: build, run: "pnpm test", timeout: 20m }
    - { name: lint, run: "pnpm lint", timeout: 5m }
runtime: { agent: claude-code, limits: { turns: unbounded, wall: 2m } }
`
const MINIMAL = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

const lines = async (text: string) => {
  const { recipe } = await resolveRecipe(async () => text, 'main')
  return recipeLines(recipe, 'main')
}
const block = (read: Awaited<ReturnType<typeof lines>>, step: string) => read.steps.find((b) => b.step === step)!
const setting = (read: Awaited<ReturnType<typeof lines>>, step: string, label: string) =>
  block(read, step).settings.find((l) => l.label === label)?.value

describe('recipeLines', () => {
  it('answers ten blocks in STEPS order, each with its sentence', async () => {
    const read = await lines(BASE)
    expect(read.steps.map((b) => b.step)).toEqual([...STEPS])
    for (const b of read.steps) expect(b.says).not.toBe('')
    expect(read.limits.turns).toBe('unbounded')
    expect(read.ceiling).not.toBe('')
  })

  it('lists install under prepared and the checks under build', async () => {
    const read = await lines(BASE)
    expect(block(read, 'prepared').actions).toEqual([
      { label: 'install', value: 'pnpm install', code: true, when: null },
    ])
    expect(block(read, 'build').actions.map((a) => [a.label, a.value])).toEqual([
      ['build', 'pnpm test'],
      ['lint', 'pnpm lint'],
    ])
  })

  it('gives claim its five settings and admit its base', async () => {
    const read = await lines(BASE)
    expect(block(read, 'claim').settings.map((l) => l.label)).toEqual([
      'tickets',
      'kinds',
      'held by',
      'assignee',
      'retries',
    ])
    expect(setting(read, 'claim', 'tickets')).toBe('github')
    expect(setting(read, 'claim', 'kinds')).toBe('bug, tech-debt')
    expect(block(read, 'claim').settings[1]?.chips).toEqual(['bug', 'tech-debt'])
    expect(setting(read, 'claim', 'held by')).toBe('blocked, agent:hold')
    expect(setting(read, 'admit', 'base')).toBe('main')
  })

  it('leaves the empty steps empty, and the proposed answer No', async () => {
    const read = await lines(MINIMAL)
    for (const step of ['prepared', 'design', 'build', 'review', 'merge', 'end']) {
      expect(block(read, step)).toMatchObject({ settings: [], actions: [] })
    }
    expect(setting(read, 'claim', 'held by')).toBe('nothing')
    expect(setting(read, 'proposed', 'a person approves')).toBe('No')
    expect(read.limits.turns).toBe('10')
  })

  it('reads Yes where a human action sits at proposed', async () => {
    const read = await lines(
      MINIMAL.replace('steps: {}', 'steps:\n  proposed:\n    - { name: person, human: Land this?  }'),
    )
    expect(setting(read, 'proposed', 'a person approves')).toBe('Yes')
    expect(block(read, 'proposed').actions).toEqual([{ label: 'person', value: null, code: false, when: null }])
  })

  it('falls back to runtime.agent at implement, and lists a declared agent instead', async () => {
    expect(setting(await lines(MINIMAL), 'implement', 'agent')).toBe('claude-code')
    const read = await lines(
      MINIMAL.replace('steps: {}', 'steps:\n  implement:\n    - { name: write, agent: codex, prompt: SECRET-PROMPT }'),
    )
    expect(block(read, 'implement').settings).toEqual([])
    expect(block(read, 'implement').actions).toEqual([{ label: 'write', value: 'codex', code: false, when: null }])
    expect(JSON.stringify(read)).not.toContain('SECRET-PROMPT')
  })

  it('reads kinds and held by through a queue, and does not list the queue as an action', async () => {
    const read = await lines(
      MINIMAL.replace(
        'steps: {}',
        'steps:\n  claim:\n    - { name: take, queue: { kinds: [feature], exclude: [wip], backoff: 1h, assignee: { take: both } } }',
      ),
    )
    expect(setting(read, 'claim', 'kinds')).toBe('feature')
    expect(setting(read, 'claim', 'held by')).toBe('wip')
    expect(block(read, 'claim').actions).toEqual([])
  })

  it('reads the recipe-wide ceiling, not the implementation action narrowed bounds', async () => {
    const read = await lines(
      MINIMAL.replace('turns: 10, wall: 2m', 'turns: 150, wall: 1h').replace(
        'steps: {}',
        'steps:\n  implement:\n    - { name: build, agent: claude-code, prompt: go, limits: { turns: 4, wall: 1m } }',
      ),
    )
    expect(read.limits.turns).toBe('150')
    expect(read.limits.wall).toBe('1h')
  })

  it('says what the budget does at the step where it acts', async () => {
    const read = await lines(BASE)
    expect(block(read, 'implement').after).toEqual([
      { label: 'told what refused', value: 'up to 2,000 characters of output · 5 review findings' },
      { label: 'told what came before', value: 'the last 5 attempts' },
    ])
    expect(block(read, 'review').after).toEqual([])
    const reviewed = await lines(
      BASE.replace('steps:\n', 'steps:\n  review:\n    - { name: cold, agent: claude-code, prompt: look }\n'),
    )
    expect(block(reviewed, 'review').after).toEqual([
      { label: 'reads at most', value: '400,000 characters of the diff' },
    ])
  })

  it('uses singular forms for one', async () => {
    const read = await lines(
      MINIMAL.replace('runtime: {', 'runtime: { budget: { evidence: 1, findings: 1, attempts: 1, diff: 1 },'),
    )
    expect(block(read, 'implement').after.map((l) => l.value)).toEqual([
      'up to 1 character of output · 1 review finding',
      'the last attempt',
    ])
  })
})
