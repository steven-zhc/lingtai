import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SandboxSection } from '@/app/recipe/[project]/sandbox-section'
import { BlockedList } from '@/app/sandbox-panel'
import { projectBlockedOf } from '@/lib/sandbox-view'

const NOW = new Date('2026-11-14T12:00:00Z')
const entry = (host: string | null, count: number, firstAt: string, telemetry = false) => ({
  host,
  port: host === null ? null : 443,
  count,
  firstAt,
  telemetry,
})
const refused = (entries: ReturnType<typeof entry>[], complete = true) => ({
  step: 'build',
  action: 'run',
  runId: null,
  commandId: 'c1',
  read: { kind: 'entries', entries, complete },
})
const RECENT = '2026-11-13T00:00:00Z'
const claims = [
  { streamId: 'ticket-my-app-12', at: '2026-11-01T00:00:00Z', data: { runId: 'pass-a' } },
  { streamId: 'ticket-other-3', at: '2026-11-01T00:00:00Z', data: { runId: 'pass-b' } },
  { streamId: 'ticket-my-app-tools-7', at: '2026-11-01T00:00:00Z', data: { runId: 'pass-c' } },
]

describe('projectBlockedOf', () => {
  it('does not take a longer project name’s tickets for this project’s', () => {
    const blocked = projectBlockedOf(
      claims,
      [{ streamId: 'pass-c', at: RECENT, data: refused([entry('tools.example.com', 1, RECENT)]) }],
      'my-app',
      NOW,
    )
    expect(blocked.hosts).toEqual([])
  })

  it('lets a caveat from before the window lapse with the rest', () => {
    const old = '2026-10-01T00:00:00Z'
    const blocked = projectBlockedOf(
      claims,
      [
        { streamId: 'pass-a', at: old, data: { ...refused([]), read: { kind: 'unreadable', reason: 'store gone' } } },
        { streamId: 'pass-a', at: old, data: refused([], false) },
        { streamId: 'pass-a', at: old, data: { nonsense: true } },
      ],
      'my-app',
      NOW,
    )
    expect(blocked.caveats).toEqual([])
  })

  it('keeps the project’s own streams, drops telemetry and anything older than 14 days', () => {
    const blocked = projectBlockedOf(
      claims,
      [
        {
          streamId: 'pass-a',
          at: RECENT,
          data: refused([
            entry('cdn.example.com', 2, '2026-11-13T00:00:00Z'),
            entry('sentry.io', 9, '2026-11-13T00:00:00Z', true),
            entry('old.example.com', 1, '2026-10-01T00:00:00Z'),
          ]),
        },
        { streamId: 'pass-b', at: RECENT, data: refused([entry('theirs.example.com', 1, '2026-11-13T00:00:00Z')]) },
        {
          streamId: 'pass-unclaimed',
          at: RECENT,
          data: refused([entry('nobody.example.com', 1, '2026-11-13T00:00:00Z')]),
        },
      ],
      'my-app',
      NOW,
    )
    expect(blocked.hosts.map((h) => h.label)).toEqual(['cdn.example.com'])
    expect(blocked.hosts[0]).toMatchObject({ count: 2, from: ['#12'] })
    expect(blocked.hosts[0]!.allowHref).toBe('/recipe/my-app?edit=1&allow=cdn.example.com#sandbox')
  })

  it('says an unreadable or incomplete read, never an empty list', () => {
    const blocked = projectBlockedOf(
      claims,
      [
        {
          streamId: 'pass-a',
          at: RECENT,
          data: { ...refused([]), read: { kind: 'unreadable', reason: 'store gone' } },
        },
        { streamId: 'pass-a', at: RECENT, data: refused([entry('x.example.com', 1, '2026-11-13T00:00:00Z')], false) },
      ],
      'my-app',
      NOW,
    )
    expect(blocked.caveats.join(' ')).toContain('store gone')
    expect(blocked.caveats.join(' ')).toContain('lower bound')
  })
})

const builtIn = {
  domains: ['github.com'],
  paths: { writable: ['<worktree>'], denyRead: ['/home/me/.ssh'], denyWrite: [] },
  pathsWhy: null,
}

describe('SandboxSection', () => {
  const blocked = (
    <BlockedList
      blocked={projectBlockedOf(
        claims,
        [{ streamId: 'pass-a', at: RECENT, data: refused([entry('cdn.example.com', 2, '2026-11-13T00:00:00Z')]) }],
        'my-app',
        NOW,
      )}
    />
  )

  it('shows the project’s own entries beside the greyed built-ins, and recently blocked', () => {
    const html = renderToStaticMarkup(
      <SandboxSection
        project="my-app"
        own={{ enabled: true, required: false, network: { allow: ['example.org'] }, write: ['~/data'], deny: [] }}
        recipeError={false}
        builtIn={builtIn}
        blocked={blocked}
      />,
    )
    expect(html).toContain('id="sandbox"')
    expect(html).toContain('example.org')
    expect(html).toContain('this recipe')
    expect(html).toContain('github.com')
    expect(html).toContain('built in')
    expect(html).toContain('cdn.example.com')
    expect(html).toContain('configured now')
  })

  it('a recipe with no block says off, shows the built-ins, and links to add it', () => {
    const html = renderToStaticMarkup(
      <SandboxSection project="my-app" own={undefined} recipeError={false} builtIn={builtIn} blocked={null} />,
    )
    expect(html).toContain('off — no sandbox block')
    expect(html).toContain('github.com')
    expect(html).toContain('/recipe/my-app?edit=1#sandbox')
  })

  it('says the built-in paths are unknown rather than listing none', () => {
    const html = renderToStaticMarkup(
      <SandboxSection
        project="my-app"
        own={undefined}
        recipeError
        builtIn={{ domains: ['github.com'], paths: null, pathsWhy: 'HOME is unset' }}
        blocked={null}
      />,
    )
    expect(html).toContain('HOME is unset')
    expect(html).toContain('could not be read')
  })
})

describe('stamped links', () => {
  const view = projectBlockedOf(
    claims,
    [{ streamId: 'pass-a', at: RECENT, data: refused([entry('cdn.example.com', 2, '2026-11-13T00:00:00Z')]) }],
    'my-app',
    NOW,
  )

  it('puts the stamp before the hash, so a click is a new command', () => {
    const html = renderToStaticMarkup(<BlockedList blocked={view} stamp={42} />)
    expect(html).toContain('/recipe/my-app?edit=1&amp;allow=cdn.example.com&amp;r=42#sandbox')
  })

  it('stamps the editor link only when given one', () => {
    const at = (stamp?: number) =>
      renderToStaticMarkup(
        <SandboxSection
          project="my-app"
          {...(stamp === undefined ? {} : { stamp })}
          own={undefined}
          recipeError={false}
          builtIn={builtIn}
          blocked={null}
        />,
      )
    expect(at(7)).toContain('/recipe/my-app?edit=1&amp;r=7#sandbox')
    expect(at()).toContain('/recipe/my-app?edit=1#sandbox')
  })
})
