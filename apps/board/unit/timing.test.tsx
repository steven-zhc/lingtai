import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

import { TimingMeta } from '../src/lib/timing-meta.tsx'
import { measure, serverTiming, timed } from '../src/lib/timing.ts'

const clock = (...ticks: number[]) => {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]!
}

it('lists the reads in start order with the exact differences the clock gave', async () => {
  // measure began 0; events.task 0→8; github.issue 10→733; measure ended 740
  const now = clock(0, 0, 8, 10, 733, 740)
  const [value, timings] = await measure(
    async () => {
      await timed('events.task', async () => 1)
      return timed('github.issue', async () => 'x')
    },
    { now },
  )
  expect(value).toBe('x')
  expect(serverTiming(timings)).toBe('events.task;dur=8, github.issue;dur=723')
  expect(renderToStaticMarkup(<TimingMeta timings={timings} />)).toBe(
    '<meta name="lingtai-timing" content="events.task;dur=8, github.issue;dur=723"/>',
  )
})

it('returns the value, rethrows the same error, records nothing outside a measure', async () => {
  await expect(timed('a', async () => 5)).resolves.toBe(5)
  const boom = new Error('boom')
  await expect(
    timed('a', async () => {
      throw boom
    }),
  ).rejects.toBe(boom)
  const [, timings] = await measure(
    async () => {
      await timed('bad', async () => 1, { failed: () => true })
      await timed('many', async () => 1, { desc: '2' })
      await timed('both', async () => 1, { desc: '2', failed: () => true })
    },
    { now: clock(0, 0, 1, 1, 2, 2, 3, 3, 4, 4) },
  )
  expect(serverTiming(timings)).toBe('bad;dur=1;desc="failed", many;dur=1;desc="2", both;dur=1;desc="failed"')
})

it('lets only the name and `failed` out of a failed read', async () => {
  const say = vi.fn()
  const [, timings] = await measure(
    async () => {
      await timed('github.issue', async () => {
        throw new Error('request to https://x?token=y failed')
      }).catch(() => undefined)
    },
    { now: clock(0, 0, 5000, 5000), say },
  )
  const tag = renderToStaticMarkup(<TimingMeta timings={timings} />)
  const line = String(say.mock.calls[0]?.[0])
  for (const text of [tag, line]) {
    expect(text).not.toMatch(/https:|token|request to/)
  }
  expect(tag).toContain('github.issue;dur=5000;desc=&quot;failed&quot;')
})

it('says one line naming the three slowest reads when over slowMs, and nothing under it', async () => {
  const say = vi.fn()
  // total 1420; reads a 0→10, b 10→733, c 733→943, d 943→1000
  await measure(
    async () => {
      await timed('a', async () => 0)
      await timed('b', async () => 0)
      await timed('c', async () => 0)
      await timed('d', async () => 0)
    },
    { now: clock(0, 0, 10, 10, 733, 733, 943, 943, 1000, 1420), say, label: '/task' },
  )
  expect(say).toHaveBeenCalledOnce()
  expect(say).toHaveBeenCalledWith('board: /task took 1420ms — b 723ms, c 210ms, d 57ms')

  const quiet = vi.fn()
  await measure(async () => 1, { now: clock(0, 999), say: quiet })
  expect(quiet).not.toHaveBeenCalled()
})

it('prints the slow line and rethrows the same error when the page fails', async () => {
  const say = vi.fn()
  const boom = new Error('x')
  await expect(
    measure(
      async () => {
        throw boom
      },
      { now: clock(0, 2000), say },
    ),
  ).rejects.toBe(boom)
  expect(say).toHaveBeenCalledWith('board: / took 2000ms')
})
