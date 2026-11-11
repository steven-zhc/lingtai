import { describe, expect, it } from 'vitest'

import { emptyControl } from '../src/control.ts'
import { lockSentence, locksOn } from '../src/locks.ts'
import { emptyProject } from '../src/project.ts'

describe('what holds a project', () => {
  it('nothing, when it is not paused', () => {
    expect(locksOn({ project: emptyProject })).toEqual([])
    expect(lockSentence('lingtai', [])).toBeNull()
  })

  it('one paused lock, with who and since, when it is', () => {
    const since = new Date('2026-11-10T14:20:00Z')
    const locks = locksOn({ project: { ...emptyProject, paused: { by: 'human:steven', seq: 3n, at: since } } })
    expect(locks).toEqual([{ kind: 'paused', by: 'human:steven', since }])
    expect(lockSentence('lingtai', locks)).toBe('lingtai is paused by human:steven since 2026-11-10T14:20:00.000Z')
  })
})

describe('the day ceiling as a lock', () => {
  const at = new Date('2026-11-10T14:20:00Z')
  const reached = {
    day: '2026-11-10',
    reportedUsd: 4.1,
    estimatedUsd: 0.9,
    ceilingUsd: 5,
    at,
    seq: 7,
  }
  const control = { ...emptyControl, dayCeiling: { reached, raised: null } }

  it('is a ceiling lock while reached stands, and none when it is null', () => {
    expect(locksOn({ control: emptyControl })).toEqual([])
    expect(locksOn({ control })).toMatchObject([
      { kind: 'ceiling', since: at, day: '2026-11-10', reportedUsd: 4.1, estimatedUsd: 0.9, ceilingUsd: 5 },
    ])
    expect(locksOn({ control })[0]).toMatchObject({ until: new Date(2026, 10, 11) })
  })

  it("comes before a person's pause", () => {
    const paused = { ...emptyProject, paused: { by: 'human:steven', seq: 3n, at } }
    expect(locksOn({ project: paused, control }).map((l) => l.kind)).toEqual(['ceiling', 'paused'])
  })

  it('names lingtai ceiling raise and never lingtai resume', () => {
    const sentence = lockSentence('lingtai', locksOn({ control })) ?? ''
    expect(sentence).toBe(
      'daily ceiling reached — today $4.10 reported + ~$0.90 est. of a $5.00 ceiling; lingtai ceiling raise <usd> goes on today',
    )
    expect(sentence).not.toContain('lingtai resume')
  })
})
