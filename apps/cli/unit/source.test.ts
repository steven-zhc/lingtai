/**
 * `askTickets` and `askKinds` (#396) — the setup's two questions over #392's
 * seam, writing nothing themselves. No filesystem: the recipe file is a
 * `Map`, and no terminal: `world()` below scripts the answers the same way
 * `apps/cli/unit/landing.test.ts` does for `askLanding`.
 */
import { type RecipeFiles, recipePath } from '@lingtai/recipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { QuestionWorld } from '../src/question.ts'
import { askKinds, askTickets } from '../src/source.ts'

const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

const HOME = '/home/me/.lingtai'
const PROJECT = 'app'
const PATH = recipePath(PROJECT, HOME)

function mapFiles(initial: Record<string, string> = {}): RecipeFiles {
  const store = new Map(Object.entries(initial))
  return {
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => {
      store.set(path, text)
    },
  }
}

function world(answers: (string | null)[] = []): { world: QuestionWorld; lines: string[]; asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    lines,
    asked,
    world: {
      ask: async (prompt) => {
        asked.push(prompt)
        return queue.length > 0 ? queue.shift()! : null
      },
      log: (line) => lines.push(line),
    },
  }
}

const GITHUB_FIXTURE = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps: {}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

const DB_FIXTURE = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: [], tickets: db}
env: {required: [], plantAt: .env.local}
steps: {}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

// `source.kinds` is required (`.min(1)`, no schema default) and absent here,
// so `resolveSource` throws — the stub state `write.test.ts:184` names.
// `source.tickets: db` is still what the file says.
const UNRESOLVABLE_DB_FIXTURE = `version: 2
repo: {base: main, submodules: false}
source: {tickets: db}
env: {required: [], plantAt: .env.local}
steps: {}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

const noHistory = async () => []

describe('askTickets', () => {
  it('a GitHub project with no flags offers github, and Enter writes nothing', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w, asked } = world([''])
    const result = await askTickets(w, PROJECT, false, null, { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [] })
    expect(asked[0]).toContain('[github]')
  })

  it('a GitHub project answering db writes source.tickets', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world(['db'])
    const result = await askTickets(w, PROJECT, false, null, { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [{ path: ['source', 'tickets'], value: 'db' }] })
  })

  it('--tickets db on a GitHub project writes source.tickets without asking', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w, asked } = world()
    const result = await askTickets(w, PROJECT, false, 'db', { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [{ path: ['source', 'tickets'], value: 'db' }] })
    expect(asked).toEqual([])
  })

  it('a local project is never prompted and gets db', async () => {
    const files = mapFiles()
    const { world: w, asked } = world()
    const result = await askTickets(w, PROJECT, true, null, { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [{ path: ['source', 'tickets'], value: 'db' }] })
    expect(asked).toEqual([])
  })

  it('a local project already at db writes nothing', async () => {
    const files = mapFiles({ [PATH]: DB_FIXTURE })
    const { world: w } = world()
    const result = await askTickets(w, PROJECT, true, null, { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [] })
  })

  it('--tickets github on a local project is refused, and the refusal names the reason', async () => {
    const files = mapFiles()
    const { world: w } = world()
    const result = await askTickets(w, PROJECT, true, 'github', { home: HOME, files, history: noHistory })
    expect(result).toMatchObject({
      refused: expect.stringContaining('a project with no owner cannot take its tickets from GitHub'),
    })
  })

  it('with history, a GitHub project is not prompted, and the log line says why', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w, asked, lines } = world()
    const history = async () => ['wi-app-12']
    const result = await askTickets(w, PROJECT, false, null, { home: HOME, files, history })
    expect(result).toEqual({ changes: [] })
    expect(asked).toEqual([])
    expect(lines.some((l) => l.includes('wi-app-12') && l.includes('#381'))).toBe(true)
  })

  it('with history, a different --tickets is refused rather than switched', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world()
    const history = async () => ['wi-app-12']
    const result = await askTickets(w, PROJECT, false, 'db', { home: HOME, files, history })
    expect(result).toMatchObject({ refused: expect.stringContaining('wi-app-12') })
  })

  it('with history, a db project keeps db and writes nothing', async () => {
    const files = mapFiles({ [PATH]: DB_FIXTURE })
    const { world: w } = world()
    const history = async () => ['wi-app-3']
    const result = await askTickets(w, PROJECT, false, null, { home: HOME, files, history })
    expect(result).toEqual({ changes: [] })
  })

  it('a local project with history keeps its source rather than being written to db', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world()
    const history = async () => ['wi-app-9']
    const result = await askTickets(w, PROJECT, true, null, { home: HOME, files, history })
    expect(result).toEqual({ changes: [] })
  })

  it('a file that does not resolve on its own still has its source.tickets read, not defaulted to github', async () => {
    const files = mapFiles({ [PATH]: UNRESOLVABLE_DB_FIXTURE })
    const { world: w } = world()
    // --tickets github against a file that actually says db is a real
    // switch, and must be written — not silently matched against a wrongly
    // computed "current: github" and treated as already applied.
    const result = await askTickets(w, PROJECT, false, 'github', { home: HOME, files, history: noHistory })
    expect(result).toEqual({ changes: [{ path: ['source', 'tickets'], value: 'github' }] })
  })

  it('a file that does not resolve on its own offers its actual source.tickets as the default, not github', async () => {
    const files = mapFiles({ [PATH]: UNRESOLVABLE_DB_FIXTURE })
    const { world: w, asked } = world([''])
    const result = await askTickets(w, PROJECT, false, null, { home: HOME, files, history: noHistory })
    expect(asked[0]).toContain('[db]')
    expect(result).toEqual({ changes: [] })
  })
})

describe('askKinds', () => {
  it('the default with no file is bug, feature, documentation', async () => {
    const files = mapFiles()
    const { world: w, asked } = world([''])
    const result = await askKinds(w, PROJECT, null, { home: HOME, files })
    expect(asked[0]).toContain('[bug, feature, documentation]')
    expect(result).toEqual({ changes: [{ path: ['source', 'kinds'], value: ['bug', 'feature', 'documentation'] }] })
  })

  it('--kinds feature,bug is written as [feature, bug]', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w, asked } = world()
    const result = await askKinds(w, PROJECT, 'feature,bug', { home: HOME, files })
    expect(asked).toEqual([])
    expect(result).toEqual({ changes: [{ path: ['source', 'kinds'], value: ['feature', 'bug'] }] })
  })

  it('pressing enter on the existing kinds writes nothing', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w, asked } = world([''])
    const result = await askKinds(w, PROJECT, null, { home: HOME, files })
    expect(asked[0]).toContain('[bug]')
    expect(result).toEqual({ changes: [] })
  })

  it('an empty list is refused and asked again', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world([' , ', 'bug'])
    const result = await askKinds(w, PROJECT, null, { home: HOME, files })
    expect(result).toEqual({ changes: [] })
  })

  it('a repeated label is refused by name', async () => {
    const result = await askKinds(world().world, PROJECT, 'bug,bug', { home: HOME, files: mapFiles() })
    expect(result).toMatchObject({ refused: expect.stringContaining('named twice') })
  })
})

describe('kept — neither question claims "Nothing was written" once a caller has already written', () => {
  it('askTickets refuses with the caller-supplied kept, not the default', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world([null])
    const result = await askTickets(w, PROJECT, false, null, {
      home: HOME,
      files,
      history: noHistory,
      kept: 'the writer and reviewer chosen above are kept',
    })
    expect(result).toMatchObject({ refused: expect.stringContaining('the writer and reviewer chosen above are kept') })
    expect(result).not.toMatchObject({ refused: expect.stringContaining('Nothing was written') })
  })

  it("askTickets' local no-owner refusal carries the caller-supplied kept", async () => {
    const files = mapFiles()
    const { world: w } = world()
    const result = await askTickets(w, PROJECT, true, 'github', {
      home: HOME,
      files,
      history: noHistory,
      kept: 'the store chosen above is kept',
    })
    expect(result).toMatchObject({ refused: expect.stringContaining('the store chosen above is kept') })
  })

  it('askKinds refuses with the caller-supplied kept, not the default', async () => {
    const files = mapFiles({ [PATH]: GITHUB_FIXTURE })
    const { world: w } = world([null])
    const result = await askKinds(w, PROJECT, null, {
      home: HOME,
      files,
      kept: 'the ticket source chosen above is kept',
    })
    expect(result).toMatchObject({ refused: expect.stringContaining('the ticket source chosen above is kept') })
    expect(result).not.toMatchObject({ refused: expect.stringContaining('Nothing was written') })
  })
})
