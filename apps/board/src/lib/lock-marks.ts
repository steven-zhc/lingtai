/**
 * Reading a project's locks as marks (#995, 0126 §8: elsewhere a lock is only
 * marked).
 *
 * Pure and import-light on purpose: `projects.tsx` sits beside a `'use client'`
 * component, and `locks.ts` reaches the store. Only `paused` is drawn here; the
 * ceiling and account kinds add a case beside `isPaused`, never a new parameter.
 */
import { type Lock, localDay } from '@lingtai/domain'

import type { ProjectLocks } from './locks.ts'

export type LockMap = ReadonlyMap<string, readonly Lock[]>

/** Each held project with every lock it carries; empty when the read failed (unknown is not paused). */
export function lockMap(read: ProjectLocks): LockMap {
  return read.ok ? new Map(read.held.map((h) => [h.project, h.locks])) : new Map()
}

/** The only place this ticket looks at a kind. */
export function isPaused(locks: readonly Lock[] | undefined): boolean {
  return locks?.some((l) => l.kind === 'paused') ?? false
}

/** Today's ceiling lock, if one stands for the local day of `now`; a passed day's is the banner's to say. */
export function ceilingToday(locks: readonly Lock[] | undefined, now: Date): Extract<Lock, { kind: 'ceiling' }> | null {
  const today = localDay(now)
  for (const l of locks ?? []) if (l.kind === 'ceiling' && l.day === today) return l
  return null
}

/** The ceiling lock of today held on any project in the map (it holds every project, so any one will do). */
export function anyCeilingToday(map: LockMap, now: Date): Extract<Lock, { kind: 'ceiling' }> | null {
  for (const locks of map.values()) {
    const c = ceilingToday(locks, now)
    if (c !== null) return c
  }
  return null
}

/** Names of paused projects, alphabetical; narrowed to `project` when one is selected. */
export function pausedNames(map: LockMap, project: string | undefined): string[] {
  return [...map]
    .filter(([name, locks]) => (project === undefined || name === project) && isPaused(locks))
    .map(([name]) => name)
    .sort()
}

/** Every registered project is paused — false for an empty register. */
export function everyPaused(map: LockMap, registered: readonly string[]): boolean {
  return registered.length > 0 && registered.every((p) => isPaused(map.get(p)))
}
