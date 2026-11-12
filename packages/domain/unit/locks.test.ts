import { describe, expect, it } from 'vitest'

import { type AccountState, emptyAccount } from '../src/account.ts'
import { emptyControl } from '../src/control.ts'
import { NO_ACCOUNTS, lockSentence, locksOn } from '../src/locks.ts'
import { emptyProject } from '../src/project.ts'

describe('what holds a project', () => {
  it('nothing, when it is not paused', () => {
    expect(locksOn({ project: emptyProject, accounts: NO_ACCOUNTS })).toEqual([])
    expect(lockSentence('lingtai', [])).toBeNull()
  })

  it('one paused lock, with who and since, when it is', () => {
    const since = new Date('2026-11-10T14:20:00Z')
    const locks = locksOn({
      project: { ...emptyProject, paused: { by: 'human:steven', seq: 3n, at: since } },
      accounts: NO_ACCOUNTS,
    })
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
    expect(locksOn({ control: emptyControl, accounts: NO_ACCOUNTS })).toEqual([])
    expect(locksOn({ control, accounts: NO_ACCOUNTS })).toMatchObject([
      { kind: 'ceiling', since: at, day: '2026-11-10', reportedUsd: 4.1, estimatedUsd: 0.9, ceilingUsd: 5 },
    ])
    expect(locksOn({ control, accounts: NO_ACCOUNTS })[0]).toMatchObject({ until: new Date(2026, 10, 11) })
  })

  it("comes before a person's pause", () => {
    const paused = { ...emptyProject, paused: { by: 'human:steven', seq: 3n, at } }
    expect(locksOn({ project: paused, control, accounts: NO_ACCOUNTS }).map((l) => l.kind)).toEqual([
      'ceiling',
      'paused',
    ])
  })

  it('names lingtai ceiling raise and never lingtai resume', () => {
    const sentence = lockSentence('lingtai', locksOn({ control, accounts: NO_ACCOUNTS })) ?? ''
    expect(sentence).toBe(
      'daily ceiling reached — today $4.10 reported + ~$0.90 est. of a $5.00 ceiling; lingtai ceiling raise <usd> goes on today',
    )
    expect(sentence).not.toContain('lingtai resume')
  })

  describe('an account limit', () => {
    const limited = (untilFrom: 'message' | 'message-latest' | 'backoff' | 'backoff-unreadable'): AccountState => ({
      ...emptyAccount,
      runtime: 'claude-code',
      limit: {
        until: new Date(2026, 10, 11, 23, 0),
        untilFrom,
        said: 'limit',
        since: new Date(2026, 10, 11, 18, 2),
        seq: 1n,
      },
    })
    const now = new Date(2026, 10, 11, 20, 0)

    it('is no lock for an unlimited account, one per limited account, and none for an absent runtime', () => {
      expect(locksOn({ accounts: new Map([['claude-code', emptyAccount]]) })).toEqual([])
      expect(locksOn({ accounts: new Map([['claude-code', limited('message')]]) }).map((l) => l.kind)).toEqual([
        'account',
      ])
      expect(locksOn({ accounts: NO_ACCOUNTS })).toEqual([])
    })

    it('is still a lock once its until has passed: lifting it is the guard’s', () => {
      expect(locksOn({ accounts: new Map([['claude-code', limited('message')]]) })).toHaveLength(1)
    })

    it('names the runtime, until, and where until came from', () => {
      const words = {
        message: 'read from its message',
        'message-latest': 'the latest its message could mean',
        backoff: "its message named no time; the recipe's backoff",
        'backoff-unreadable': "its message named a time this build could not read; the recipe's backoff",
      } as const
      for (const [from, text] of Object.entries(words)) {
        const locks = locksOn({
          accounts: new Map([['claude-code', limited(from as keyof typeof words)]]),
        })
        expect(lockSentence('p', locks, now)).toBe(
          `lingtai waits for claude-code's usage limit until 23:00 (${text}) — lingtai account lift claude-code once it is over`,
        )
      }
    })

    it('gives the date when until is not today', () => {
      const locks = locksOn({ accounts: new Map([['claude-code', limited('message')]]) })
      expect(lockSentence('p', locks, new Date(2026, 10, 12, 1, 0))).toContain('until 2026-11-11 23:00')
    })
  })
})
