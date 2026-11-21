/**
 * `agent: copilot` (#1298) is legal at `implement` and refused by name everywhere else:
 * an ACP agent takes no output schema, so review, a judge and triage cannot run on it yet,
 * and it is not sandboxed yet.
 */
import { describe, expect, it } from 'vitest'

import { IMPLEMENT_ONLY_AGENTS, RECIPE_PATH, resolveRecipe } from '../src/index.ts'

const HEAD = `
version: 2
branch:
  main: develop
repo:
  submodules: true
source:
  kinds: [bug]
env:
  plantAt: apps/web/.env.local
`

const reader = (files: Record<string, string>) => async (path: string, ref: string) => files[`${ref}:${path}`] ?? null
const resolve = (text: string) => resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: text }), 'develop')

describe('an agent that runs only at implement', () => {
  it('is copilot and antigravity', () => {
    expect(IMPLEMENT_ONLY_AGENTS).toEqual(['copilot', 'antigravity'])
  })

  it('resolves as the agent at implement', async () => {
    const { recipe } = await resolve(
      `${HEAD}steps:\n  implement:\n    - name: build\n      agent: copilot\n      prompt: go\nruntime:\n  agent: claude-code\n`,
    )
    expect(recipe.steps.implement[0]).toMatchObject({ agent: 'copilot' })
  })

  it('is refused at review, by name', async () => {
    await expect(
      resolve(
        `${HEAD}steps:\n  review:\n    - name: cold\n      agent: copilot\n      prompt: go\nruntime:\n  agent: claude-code\n`,
      ),
    ).rejects.toThrow(/steps\.review.*copilot.*only as the `agent:` at `implement`/s)
  })

  it('is refused as runtime.agent, by name', async () => {
    await expect(resolve(`${HEAD}runtime:\n  agent: copilot\n`)).rejects.toThrow(/runtime\.agent names `copilot`/)
  })

  it('is refused as a judge, by name', async () => {
    await expect(
      resolve(
        `${HEAD}steps:\n  proposed:\n    - name: ask\n      judge: copilot\n      when: findings\nruntime:\n  agent: claude-code\n`,
      ),
    ).rejects.toThrow(/judge: copilot/)
  })

  it('resolves under an enabled sandbox (#1301)', async () => {
    await expect(
      resolve(
        `${HEAD}sandbox:\n  enabled: true\nsteps:\n  implement:\n    - name: build\n      agent: copilot\n      prompt: go\nruntime:\n  agent: claude-code\n`,
      ),
    ).resolves.toBeDefined()
  })

  it('is refused at a discussion, by the discussion enum', async () => {
    await expect(resolve(`${HEAD}discuss:\n  agent: copilot\nruntime:\n  agent: claude-code\n`)).rejects.toThrow(
      /discuss\.agent/,
    )
  })

  const antigravity = (sandbox: string) =>
    `${HEAD}${sandbox}steps:\n  implement:\n    - name: build\n      agent: antigravity\n      prompt: go\nruntime:\n  agent: claude-code\n`

  it('antigravity is refused where the sandbox is required, by name', async () => {
    await expect(resolve(antigravity('sandbox:\n  enabled: true\n  required: true\n'))).rejects.toThrow(
      /antigravity cannot run sandboxed in this release — set `sandbox.required: false`, or name another agent/,
    )
  })

  it('antigravity resolves under a sandbox that is on and not required', async () => {
    const { recipe } = await resolve(antigravity('sandbox:\n  enabled: true\n  required: false\n'))
    expect(recipe.steps.implement[0]).toMatchObject({ agent: 'antigravity' })
  })
})
