/**
 * `askFirstProject` and `waitForApp` (#393), against the narrow worlds each
 * declares — no filesystem, so these are `unit/` by 0060 §1, unlike
 * `initCommand` itself (`integration/init.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_WAIT_MS, type AppWaitWorld, askFirstProject, waitForApp } from '../src/github-app.ts'
import type { QuestionWorld } from '../src/question.ts'

// Same reason as `question.test.ts`: the assertions below read `paint`'s
// output as bare strings, and `NO_COLOR` wins ahead of `FORCE_COLOR`.
const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

function questionWorld(answers: (string | null)[] = []): { world: QuestionWorld; asked: string[] } {
  const queue = [...answers]
  const asked: string[] = []
  return {
    asked,
    world: {
      ask: async (prompt) => {
        asked.push(prompt)
        return queue.length > 0 ? queue.shift()! : null
      },
      log: () => {},
    },
  }
}

describe('askFirstProject (#393)', () => {
  it('--project local returns local, asking nothing further', async () => {
    const { world, asked } = questionWorld()
    const result = await askFirstProject(world, { project: 'local' })
    expect(result).toEqual({ project: 'local' })
    expect(asked).toEqual([])
  })

  it('--project github --github-app skip returns both, asking nothing', async () => {
    const { world, asked } = questionWorld()
    const result = await askFirstProject(world, { project: 'github', 'github-app': 'skip' })
    expect(result).toEqual({ project: 'github', app: 'skip' })
    expect(asked).toEqual([])
  })

  it('--project local --github-app create is refused rather than silently discarding --github-app (#393)', async () => {
    const { world, asked } = questionWorld()
    const result = await askFirstProject(world, { project: 'local', 'github-app': 'create' })
    expect(result).toEqual({
      refused:
        '--github-app create, but --project local creates no GitHub App. Leave out --github-app, or pass ' +
        '--project github. the store chosen above is kept',
    })
    expect(asked).toEqual([])
  })

  it('at a terminal, an empty answer to the kind falls back to github and then asks the App question', async () => {
    const { world } = questionWorld(['', 'skip'])
    const result = await askFirstProject(world, {})
    expect(result).toEqual({ project: 'github', app: 'skip' })
  })

  it('with no TTY and no flag, the project question refuses by naming its own flag, and keeps the store rather than claiming nothing was written', async () => {
    const { world } = questionWorld([])
    const result = await askFirstProject(world, {})
    expect(result).toEqual({
      refused: 'the project needs an answer: pass --project github, or --project local. the store chosen above is kept',
    })
  })

  it('with no TTY and no flag, once github is given, the App question refuses by naming its own flag', async () => {
    const { world } = questionWorld(['github'])
    const result = await askFirstProject(world, {})
    expect(result).toEqual({
      refused:
        'the GitHub App needs an answer: pass --github-app create, or --github-app skip. the store chosen above is kept',
    })
  })
})

function appWaitWorld(opts: { appeared?: Promise<{ slug: string; owner: string }>; pressed?: Promise<void> }): {
  world: AppWaitWorld
  lines: string[]
  opened: string[]
  aborted: { appeared: boolean; pressed: boolean }
} {
  const lines: string[] = []
  const opened: string[] = []
  const aborted = { appeared: false, pressed: false }
  return {
    lines,
    opened,
    aborted,
    world: {
      log: (line) => lines.push(line),
      open: async (url) => {
        opened.push(url)
        return true
      },
      appeared: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => (aborted.appeared = true), { once: true })
          opts.appeared?.then(resolve)
        }),
      pressed: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted.pressed = true
            resolve()
          })
          opts.pressed?.then(() => resolve())
        }),
    },
  }
}

describe('waitForApp (#393)', () => {
  it('an appeared that never resolves ends at the timeout, with the come-back line, and aborts it', async () => {
    const { world, lines, opened, aborted } = appWaitWorld({})
    const result = await waitForApp(world, 'http://127.0.0.1:3200', { waitMs: 20 })
    expect(result).toEqual({ timedOut: true })
    expect(aborted.appeared).toBe(true)
    expect(aborted.pressed).toBe(true)
    expect(opened).toEqual(['http://127.0.0.1:3200/setup/github-app'])
    const comeBack = lines.filter((l) => l.includes('not created'))
    expect(comeBack).toHaveLength(1)
    expect(comeBack[0]).toContain('create it at http://127.0.0.1:3200/setup/github-app')
    expect(comeBack[0]).toContain('run lingtai init again')
  })

  it('a pressed that resolves at once returns skipped, at once, with the same line', async () => {
    const { world, lines } = appWaitWorld({ pressed: Promise.resolve() })
    const result = await waitForApp(world, 'http://127.0.0.1:3200', { waitMs: APP_WAIT_MS })
    expect(result).toEqual({ skipped: true })
    expect(lines.some((l) => l.includes('not created (skipped)'))).toBe(true)
  })

  it('appeared resolving first reports what it made, and never the come-back line', async () => {
    const { world, lines } = appWaitWorld({ appeared: Promise.resolve({ slug: 'lingtai-me', owner: 'me' }) })
    const result = await waitForApp(world, 'http://127.0.0.1:3200', { waitMs: 5000 })
    expect(result).toEqual({ made: { slug: 'lingtai-me', owner: 'me' } })
    expect(lines.some((l) => l.includes('lingtai-me, owned by me'))).toBe(true)
    expect(lines.some((l) => l.includes('not created'))).toBe(false)
  })
})
