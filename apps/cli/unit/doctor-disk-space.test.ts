import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { CleanItem, CleanListing } from '../src/clean.ts'
import { diskSpaceRow, freeBytes } from '../src/doctor.ts'

const MB = 1024
const GB = 1024 * 1024 * 1024
const orphan = (sizeKb: number | null): CleanItem => ({
  kind: 'worktree',
  project: 'p',
  name: 'w',
  path: '/h/worktrees/p/w',
  verdict: { verdict: 'remove', reason: 'abandoned' } as CleanItem['verdict'],
  sizeKb,
})
const listing = (...items: CleanItem[]): CleanListing => ({ items, unreadable: [] })
const lots = { ok: true, value: 50 * GB } as const

describe('disk: space', () => {
  it('warns at 1.2 GB of orphans and names lingtai clean', () => {
    const r = diskSpaceRow({ ok: true, value: listing(orphan(1.2 * 1024 * MB)) }, lots)
    expect(r.status).toBe('warn')
    expect(r.fix).toContain('lingtai clean')
  })
  it('is ok at 200 MB of orphans', () => {
    expect(diskSpaceRow({ ok: true, value: listing(orphan(200 * MB)) }, lots).status).toBe('ok')
  })
  it('warns at 3 GB free and is ok at 50 GB', () => {
    const l = { ok: true, value: listing() } as const
    expect(diskSpaceRow(l, { ok: true, value: 3 * GB }).status).toBe('warn')
    expect(diskSpaceRow(l, lots).status).toBe('ok')
  })
  it('says both when both thresholds are crossed, on one row', () => {
    const r = diskSpaceRow({ ok: true, value: listing(orphan(2 * 1024 * MB)) }, { ok: true, value: 3 * GB })
    expect(r.detail).toContain('orphan worktrees take')
    expect(r.detail).toContain('free')
  })
  it('warns when the listing fails, never ok', () => {
    const r = diskSpaceRow({ ok: false, reason: 'log unreadable' }, lots)
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('the orphans could not be counted')
  })
  it('warns when an orphan could not be sized or a directory read', () => {
    expect(diskSpaceRow({ ok: true, value: listing(orphan(null)) }, lots).status).toBe('warn')
    const r = diskSpaceRow({ ok: true, value: { items: [], unreadable: ['worktrees'] } }, lots)
    expect(r.status).toBe('warn')
  })
  it('warns when free space cannot be read', () => {
    const r = diskSpaceRow({ ok: true, value: listing() }, { ok: false, reason: 'ENOENT' })
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('ENOENT')
  })
})

describe('freeBytes', () => {
  it('keeps the statfs failure reason, not the Effect wrapper message', async () => {
    const err = await Effect.runPromise(Effect.flip(freeBytes('/nonexistent/lingtai-home')))
    expect(err.message).toContain('ENOENT')
    expect(err.message).not.toContain('Effect.tryPromise')
  })
})
