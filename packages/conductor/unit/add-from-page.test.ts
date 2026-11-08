/**
 * `addProject` and the rules the board's step 2 leans on (#971): a project
 * already added is refused before anything is written, a refusal names itself,
 * a registration that fails leaves the recipe and says so, and its retry
 * registers. Fake files and ports (0060 §1) — nothing here touches a disk.
 */
import type { ProjectState } from '@lingtai/domain'
import { type RecipeFiles, recipePath } from '@lingtai/recipe'
import { keptSentence, LINGTAI_BASE, type Proposal, type SetupForm } from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { addProject, localTicketsOf, previewOf } from '../src/add-from-page.ts'

const HOME = '/home/me/.lingtai'

const FORM: SetupForm = {
  project: 'chapter-garden',
  target: { kind: 'github', owner: 'acme', repo: 'chapter-garden' },
  base: 'main',
  remote: null,
  install: 'pnpm install --frozen-lockfile',
  checks: [{ name: 'test', run: 'pnpm test' }],
  writer: 'claude-code',
  reviewer: 'none',
  tickets: 'github',
  kinds: ['bug', 'feature'],
  heldBy: '',
  closeOnEnd: true,
  personApprovesMerge: false,
  limits: { turns: 300, wall: '2h', rounds: 2, restarts: 0 },
  turnsUnbounded: false,
}

function files(): RecipeFiles & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    read: async (p) => store.get(p) ?? null,
    replace: async (p, t) => {
      store.set(p, t)
    },
  }
}

const run = <A>(e: Effect.Effect<A, never>) => Effect.runPromise(e)

describe('addProject (#971)', () => {
  it('refuses a project already added and writes nothing', async () => {
    const f = files()
    const out = await run(
      addProject(FORM, {
        home: HOME,
        files: f,
        projects: async () => [{ project: 'Chapter-Garden' } as ProjectState],
        register: () => Effect.void,
      }),
    )
    expect(out).toEqual({ ok: false, say: expect.stringContaining('is already added') })
    expect(f.store.size).toBe(0)
  })

  it('refuses an empty base by name before any write', async () => {
    const f = files()
    const out = await run(
      addProject(
        { ...FORM, base: '' },
        { home: HOME, files: f, projects: async () => [], register: () => Effect.void },
      ),
    )
    expect(out).toEqual({ ok: false, say: expect.stringContaining('no base branch') })
    expect(f.store.size).toBe(0)
  })

  it('refuses GitHub tickets on a local directory', async () => {
    const out = await run(
      addProject(
        {
          ...FORM,
          target: { kind: 'local', path: '/work/x' },
          base: LINGTAI_BASE,
          remote: '/work/x',
          tickets: 'github',
        },
        { home: HOME, files: files(), projects: async () => [], register: () => Effect.void },
      ),
    )
    expect(out).toEqual({ ok: false, say: expect.stringContaining('no owner') })
  })

  it('keeps the recipe when the registration fails, and a retry registers', async () => {
    const f = files()
    const path = recipePath(FORM.project, HOME)
    let registrations = 0
    const ports = (fail: boolean) => ({
      home: HOME,
      files: f,
      projects: async () => [] as ProjectState[],
      register: () => {
        registrations++
        return fail ? Effect.fail(new Error('the App is not installed')) : Effect.void
      },
    })

    const first = await run(addProject(FORM, ports(true)))
    expect(first).toEqual({ ok: false, say: `the App is not installed. ${keptSentence(path)}` })
    expect(f.store.has(path)).toBe(true)

    const second = await run(addProject(FORM, ports(false)))
    expect(second).toEqual({ ok: true, project: FORM.project, path })
    expect(registrations).toBe(2)
  })
})

describe('previewOf (#971)', () => {
  it('is the text applySetup would write, and writes nothing', async () => {
    const f = files()
    const out = await run(previewOf(FORM, { home: HOME, files: f }))
    expect(out).toEqual({ text: expect.stringContaining('agent: claude-code') })
    expect(f.store.size).toBe(0)
  })
})

describe('localTicketsOf (#977 deletes it)', () => {
  const proposal = (repository: { owner: string; repo: string } | null) =>
    ({
      tickets: { known: true, value: { source: repository === null ? 'db' : 'github', repository }, because: 'x' },
    }) as unknown as Proposal

  it('reads db for a directory whose origin is on GitHub, and says why', () => {
    const t = localTicketsOf(proposal({ owner: 'a', repo: 'b' }))
    expect(t.source).toBe('db')
    expect(t.because).toContain('#977')
  })

  it('reads db for a directory with no GitHub origin', () => {
    expect(localTicketsOf(proposal(null)).source).toBe('db')
  })
})
