/** `saveRecipeText` (#973): no filesystem — the file seam is a `Map`. */
import { describe, expect, it } from 'vitest'

import { type RecipeFiles, machinePath, recipePath, saveRecipeText } from '../src/index.ts'

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)
const GOOD = `# mine
version: 2
repo:
  base: main
source:
  kinds: [bug]   # priority
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`

function mapFiles(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial))
  const replaced: { path: string; text: string }[] = []
  const files: RecipeFiles = {
    read: async (p) => store.get(p) ?? null,
    replace: async (p, text) => {
      replaced.push({ path: p, text })
      store.set(p, text)
    },
  }
  return { files, store, replaced }
}

const options = (files: RecipeFiles) => ({
  home: HOME,
  files,
  base: 'main',
  signedIn: async () => ['claude-code' as const],
})

describe('saveRecipeText', () => {
  it('refuses a recipe that does not resolve, with the resolver’s message, and writes nothing', async () => {
    const { files, store, replaced } = mapFiles({ [PATH]: GOOD })
    const result = await saveRecipeText(
      'app',
      { loaded: GOOD, text: 'version: 2\nsteps:\n  build: nope\n' },
      options(files),
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(result.ok ? '' : result.message).toContain('steps.build: Invalid input: expected array, received string')
    expect(result.ok ? '' : result.message).toContain(PATH)
    expect(store.get(PATH)).toBe(GOOD)
    expect(replaced).toEqual([])
  })

  it('refuses when the file is not what the page loaded', async () => {
    const { files, replaced } = mapFiles({ [PATH]: GOOD + '# changed\n' })
    const result = await saveRecipeText('app', { loaded: GOOD, text: GOOD.replace('bug', 'feature') }, options(files))
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
    expect(replaced).toEqual([])
  })

  it('says missing when the file is gone', async () => {
    const { files } = mapFiles({})
    expect(await saveRecipeText('app', { loaded: GOOD, text: GOOD }, options(files))).toMatchObject({
      ok: false,
      reason: 'missing',
    })
  })

  it('writes resolvable text byte for byte, comments included, through replace alone', async () => {
    const { files, store, replaced } = mapFiles({ [PATH]: GOOD })
    const text = GOOD.replace('[bug]', '[bug, feature]')
    expect(await saveRecipeText('app', { loaded: GOOD, text }, options(files))).toEqual({
      ok: true,
      path: PATH,
      written: true,
    })
    expect(store.get(PATH)).toBe(text)
    expect(replaced).toEqual([{ path: PATH, text }])
  })

  it('writes nothing when the text is unchanged', async () => {
    const { files, replaced } = mapFiles({ [PATH]: GOOD })
    expect(await saveRecipeText('app', { loaded: GOOD, text: GOOD }, options(files))).toMatchObject({
      ok: true,
      written: false,
    })
    expect(replaced).toEqual([])
  })

  it('reads the machine file too, and refuses what it refuses', async () => {
    const { files, replaced } = mapFiles({
      [PATH]: GOOD,
      [machinePath(HOME)]: 'runtime:\n  agent: claude-code\n',
    })
    const result = await saveRecipeText('app', { loaded: GOOD, text: GOOD.replace('bug', 'feature') }, options(files))
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(replaced).toEqual([])
  })

  it('accepts a form-transported LF file whose fields arrived with CRLF, and keeps LF on disk', async () => {
    const { files, store } = mapFiles({ [PATH]: GOOD })
    const crlf = (t: string) => t.replaceAll('\n', '\r\n')
    const text = GOOD.replace('[bug]', '[bug, feature]')
    expect(await saveRecipeText('app', { loaded: crlf(GOOD), text: crlf(text) }, options(files))).toMatchObject({
      ok: true,
      written: true,
    })
    expect(store.get(PATH)).toBe(text)
  })

  it('keeps CRLF on a CRLF file', async () => {
    const crlf = (t: string) => t.replaceAll('\n', '\r\n')
    const { files, store } = mapFiles({ [PATH]: crlf(GOOD) })
    const text = GOOD.replace('[bug]', '[bug, feature]')
    await saveRecipeText('app', { loaded: GOOD, text }, options(files))
    expect(store.get(PATH)).toBe(crlf(text))
  })
})
