/** `selectRunnableEffect`'s rules over the narrow state read (#1440), with the read stubbed. */
import { Effect, Exit } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { issue: string; state: string; lastAttemptAt: Date | null; repairPending: boolean }
const stub = vi.hoisted(() => ({
  calls: [] as { project: string; issues: readonly string[] }[],
  answer: (): unknown => undefined,
}))

vi.mock('@lingtai/projector', () => ({
  readTaskStatesEffect: (q: { project: string; issues: readonly string[] }) => {
    stub.calls.push(q)
    return stub.answer()
  },
}))

const { selectRunnableEffect } = await import('../src/queue.ts')

const NOW = new Date('2026-11-25T12:00:00.000Z')
const HOUR = 3_600_000
const row = (issue: string, over: Partial<Row> = {}): Row => ({
  issue,
  state: 'queued',
  lastAttemptAt: null,
  repairPending: false,
  ...over,
})
const rowsOf = (rows: Row[]) => {
  stub.answer = () => Effect.succeed(rows)
}
const offer = (ref: string, kind = 'bug') => ({ ref, title: `t${ref}`, kind })
const select = (offered: ReturnType<typeof offer>[]) =>
  Effect.runPromise(
    selectRunnableEffect({ project: 'p', offered, kinds: ['bug'], mode: 'solo', backoffMs: HOUR, now: NOW }),
  )

beforeEach(() => {
  stub.calls = []
  rowsOf([])
})

describe('selectRunnableEffect over the narrow read', () => {
  it('takes an issue with no row', async () => {
    expect((await select([offer('1')])).map((r) => r.issue)).toEqual(['1'])
  })

  it.each(['running', 'waiting', 'blocked', 'closed', 'landed', 'done'])('leaves out a %s row', async (state) => {
    rowsOf([row('1', { state })])
    expect(await select([offer('1')])).toEqual([])
  })

  it('holds a queued row inside the backoff, frees it outside, and frees it exactly at the boundary', async () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms)
    rowsOf([
      row('1', { lastAttemptAt: at(HOUR - 1) }),
      row('2', { lastAttemptAt: at(HOUR + 1) }),
      row('3', { lastAttemptAt: at(HOUR) }),
    ])
    expect((await select([offer('1'), offer('2'), offer('3')])).map((r) => r.issue)).toEqual(['2', '3'])
  })

  it('takes a queued row with a repair pending even inside the backoff', async () => {
    rowsOf([row('1', { lastAttemptAt: NOW, repairPending: true })])
    expect((await select([offer('1')])).map((r) => r.issue)).toEqual(['1'])
  })

  it('keeps duplicate offers, and asks for each ref once, kind-filtered', async () => {
    const out = await select([offer('2'), offer('2'), offer('3', 'enhancement'), offer('1')])
    expect(out.map((r) => r.issue)).toEqual(['1', '2', '2'])
    expect(stub.calls).toEqual([{ project: 'p', issues: ['2', '1'] }])
  })

  it('passes the project to the read', async () => {
    await select([offer('1')])
    expect(stub.calls[0]?.project).toBe('p')
  })

  it('does not read when nothing is offered or nothing is a runnable kind', async () => {
    await select([])
    await select([offer('1', 'enhancement')])
    expect(stub.calls.every((c) => c.issues.length === 0)).toBe(true)
  })

  it.each([
    ['a defect', (e: Error) => Effect.die(e)],
    ['a failure', (e: Error) => Effect.fail(e)],
  ])('does not succeed when the read is %s', async (_name, make) => {
    const err = new Error('db down')
    stub.answer = () => make(err)
    const exit = await Effect.runPromiseExit(
      selectRunnableEffect({
        project: 'p',
        offered: [offer('1')],
        kinds: ['bug'],
        mode: 'solo',
        backoffMs: HOUR,
        now: NOW,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit, (_k, v) => (v instanceof Error ? v.message : v))).toContain('db down')
  })
})
