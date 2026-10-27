/**
 * `doc/recipe.md` offers one recipe a reader can paste, and it is held to the
 * parser here: a key renamed or a step moved turns this red rather than leaving
 * the public page describing a file the daemon would refuse.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveSource } from '../src/resolve.ts'

const page = fileURLToPath(new URL('../../../doc/recipe.md', import.meta.url))

describe('doc/recipe.md', () => {
  it('opens with a recipe that resolves, held at proposed and checked at build', async () => {
    const text = await readFile(page, 'utf8')
    const fence = /```yaml\n([\s\S]*?)```/.exec(text)
    expect(fence, 'the page has no yaml excerpt').not.toBeNull()
    const { recipe } = resolveSource(fence![1]!, 'doc/recipe.md', 'doc/recipe.md')
    expect(recipe.steps.proposed.some((a) => 'human' in a)).toBe(true)
    expect(recipe.steps.build.filter((a) => 'run' in a)).toHaveLength(2)
  })
})
