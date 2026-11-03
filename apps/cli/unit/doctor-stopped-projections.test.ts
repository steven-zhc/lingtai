/** #839. `projections: stopped` fails with the rebuild-then-restart remedy and never gates `lingtai restart`. */
import { describe, expect, it } from 'vitest'

import { stoppedProjections } from '../src/doctor.ts'
import { gatingFailures } from '../src/restart.ts'

const row = (over: Record<string, unknown>) =>
  ({
    pid: 1,
    host: 'h',
    startedAt: new Date(),
    lastSeenAt: new Date(),
    state: 'up',
    currentRunId: null,
    codeSha: null,
    codeDirty: false,
    stoppedProjections: [],
    ...over,
  }) as never

describe('projections: stopped', () => {
  it('fails once per stopped projection with the remedy, and does not gate a restart', async () => {
    const result = await stoppedProjections(async () =>
      row({ stoppedProjections: [{ name: 'spend', checkpoint: 12n, error: 'boom' }] }),
    )
    expect(result.status).toBe('fail')
    expect(result.restartAnswers).toBe(true)
    expect(result.detail).toContain(
      'spend stopped at seq 12: boom — rebuild first: lingtai projection rebuild spend, then lingtai restart',
    )
    expect(gatingFailures([result])).toBe(0)
  })

  it('is ok when nothing stopped, when no daemon is up, and when the daemon predates the field', async () => {
    expect((await stoppedProjections(async () => row({}))).status).toBe('ok')
    expect((await stoppedProjections(async () => null)).status).toBe('ok')
    expect((await stoppedProjections(async () => row({ lastSeenAt: new Date(0) }))).detail).toMatch(/no daemon/)
    const old = await stoppedProjections(async () => row({ stoppedProjections: null }))
    expect(old.status).toBe('ok')
    expect(old.detail).toMatch(/predates/)
  })

  it('fails, without restartAnswers, when the beacon cannot be read', async () => {
    const result = await stoppedProjections(async () => {
      throw new Error('no connection')
    })
    expect(result.status).toBe('fail')
    expect(result.restartAnswers).toBeUndefined()
  })
})
