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
const value = (read: Awaited<ReturnType<typeof lines>>, label: string) =>
  read.lines.find((l) => l.label === label)?.value

describe('recipeLines', () => {
  it('reads each line from the resolved recipe', async () => {
    const read = await lines(BASE)
    expect(read.lines.map((l) => l.label)).toEqual([
      'base',
      'install',
      'checks',
      'agent',
      'reviewer',
      'tickets',
      'kinds',
      'held by',
      'end',
    ])
    expect(value(read, 'base')).toBe('main')
    expect(value(read, 'install')).toBe('pnpm install')
    expect(value(read, 'checks')).toBe('pnpm test, pnpm lint')
    expect(value(read, 'agent')).toBe('claude-code')
    expect(value(read, 'kinds')).toBe('bug, tech-debt')
    expect(value(read, 'held by')).toBe('blocked, agent:hold')
    expect(read.limits.turns).toBe('unbounded')
    expect(read.ceiling).not.toBe('')
  })

  it('reads the empty ones in words, an absent source.tickets as github, and No for the merge', async () => {
    const read = await lines(MINIMAL)
    expect(value(read, 'install')).toBe('nothing')
    expect(value(read, 'checks')).toBe('nothing')
    expect(value(read, 'reviewer')).toBe('none')
    expect(value(read, 'tickets')).toBe('github')
    expect(value(read, 'held by')).toBe('nothing')
    expect(value(read, 'end')).toBe('nothing')
    expect(read.approves).toBe('No')
    expect(read.limits.turns).toBe('10')
  })

  it('reads Yes where a human action sits at proposed', async () => {
    const read = await lines(
      MINIMAL.replace('steps: {}', 'steps:\n  proposed:\n    - { name: person, human: Land this?  }'),
    )
    expect(read.approves).toBe('Yes')
  })

  it('reads kinds and held by through a queue at claim', async () => {
    const read = await lines(
      MINIMAL.replace(
        'steps: {}',
        'steps:\n  claim:\n    - { name: take, queue: { kinds: [feature], exclude: [wip], backoff: 1h, assignee: { take: both } } }',
      ),
    )
    expect(value(read, 'kinds')).toBe('feature')
    expect(value(read, 'held by')).toBe('wip')
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
})
