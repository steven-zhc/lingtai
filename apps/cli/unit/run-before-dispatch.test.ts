/**
 * `lingtai run` states the runtime and the pass ceiling before it claims
 * anything (`#348`).
 *
 * `statedBeforeDispatch` is pure, and that is the point: `run()` has no seam
 * to drive to its first dispatch under the unit half (0060 §1) —
 * `hasGitHubApp` reads `~/.lingtai/config.yml`, `loadProject` reads the log,
 * `createGitHubClient` reaches the network, and the runtime a step names is
 * built inline rather than through an injectable factory. So this holds the
 * two claims the checkboxes ask for: what the lines say, built off a recipe
 * resolved through the recipe package's own path rather than a hand-written
 * object, and where the call sits in `run.ts`'s own source — the same
 * technique `unit/run-pause.test.ts` already uses on `lingtai.ts`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { repoRoot } from '@lingtai/env'
import { resolveRecipe, type ResolvedRecipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { statedBeforeDispatch } from '../src/run.ts'

async function recipeFrom(yaml: string): Promise<ResolvedRecipe> {
  return resolveRecipe(async () => yaml, 'main')
}

const COMMON = `
version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
`

const ONLY_IMPLEMENT = `${COMMON}
steps:
  implement:
    - name: write it
      agent: claude-code
      prompt: go
`

const DESIGN_AND_REVIEW = `${COMMON}
steps:
  design:
    - name: shape it
      agent: claude-code
      prompt: shape
  implement:
    - name: write it
      agent: claude-code
      prompt: go
  review:
    - name: cold review
      agent: claude-code
      prompt: read
`

const RUNTIME_JUDGE_AT_PROPOSED = `${COMMON}
steps:
  implement:
    - name: write it
      agent: claude-code
      prompt: go
  proposed:
    - name: route it
      judge: claude-code
      when: findings
`

describe('statedBeforeDispatch', () => {
  it('names the runtime, the account and the pass ceiling, with no further-runs line when nothing besides implement dispatches', async () => {
    const resolved = await recipeFrom(ONLY_IMPLEMENT)
    const lines = statedBeforeDispatch(resolved.recipe)

    expect(lines[0]).toContain('runtime: claude-code')
    expect(lines[0]).toContain('signed in to on this machine')
    // `passCeiling`'s own sentence, verbatim — `runtime.limits` defaults to
    // `rounds: 2, restarts: 0`, so this is its "rounds are spent" form.
    expect(lines[1]).toContain('up to 3 agent runs')
    expect(lines[1]).toContain('A pass whose rounds are spent goes to you')

    // Nothing besides `implement` dispatches, so no further-runs line at all.
    expect(lines.some((l) => l.includes('not in that sentence'))).toBe(false)
    expect(lines.some((l) => l.includes('runtime judge'))).toBe(false)
  })

  it('says design and review are further agent runs, not counted in the ceiling sentence', async () => {
    const resolved = await recipeFrom(DESIGN_AND_REVIEW)
    const lines = statedBeforeDispatch(resolved.recipe)
    const said = lines.join('\n')

    expect(said).toContain('not in that sentence: an agent run at design, review')
    expect(said).toContain('each its own run on the same account')
  })

  it('words a runtime judge with "may", since it only runs when its `when:` matches', async () => {
    const resolved = await recipeFrom(RUNTIME_JUDGE_AT_PROPOSED)
    const lines = statedBeforeDispatch(resolved.recipe)
    const said = lines.join('\n')

    expect(said).toContain('a runtime judge at proposed may run')
    expect(said).not.toContain('not in that sentence: an agent run at proposed')
  })

  it("does not change `passCeiling`'s own output", async () => {
    const resolved = await recipeFrom(ONLY_IMPLEMENT)
    const lines = statedBeforeDispatch(resolved.recipe)
    // `0070 §8`'s rule: empty is today's string, character for character.
    // What `lingtai add` prints for the same recipe, minus its leading label.
    expect(lines[1]).toBe(
      'a pass up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. ' +
        '2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)',
    )
  })
})

describe('where `run.ts` calls it', () => {
  it('states it before both the queue and the nominated-issue branches dispatch', async () => {
    const source = await readFile(join(repoRoot(), 'apps/cli/src/run.ts'), 'utf8')
    // The call site, not the declaration above it — `statedBeforeDispatch(` on
    // its own would match the `export function` line, which precedes
    // everything in the file and would prove nothing about the call's place.
    const stated = source.indexOf('statedBeforeDispatch(resolved.recipe)')
    const queue = source.indexOf('runQueue(')
    const once = source.indexOf('runOnce(')

    expect(stated).toBeGreaterThan(-1)
    expect(queue).toBeGreaterThan(-1)
    expect(once).toBeGreaterThan(-1)
    expect(stated).toBeLessThan(queue)
    expect(stated).toBeLessThan(once)
  })
})
