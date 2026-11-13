import { afterEach, expect, it, vi } from 'vitest'

import { setAcquireObserver } from '../src/acquire.ts'
import { queryRows, type QueryPool } from '../src/postgres.ts'

afterEach(() => setAcquireObserver(undefined))

const poolOf = (query: (text: string) => Promise<{ rows: unknown[] }>) => {
  const release = vi.fn()
  const pool = {
    query: vi.fn(),
    connect: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { query, release }
    }),
  }
  return { pool: pool as unknown as QueryPool, release, raw: pool }
}

it('with no observer a read is pool.query and takes no connection itself', async () => {
  const { pool, raw } = poolOf(async () => ({ rows: [] }))
  raw.query.mockResolvedValue({ rows: [{ a: 1 }] })
  expect(await queryRows(pool, 'select 1')).toEqual([{ a: 1 }])
  expect(raw.connect).not.toHaveBeenCalled()
})

it('with one, the checkout is measured apart from the query and the client goes back', async () => {
  const seen: string[] = []
  setAcquireObserver(async (run) => {
    const start = performance.now()
    const client = await run()
    seen.push(`acquire>=15:${performance.now() - start >= 15}`)
    return client
  })
  const { pool, release } = poolOf(async () => {
    seen.push('query')
    return { rows: [{ a: 1 }] }
  })
  expect(await queryRows(pool, 'select 1')).toEqual([{ a: 1 }])
  expect(seen).toEqual(['acquire>=15:true', 'query'])
  expect(release).toHaveBeenCalledWith()
})

it('a driver error discards the client and still rejects as itself', async () => {
  setAcquireObserver((run) => run())
  const err = Object.assign(new Error('boom'), { code: '42P01' })
  const { pool, release } = poolOf(async () => {
    throw err
  })
  await expect(queryRows(pool, 'select 1')).rejects.toBe(err)
  expect(release).toHaveBeenCalledWith(err)
})
