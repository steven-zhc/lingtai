import { reachAccountLimit } from '@lingtai/conductor'
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
import { inScope, liftAccountWith, setProjectPaused, sinceLabel, type HeldProject } from '../src/lib/locks.ts'

const now = new Date(2026, 10, 11, 18, 0)
const lock = (by: string, since: Date) => ({ kind: 'paused' as const, by, since })
const row = (project: string, by = 'human:steven', since = new Date(2026, 10, 11, 14, 20)): HeldProject => ({
  project,
  locks: [lock(by, since)],
})

describe('LockRows', () => {
  it('renders nothing with no rows', () => {
    expect(renderToStaticMarkup(<LockRows locks={{ ok: true, held: [], ceiling: undefined }} now={now} />)).toBe('')
  })

  it('draws one paused project: name linked, who, since, the note and a resume button', () => {
    const html = renderToStaticMarkup(
      <LockRows locks={{ ok: true, held: [row('lingtai')], ceiling: undefined }} now={now} />,
    )
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
    const html = renderToStaticMarkup(<LockRows locks={{ ok: true, held, ceiling: undefined }} now={now} />)
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
    const html = renderToStaticMarkup(
      <LockRows locks={{ ok: true, held: [row('lingtai')], ceiling: undefined }} now={now} />,
    )
    expect(html.indexOf('class="grow"')).toBeGreaterThan(html.indexOf('an attempt in flight'))
    expect(html.indexOf('class="grow"')).toBeLessThan(html.indexOf('<button'))
  })
})

describe('the account row (#1010)', () => {
  const account = (runtime: 'claude-code' | 'codex', until: Date) => ({
    kind: 'account' as const,
    runtime,
    by: 'lingtai' as const,
    since: new Date(2026, 10, 11, 17, 0),
    until,
    untilFrom: 'message' as const,
    said: 'limit reached',
  })
  const tonight = new Date(2026, 10, 11, 23, 0)
  const uses = new Map<string, readonly ('claude-code' | 'codex')[]>([
    ['lingtai', ['claude-code']],
    ['other', ['claude-code']],
    ['chapter-garden', ['codex']],
  ])
  const read = (held: HeldProject[]) => ({ ok: true as const, held, uses, ceiling: undefined })

  it('is one row per runtime for all projects, naming who waits and who takes work', () => {
    const held = [
      { project: 'lingtai', locks: [account('claude-code', tonight)] },
      { project: 'other', locks: [account('claude-code', tonight)] },
    ]
    const html = renderToStaticMarkup(<LockRows locks={read(held)} now={now} />)
    expect(html.match(/claude-code limit/g)).toHaveLength(1)
    expect(html).toContain('until 23:00')
    expect(html).toContain('lingtai and other wait')
    expect(html).toContain('chapter-garden runs on codex and still takes work')
    expect(html).toContain('>lift</button>')
  })

  it('says why a selected project waits, and draws no row for one that does not use it', () => {
    const held = [{ project: 'lingtai', locks: [account('claude-code', tonight)] }]
    expect(renderToStaticMarkup(<LockRows locks={read(held)} scope="lingtai" now={now} />)).toContain(
      'lingtai&#x27;s recipe uses claude-code, so it waits',
    )
    expect(renderToStaticMarkup(<LockRows locks={read(held)} scope="chapter-garden" now={now} />)).toBe('')
  })

  it('greys a passed limit and keeps lift', () => {
    const held = [{ project: 'lingtai', locks: [account('claude-code', new Date(2026, 10, 11, 17, 30))] }]
    const html = renderToStaticMarkup(<LockRows locks={read(held)} now={now} />)
    expect(html).toContain('pbrow passed')
    expect(html).toContain('passed · lifts when the conductor next looks')
    expect(html).toContain('>lift</button>')
  })

  it('goes before a pause', () => {
    const held = [{ project: 'lingtai', locks: [account('claude-code', tonight), lock('human:x', now)] }]
    const html = renderToStaticMarkup(<LockRows locks={read(held)} now={now} />)
    expect(html.indexOf('claude-code limit')).toBeLessThan(html.indexOf('Paused'))
  })
})

describe('liftAccountWith', () => {
  it('lifts after a reach, answers not limited when nothing stands, and refuses a non-runtime', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(
      reachAccountLimit(store, 'claude-code', {
        until: new Date(2026, 10, 11, 23, 0).toISOString(),
        untilFrom: 'message',
        said: 'x',
      }),
    )
    const lifted = await Effect.runPromise(liftAccountWith(store, 'claude-code', 'human:steven'))
    expect(lifted.ok).toBe(true)
    const events = await store.read('acct-claude-code')
    expect(events.filter((e) => e.type === 'AccountLimitLifted')).toHaveLength(1)
    const again = await Effect.runPromise(liftAccountWith(store, 'claude-code', 'human:steven'))
    expect(again.detail).toContain('not at its usage limit')
    expect((await store.read('acct-claude-code')).filter((e) => e.type === 'AccountLimitLifted')).toHaveLength(1)
    const refused = await Effect.runPromise(liftAccountWith(store, 'claude', 'human:steven'))
    expect(refused).toEqual({ ok: false, detail: 'unknown runtime "claude" — runtimes: claude-code, codex' })
  })
})
