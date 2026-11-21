/**
 * `agent: copilot` (#1298, #1300) is legal wherever an agent or judge is, because its answer is asked for in the
 * prompt; it is refused by name only under an enabled sandbox, which the ACP runtime does not read yet.
 */
import { describe, expect, it } from 'vitest'

import { UNSANDBOXED_AGENTS, RECIPE_PATH, resolveRecipe } from '../src/index.ts'

const HEAD = `
version: 2
repo:
  base: develop
  submodules: true
source:
  kinds: [bug]
env:
  plantAt: apps/web/.env.local
`

const reader = (files: Record<string, string>) => async (path: string, ref: string) => files[`${ref}:${path}`] ?? null
const resolve = (text: string) => resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: text }), 'develop')

const SANDBOX = 'sandbox:\n  enabled: true\n'
const REVIEW =
  'steps:\n  review:\n    - name: cold\n      agent: copilot\n      prompt: go\nruntime:\n  agent: claude-code\n'
const JUDGE =
  'steps:\n  proposed:\n    - name: ask\n      judge: copilot\n      when: findings\nruntime:\n  agent: claude-code\n'
const RUNTIME = 'runtime:\n  agent: copilot\n'

describe('an agent that cannot run sandboxed', () => {
  it('is copilot', () => {
    expect(UNSANDBOXED_AGENTS).toEqual(['copilot'])
  })

  it('resolves at review', async () => {
    const { recipe } = await resolve(`${HEAD}${REVIEW}`)
    expect(recipe.steps.review[0]).toMatchObject({ agent: 'copilot' })
  })

  it('resolves as a judge and as runtime.agent', async () => {
    await expect(resolve(`${HEAD}${JUDGE}`)).resolves.toBeDefined()
    await expect(resolve(`${HEAD}${RUNTIME}`)).resolves.toBeDefined()
  })

  it.each([REVIEW, JUDGE, RUNTIME])('is refused under an enabled sandbox: %s', async (body) => {
    await expect(resolve(`${HEAD}${SANDBOX}${body}`)).rejects.toThrow(/copilot cannot run sandboxed yet/)
  })

  it('is refused at a discussion, by the discussion enum', async () => {
    await expect(resolve(`${HEAD}discuss:\n  agent: copilot\nruntime:\n  agent: claude-code\n`)).rejects.toThrow(
      /discuss\.agent/,
    )
  })
})
