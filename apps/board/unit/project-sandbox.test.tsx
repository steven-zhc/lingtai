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
const claims = [
  { streamId: 'ticket-my-app-12', data: { runId: 'pass-a' } },
  { streamId: 'ticket-other-3', data: { runId: 'pass-b' } },
]

describe('projectBlockedOf', () => {
  it('keeps the project’s own streams, drops telemetry and anything older than 14 days', () => {
    const blocked = projectBlockedOf(
      claims,
      [
        {
          streamId: 'pass-a',
          data: refused([
            entry('cdn.example.com', 2, '2026-11-13T00:00:00Z'),
            entry('sentry.io', 9, '2026-11-13T00:00:00Z', true),
            entry('old.example.com', 1, '2026-10-01T00:00:00Z'),
          ]),
        },
        { streamId: 'pass-b', data: refused([entry('theirs.example.com', 1, '2026-11-13T00:00:00Z')]) },
        { streamId: 'pass-unclaimed', data: refused([entry('nobody.example.com', 1, '2026-11-13T00:00:00Z')]) },
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
        { streamId: 'pass-a', data: { ...refused([]), read: { kind: 'unreadable', reason: 'store gone' } } },
        { streamId: 'pass-a', data: refused([entry('x.example.com', 1, '2026-11-13T00:00:00Z')], false) },
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
        [{ streamId: 'pass-a', data: refused([entry('cdn.example.com', 2, '2026-11-13T00:00:00Z')]) }],
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
