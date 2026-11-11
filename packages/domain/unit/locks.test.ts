import { describe, expect, it } from 'vitest'

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
