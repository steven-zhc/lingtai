/**
 * #994. The banner under the bar, the lock read's scope, and the two actions'
 * core on the memory store.
 */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar } from '../src/app/bar.tsx'
import { LockRows } from '../src/app/lock-banner.tsx'
import { inScope, setProjectPaused, sinceLabel, type HeldProject } from '../src/lib/locks.ts'

const now = new Date(2026, 10, 11, 18, 0)
const lock = (by: string, since: Date) => ({ kind: 'paused' as const, by, since })
const row = (project: string, by = 'human:steven', since = new Date(2026, 10, 11, 14, 20)): HeldProject => ({
  project,
  locks: [lock(by, since)],
})

describe('LockRows', () => {
  it('renders nothing with no rows', () => {
    expect(renderToStaticMarkup(<LockRows locks={{ ok: true, held: [] }} now={now} />)).toBe('')
  })

  it('draws one paused project: name linked, who, since, the note and a resume button', () => {
    const html = renderToStaticMarkup(<LockRows locks={{ ok: true, held: [row('lingtai')] }} now={now} />)
    expect(html).toContain('Paused')
    expect(html).toContain('href="/?project=lingtai"')
    expect(html).toContain('title="show only lingtai"')
    expect(html).toContain('by human:steven')
    expect(html).toContain('since 14:20')
    expect(html).toContain('an attempt in flight finishes')
    expect(html).toContain('>resume</button>')
  })

  it('keeps the order it is given by project name', () => {
    const held = [row('alpha'), row('beta')]
    const html = renderToStaticMarkup(<LockRows locks={{ ok: true, held }} now={now} />)
    expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('beta'))
  })

  it('says a failed read, with no button', () => {
    const html = renderToStaticMarkup(<LockRows locks={{ ok: false, problem: 'db down' }} now={now} />)
    expect(html).toContain('could not read which projects are paused — db down')
    expect(html).not.toContain('<button')
  })
})

describe('inScope', () => {
  const held = [row('a'), row('b')]
  it('keeps every row for all projects and one project’s row for one', () => {
    expect(inScope(held, undefined)).toHaveLength(2)
    expect(inScope(held, 'b').map((h) => h.project)).toEqual(['b'])
    expect(inScope(held, 'nope')).toEqual([])
  })
})

describe('sinceLabel', () => {
  it('is HH:MM today and the date and time otherwise', () => {
    expect(sinceLabel(new Date(2026, 10, 11, 9, 5), now)).toBe('09:05')
    expect(sinceLabel(new Date(2026, 10, 10, 9, 5), now)).toBe('2026-11-10 09:05')
  })
})

describe('the bar’s pause slot', () => {
  const bar = (project: string | undefined, registered: boolean) =>
    renderToStaticMarkup(<Bar project={project} registered={registered} pause={<button>Pause</button>} />)
  it('is drawn beside Recipe for a registered project, and not for all projects or an unregistered name', () => {
    expect(bar('lingtai', true)).toContain('>Pause</button>')
    expect(bar(undefined, false)).not.toContain('Pause')
    expect(bar('ghost', false)).not.toContain('Pause')
  })
})

describe('setProjectPaused', () => {
  async function configured() {
    const store = createMemoryEventStore()
    await store.append(projectStream('lingtai'), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project: 'lingtai', owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
    return store
  }
  const types = async (store: Awaited<ReturnType<typeof configured>>) =>
    (await store.read(projectStream('lingtai'))).map((e) => e.type)

  it('pauses once and answers already the second time', async () => {
    const store = await configured()
    expect(await Effect.runPromise(setProjectPaused(store, 'pause', 'lingtai', 'human:a', now))).toMatchObject({
      ok: true,
    })
    const again = await Effect.runPromise(setProjectPaused(store, 'pause', 'lingtai', 'human:b', now))
    expect(again.ok).toBe(true)
    expect(again.detail).toContain('already paused by human:a')
    expect(await types(store)).toEqual(['ProjectConfigured', 'ProjectPaused'])
  })

  it('resuming an unpaused project appends nothing', async () => {
    const store = await configured()
    const result = await Effect.runPromise(setProjectPaused(store, 'resume', 'lingtai', 'human:a', now))
    expect(result).toMatchObject({ ok: true, detail: 'lingtai is not paused' })
    expect(await types(store)).toEqual(['ProjectConfigured'])
  })

  it('refuses an unregistered name without throwing and without appending', async () => {
    const store = await configured()
    for (const verb of ['pause', 'resume'] as const) {
      const result = await Effect.runPromise(setProjectPaused(store, verb, 'ghost', 'human:a', now))
      expect(result).toEqual({ ok: false, detail: '"ghost" is not a registered project' })
    }
    expect(await store.read(projectStream('ghost'))).toEqual([])
  })
})

describe('the banner row layout', () => {
  it('puts an expanding spacer before the resume button', () => {
    const html = renderToStaticMarkup(<LockRows locks={{ ok: true, held: [row('lingtai')] }} now={now} />)
    expect(html.indexOf('class="grow"')).toBeGreaterThan(html.indexOf('an attempt in flight'))
    expect(html.indexOf('class="grow"')).toBeLessThan(html.indexOf('<button'))
  })
})
