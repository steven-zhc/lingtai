import { type Envelope, type EventType, type PayloadOf, SCHEMA_VER, parsePayload, reduceProject } from '@lingtai/domain'
import { type Installation, NotInstalledError } from '@lingtai/github'
import { RECIPE_PATH, resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type AddOptions,
  checkInstallationEffect,
  recheck,
  registrationLine,
  resumeOnboarding,
  warnIfProtectedEffect,
} from '../src/onboard.ts'

const recipe = (base: string) => `
version: 2
branch:
  main: ${base}
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`

const reader = (files: Record<string, string>) => async (path: string, ref: string) => files[`${ref}:${path}`] ?? null

const SLUG = 'steven-zhc/nextloom-ai-admin'

/**
 * The half the board presses, and the half it presses *with* (#163).
 *
 * `Recheck` has no flags on it and never will: what it sends is a base a
 * `ProjectOnboardingStarted` recorded, filled by the wizard from GitHub's
 * default branch. Sent as a typed `--base` the row above — *refuses, naming
 * both branches* — would fire on the ordinary case and keep firing, because the
 * advice it gives is to re-run without a flag nobody typed and a button cannot
 * omit.
 */
describe('finishing an onboarding the wizard recorded', () => {
  it('replays the recorded base as a hint, and not as a flag a person typed', () => {
    expect(resumeOnboarding({ owner: 'steven-zhc', project: 'nextloom-ai-admin', base: 'main' })).toEqual({
      slug: SLUG,
      base: { ref: 'main', named: false },
    })
  })
})

/**
 * What `Recheck` asks: GitHub for the installation first, then `add` — and no
 * longer for a recipe landing in the repository (#182). The wizard recorded the
 * project through the installation, but it can have been removed since, and
 * that must be answered in its own sentence with nothing written; so must a
 * refusal from `add` of an installation that is there.
 */
describe('Recheck', () => {
  const RECORDED = { owner: 'steven-zhc', project: 'nextloom-ai-admin', base: 'main' }
  const INSTALLED: Installation = {
    id: 7,
    permissions: {},
    account: 'steven-zhc',
    repositorySelection: 'selected',
    htmlUrl: null,
    appSlug: null,
  }

  it('asks GitHub about the installation and registers nothing while the App is not installed', async () => {
    const asked: string[] = []
    const registered: AddOptions[] = []
    const result = await recheck(RECORDED, {
      installation: async (owner, repo) => {
        asked.push(`${owner}/${repo}`)
        throw new NotInstalledError(owner, repo)
      },
      register: (options) =>
        Effect.sync(() => {
          registered.push(options)
          return { ok: true, updated: false, warnings: [], reach: { kind: 'app', slug: null } } as const
        }),
    })

    expect(asked).toEqual([SLUG])
    expect(registered).toEqual([])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.installed).toBe(false)
    expect(result.detail).toContain(`not installed on ${SLUG}`)
    expect(result.detail).toContain('press Recheck')
    expect(result.detail).not.toContain('lingtai add')
  })

  it('registers through add, with the recorded base as a hint and the installation it read', async () => {
    const registered: AddOptions[] = []
    const result = await recheck(RECORDED, {
      installation: async () => INSTALLED,
      register: (options, log) =>
        Effect.sync(() => {
          registered.push(options)
          log('recipe: ~/.lingtai/nextloom-ai-admin/recipe.yml')
          return { ok: true, updated: false, warnings: [], reach: { kind: 'app', slug: null } } as const
        }),
    })

    expect(registered).toEqual([{ ...resumeOnboarding(RECORDED), installation: INSTALLED }])
    expect(result).toEqual({ ok: true, detail: 'nextloom-ai-admin is live' })
  })

  it('hands back everything add said when it refuses an installed repository', async () => {
    const result = await recheck(RECORDED, {
      installation: async () => INSTALLED,
      register: (_options, log) =>
        Effect.sync(() => {
          log('the installation is missing permissions:')
          log('  issues: have read, need write — reading work items')
          return { ok: false } as const
        }),
    })

    expect(result).toEqual({
      ok: false,
      installed: true,
      detail: 'the installation is missing permissions:\n  issues: have read, need write — reading work items',
    })
  })

  it('does not read any other failure as not installed', async () => {
    await expect(
      recheck(RECORDED, {
        installation: async () => {
          throw new Error('502 on /repos/steven-zhc/nextloom-ai-admin/installation: Bad Gateway')
        },
        register: () =>
          Effect.succeed({ ok: true, updated: false, warnings: [], reach: { kind: 'app', slug: null } } as const),
      }),
    ).rejects.toThrow('502')
  })
})

/**
 * Steps 1 and 2 on their own (#402) — lifted out of `add` so `lingtai add`'s
 * `askBeforeGithubAdd` (`apps/cli/src/add-github.ts`) can run them before it
 * asks a single question or writes a single answer. `add`'s own behaviour is
 * unchanged and covered above; these pin `checkInstallation` directly.
 */
describe('checkInstallation', () => {
  const INSTALLED: Installation = {
    id: 7,
    permissions: {
      issues: 'read',
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
      checks: 'read',
      statuses: 'read',
      metadata: 'read',
    },
    account: 'steven-zhc',
    repositorySelection: 'selected',
    htmlUrl: null,
    appSlug: null,
  }

  it('returns null and logs the gap when a known installation is missing a permission', async () => {
    const said: string[] = []
    const result = await Effect.runPromise(checkInstallationEffect(SLUG, (line) => said.push(line), INSTALLED))

    expect(result).toBeNull()
    expect(said.join('\n')).toContain('the installation is missing permissions:')
    expect(said.join('\n')).toContain('issues: have read, need write')
  })

  it('rethrows a failure that is not NotInstalledError rather than reading it as "not installed"', async () => {
    await expect(
      Effect.runPromise(
        checkInstallationEffect(
          SLUG,
          () => {},
          undefined,
          async () => {
            throw new Error('502 on /repos/steven-zhc/nextloom-ai-admin/installation: Bad Gateway')
          },
        ),
      ),
    ).rejects.toThrow('502')
  })
})

let seq = 1n

/** One stream's envelopes, versioned in call order. Payloads go through zod. */
function stream(streamId: string) {
  let version = 0
  return function event<T extends EventType>(type: T, data: PayloadOf<T>): Envelope {
    version += 1
    return {
      seq: seq++,
      streamId,
      version,
      type,
      schemaVer: SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: 'conductor',
      causation: null,
      at: new Date('2026-09-15T12:00:00.000Z'),
    }
  }
}

/**
 * What the command says it did — which is about the *project*, not the stream.
 *
 * A wizard-onboarded repository arrives here with one event already on it, so
 * counting events reports the first registration any of them ever had as an
 * update, and the tier-and-gates summary onboarding exists to print is never
 * printed for one (#163).
 */
describe('the last line lingtai add prints', () => {
  const resolved = () => resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: recipe('develop') }), 'develop')
  const event = stream('prj-nextloom-ai-admin')
  const started = event('ProjectOnboardingStarted', {
    slug: SLUG,
    base: 'main',
    by: 'human:steven',
  })
  const configured = event('ProjectConfigured', {
    project: 'nextloom-ai-admin',
    owner: 'steven-zhc',
    base: 'develop',
    configHash: 'h',
    fromSha: 's',
  })

  it("says added when the only earlier event is the wizard's", async () => {
    const line = registrationLine(reduceProject([started]), 1, 'nextloom-ai-admin', await resolved())

    expect(line).toContain('added nextloom-ai-admin')
    expect(line).toContain('across 5 steps')
    expect(line).not.toContain('updated')
  })

  it('says updated only once the project has been configured before', async () => {
    const line = registrationLine(reduceProject([started, configured]), 2, 'nextloom-ai-admin', await resolved())

    expect(line).toContain('updated nextloom-ai-admin')
    expect(line).toContain('2 earlier event(s)')
  })

  it('says added on a stream with nothing on it at all', async () => {
    expect(registrationLine(reduceProject([]), 0, 'nextloom-ai-admin', await resolved())).toContain('added')
  })
})

/** The base's protection is warned about and never refused on (#662). */
describe('warnIfProtected', () => {
  const asked = (answers: Record<string, unknown>) =>
    (async (_method: string, path: string) => {
      const answer = answers[path.includes('/rules/') ? 'rules' : 'branch']
      if (answer instanceof Error) throw answer
      return answer
    }) as <T>(method: string, path: string) => Promise<T>

  const run = async (answers: Record<string, unknown>) => {
    const said: string[] = []
    await Effect.runPromise(warnIfProtectedEffect(asked(answers), 'o', 'r', 'main', (line: string) => said.push(line)))
    return said.join('\n')
  }

  it('warns with both remedies when the branch reports protected: true', async () => {
    const said = await run({ branch: { protected: true }, rules: [] })
    expect(said).toContain('main is protected')
    expect(said).toContain('does not open pull requests')
    expect(said).toContain('bypass')
    expect(said).toContain('branch.main')
  })

  it('warns for a ruleset that refuses a push, and not for deletion or non_fast_forward alone', async () => {
    expect(await run({ branch: { protected: false }, rules: [{ type: 'pull_request' }] })).toContain('is protected')
    expect(
      await run({ branch: { protected: false }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] }),
    ).toBe('')
  })

  it('says it could not tell when a read fails, and never reads that as not protected', async () => {
    const said = await run({ branch: new Error('403'), rules: [] })
    expect(said).toContain('could not tell whether main is protected')
    expect(await run({ branch: { protected: false }, rules: new Error('404') })).toContain('could not tell')
  })
})
