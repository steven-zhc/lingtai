/**
 * The events page's filter, as pure functions (#789).
 *
 * This file is imported by a `"use client"` component, so it imports nothing:
 * `./events` reads the filesystem, and a server-only import reaching the client
 * graph is caught only by the Next build, after the merge (#230).
 */
export const OUTSIDE = 'outside'
export const NONE = 'none'

export interface Indexed {
  name: string
  group: string
  at: readonly string[]
}

/** `?step=` → a step, `outside`, `none`, or `null` for an absent or unknown value. */
export function parseStep(search: string, steps: readonly string[]): string | null {
  const value = new URLSearchParams(search).get('step')
  if (value === null) return null
  return value === OUTSIDE || value === NONE || steps.includes(value) ? value : null
}

/** Whether an event written at `at` is shown under `filter` (`null` shows all). */
export function matches(at: readonly string[], filter: string | null): boolean {
  if (filter === null) return true
  if (filter === NONE) return at.length === 0
  return at.includes(filter)
}

/** The count at each node: every step, then `outside`, then `none`. */
export function counts(events: readonly Indexed[], steps: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const node of [...steps, OUTSIDE, NONE]) out[node] = events.filter((e) => matches(e.at, node)).length
  return out
}

/** Events by group, groups in the order they first appear. */
export function byGroup<T extends Indexed>(events: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const e of events) groups.set(e.group, [...(groups.get(e.group) ?? []), e])
  return [...groups]
}

export function groupId(group: string): string {
  return `group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}
