/** What Ctrl+C at a setup question says (#762): what is kept, how to go on, and how to start over. */
import { describe, expect, it } from 'vitest'

import { initKept } from '../src/init.ts'
import { stoppedAtQuestion } from '../src/prompt.ts'
import { question, type AskShape } from '../src/question.ts'

const none = async () => []

describe('stoppedAtQuestion', () => {
  it('names kept, the command and the start-over sentence', () => {
    const line = stoppedAtQuestion({
      kept: 'the store is kept',
      startOver: 'to start over, delete x',
      command: 'lingtai init',
    })
    expect(line).toBe(
      'stopped at the question — the store is kept. lingtai init again continues from here. to start over, delete x.',
    )
  })

  it('has no start-over sentence without one, and falls back on the command', () => {
    const line = stoppedAtQuestion({ kept: 'Nothing was written' })
    expect(line).toBe('stopped at the question — Nothing was written. running the command again continues from here.')
  })
})

describe('question hands the shape on', () => {
  it('passes kept, startOver and command to ask, and keeps startOver out of the refusal', async () => {
    const shapes: (AskShape | undefined)[] = []
    const result = await question(
      {
        ask: async (_p, shape) => {
          shapes.push(shape)
          return null
        },
        log: () => {},
      },
      {
        name: 'the store',
        flag: '--store',
        given: null,
        prompt: 'p',
        kept: 'K',
        startOver: 'SO',
        command: 'lingtai init',
      },
    )
    expect(shapes[0]).toMatchObject({ kept: 'K', startOver: 'SO', command: 'lingtai init' })
    expect(result).toEqual({ refused: expect.stringContaining('K') })
    expect(JSON.stringify(result)).not.toContain('SO')
  })
})

describe('initKept', () => {
  const sqlite = { store: 'sqlite', path: '/h/lingtai.db', where: 'config.yml', from: '/h/config.yml' } as const
  const pg = {
    store: 'postgres',
    url: 'postgres://u:secret@h/db',
    directUrl: 'postgres://u:secret@h/db',
    where: 'config.yml',
    from: '/h/config.yml',
  } as const

  it('names both files of a fresh SQLite home', async () => {
    const r = await initKept({
      choice: sqlite,
      configPath: '/h/config.yml',
      startedWithConfig: false,
      wrote: true,
      sidecars: none,
    })
    expect(r.kept).toBe('the store is kept, SQLite at /h/lingtai.db, chosen in /h/config.yml')
    expect(r.startOver).toBe('to start over, delete those two files')
  })

  it('mentions -wal and -shm when they exist', async () => {
    const r = await initKept({
      choice: sqlite,
      configPath: '/h/config.yml',
      startedWithConfig: false,
      wrote: true,
      sidecars: async () => ['/h/lingtai.db-wal'],
    })
    expect(r.startOver).toContain('-wal and -shm')
  })

  it('never prints the Postgres URL', async () => {
    const r = await initKept({
      choice: pg,
      configPath: '/h/config.yml',
      startedWithConfig: false,
      wrote: true,
      sidecars: none,
    })
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(r.startOver).toBe('to start over, delete that file')
  })

  it('has no start-over when nothing was written', async () => {
    const r = await initKept({
      choice: { ...pg, where: 'environment', from: 'LINGTAI_DATABASE_URL' },
      configPath: '/h/config.yml',
      startedWithConfig: false,
      wrote: false,
      sidecars: none,
    })
    expect(r.startOver).toBeUndefined()
  })

  it('has no start-over on a home that already had a config.yml', async () => {
    const r = await initKept({
      choice: sqlite,
      configPath: '/h/config.yml',
      startedWithConfig: true,
      wrote: false,
      sidecars: none,
    })
    expect(r).toEqual({ kept: "this machine's store and projects are unchanged" })
  })
})
