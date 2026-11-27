import type { ProjectState } from '@lingtai/domain'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import type { GitHubClient } from '@lingtai/github'
import { LIMIT_DEFAULTS, parseDuration, resolveRecipe } from '@lingtai/recipe'
/**
 * What a project will take, said in one wording — and what it says when it
 * cannot say.
 *
 * Pure: `projectFilter` is given the client, so nothing here opens a database or
 * a socket. That matters more than usual, because the whole point of the module
 * is what it does on the failure path, and a failure path only reached through
 * a real GitHub is a failure path nothing tests.
 *
 * #76: the recipe on `main` named a label the core's enum did not have, so it
 * stopped parsing and every issue in the project vanished from the queue with
 * nothing anywhere saying why.
 */
import { describe, expect, it, vi } from 'vitest'

import { dbTickets } from '../src/db-tickets.ts'
import {
  type RecipeFor,
  describeAssignee,
  describeFilter,
  ownerlessRefusal,
  attemptCeiling,
  projectClient,
  projectFilter,
} from '../src/filter.ts'
import type { TicketsFor } from '../src/ticket-store.ts'
import { memoryTickets } from '../test/memory-tickets.ts'
import { fakeGitHub, project as onePassProject, PROJECT } from '../test/one-attempt.ts'

const project = { project: 'lingtai', owner: 'steven-zhc', base: 'main' } as ProjectState

const RECIPE = `
version: 2
branch:
  main: main
source:
  kinds: [bug, tech-debt, documentation]
  exclude: [blocked, agent:hold]
env:
  required: []
  plantAt: .env.local
steps:
  admit: []
  prepared:
    - name: install
      run: pnpm install
      timeout: 10m
  proposed:
    - name: build
      run: pnpm test
      timeout: 20m
    - name: review
      agent: claude-code
      prompt: reviewer
runtime:
  agent: claude-code
`

/**
 * The recipe through the client's `fileAt`, so each test keeps the file it
 * wrote. Where a conductor reads it from is `local.test.ts`'s; what is under
 * test here is what a resolved recipe reduces to.
 */
const fromFile: RecipeFor = (state, c) =>
  resolveRecipe((p, r) => (c as GitHubClient).fileAt(p, r), state.base ?? 'main')

/** Answers one file at one ref, and nothing else. */
function client(file: string | null): GitHubClient {
  return {
    owner: 'steven-zhc',
    repo: 'lingtai',
    fileAt: async () => file,
  } as unknown as GitHubClient
}

describe('projectFilter', () => {
  it('reduces a resolved recipe to what it takes, in priority order', async () => {
    const filter = await projectFilter(project, async () => client(RECIPE), fromFile)

    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    expect(filter.kinds).toEqual(['bug', 'tech-debt', 'documentation'])
    expect(filter.exclude).toEqual(['blocked', 'agent:hold'])
    expect(filter.ref).toBe('main')
    expect(filter.configHash).toMatch(/^[0-9a-f]{64}$/)
    // Parsed here so that no caller reads a duration string, and defaulted by
    // the schema rather than by a constant in the queue (0028).
    expect(filter.backoffMs).toBe(60 * 60_000)
  })

  /**
   * The denominator a running card measures a gate against (#79) — parsed here
   * for the reason `backoffMs` is, so the board never gets its own idea of what
   * `20m` is.
   *
   * All ten steps, including the ones nothing is configured at: an empty
   * step is `skipped` and the skip has to be visible, or a step that *was*
   * configured and silently did not run is indistinguishable from it
   * (ADR 0016 §4). It was five until `#227` and the rule never counted — what
   * this asserts is *every step the vocabulary has*, whatever it has.
   */
  it("carries every step's actions with the timeouts already numbers", async () => {
    const filter = await projectFilter(project, async () => client(RECIPE), fromFile)

    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    // All ten, in pass order, whatever the recipe configured — which is the
    // property this line is for, not the five it used to name.
    expect([...filter.plan.keys()]).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'review',
      'proposed',
      'merge',
      'end',
    ])
    expect(filter.plan.get('prepared')).toEqual([{ name: 'install', budgetMs: 10 * 60_000 }])
    // A reviewer has no clock on it, and null is not zero: a card that showed a
    // budget of 0 would say it was already out of time.
    expect(filter.plan.get('proposed')).toEqual([
      { name: 'build', budgetMs: 20 * 60_000 },
      { name: 'review', budgetMs: null },
    ])
    expect(filter.plan.get('merge')).toEqual([])
  })

  /** The recipe decides it, so a recipe that says something else is obeyed. */
  it('takes the backoff from the recipe, in milliseconds', async () => {
    const filter = await projectFilter(
      project,
      async () => client(RECIPE.replace('exclude:', 'backoff: 15m\n  exclude:')),
      fromFile,
    )

    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    expect(filter.backoffMs).toBe(15 * 60_000)
  })

  /**
   * Zero is not a shorter backoff, it is the absence of the guard the $29 loop
   * bought — so it fails to resolve, naming the key, rather than throwing from
   * the middle of a queue pass.
   */
  it('refuses a backoff that is not a positive duration', async () => {
    const filter = await projectFilter(
      project,
      async () => client(RECIPE.replace('exclude:', 'backoff: 0s\n  exclude:')),
      fromFile,
    )

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.problem).toContain('source.backoff')
    expect(filter.problem).toContain('positive duration')
  })

  /**
   * The failure that started this. `documentation` was refused by `WorkKind`,
   * so the whole file failed to parse — and a caller who only looked at the
   * returned queue saw a project with no work.
   */
  it('answers with the reason rather than throwing, when the recipe will not parse', async () => {
    const filter = await projectFilter(project, async () => client('version: 2\nrepo: {}\n'), fromFile)

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.problem).toContain('.lingtai/config.yaml')
    // One line, keeping every problem: `RecipeInvalidError` puts one per line,
    // which reads badly in a column.
    expect(filter.problem).not.toContain('\n')
  })

  it('carries the old spellings a refused recipe wrote, so doctor needs no second read (#1308)', async () => {
    const old = RECIPE.replace('branch:\n  main: main', 'repo:\n  base: main')
    expect(old).not.toBe(RECIPE)
    const filter = await projectFilter(project, async () => client(old), fromFile)

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.oldSpellings?.map((s) => s.at)).toEqual(['repo.base'])
    expect(filter.problem).toContain('lingtai doctor --fix')
  })

  it('says so when there is no recipe at all', async () => {
    const filter = await projectFilter(project, async () => client(null), fromFile)

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.problem).toContain('no .lingtai/config.yaml on main')
  })

  it('says so when the project cannot be reached, in the same shape', async () => {
    const filter = await projectFilter(
      project,
      async () => {
        throw new Error('no owner recorded — re-run lingtai add to record it')
      },
      fromFile,
    )

    expect(filter).toEqual({
      project: 'lingtai',
      ok: false,
      problem: 'no owner recorded — re-run lingtai add to record it',
    })
  })
})

const ownerlessState = { project: 'esctest', owner: null, base: 'main' } as ProjectState

const RECIPE_OWNERLESS = `
version: 2
branch: { main: main }
repo: { remote: git@example.com:esctest/esctest.git }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

const RECIPE_OWNERLESS_NO_DB = `
version: 2
branch: { main: main }
repo: { remote: git@example.com:esctest/esctest.git }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

const RECIPE_OWNERLESS_NO_REMOTE = `
version: 2
branch: { main: main }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

const RECIPE_OWNERLESS_NEITHER = `
version: 2
branch: { main: main }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

/** Ignores `client` entirely — the whole point of the path under test. */
function recipeOf(text: string): RecipeFor {
  return (state) => resolveRecipe(async () => text, state.base ?? 'main')
}

/**
 * #354: a project with no owner has no App to build a `GitHubClient` from, so
 * `projectFilter` must not try — `clientFor` below fails the test if it is
 * called at all.
 */
describe('projectFilter, for a project with no owner', () => {
  const clientFor = async (): Promise<never> => {
    throw new Error('no client should be built for a project with no owner')
  }

  it('resolves with no client built, and its tickets taken from the fourth argument', async () => {
    const tickets = memoryTickets()
    const ticketsOf = vi.fn<TicketsFor>(async () => tickets)

    const filter = await projectFilter(ownerlessState, clientFor, recipeOf(RECIPE_OWNERLESS), ticketsOf)

    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    expect(ticketsOf).toHaveBeenCalledTimes(1)
    const call = ticketsOf.mock.calls[0]
    expect(call?.[0]).toBe(ownerlessState)
    // Never read on this path: the refusal already requires `source.tickets: db`.
    expect(call?.[2]).toBeUndefined()
    // Nothing reads `filter.client` today (#354's design note); it carries the
    // same tickets `filter.tickets` does, since there is no `GitHubClient`.
    expect(filter.tickets).toBe(tickets)
    expect(filter.client).toBe(tickets)
  })

  it('fills links from a store that reads them, with the project as repository, and leaves memory tickets null', async () => {
    const listBlockedBy = vi.fn(async () => [{ repository: 'name', number: 1, title: 't', state: 'open' as const }])
    const withLinks = Object.assign(memoryTickets(), { listBlockedBy })
    const filter = await projectFilter(ownerlessState, clientFor, recipeOf(RECIPE_OWNERLESS), async () => withLinks)
    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    expect(filter.links?.repository).toBe(ownerlessState.project)
    await filter.links?.listBlockedBy(3)
    expect(listBlockedBy).toHaveBeenCalledWith(3)

    const plain = await projectFilter(ownerlessState, clientFor, recipeOf(RECIPE_OWNERLESS), async () =>
      memoryTickets(),
    )
    expect(plain.ok && plain.links).toBe(null)
  })

  it('refuses by name when the recipe does not say source.tickets: db', async () => {
    const filter = await projectFilter(ownerlessState, clientFor, recipeOf(RECIPE_OWNERLESS_NO_DB))

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.problem).toContain('source.tickets: db')
    expect(filter.problem).toContain('lingtai add <owner>/<repo>')
  })

  it('refuses by name when the recipe names no repo.remote', async () => {
    const filter = await projectFilter(ownerlessState, clientFor, recipeOf(RECIPE_OWNERLESS_NO_REMOTE))

    expect(filter.ok).toBe(false)
    if (filter.ok) return
    expect(filter.problem).toContain('repo.remote')
    expect(filter.problem).toContain('lingtai add --local')
  })
})

describe('ownerlessRefusal', () => {
  it('checks source.tickets: db before repo.remote', async () => {
    const neither = await resolveRecipe(async () => RECIPE_OWNERLESS_NEITHER, 'main')
    expect(ownerlessRefusal('esctest', neither.recipe)).toContain('source.tickets: db')
  })

  it('answers null when both are set', async () => {
    const resolved = await resolveRecipe(async () => RECIPE_OWNERLESS, 'main')
    expect(ownerlessRefusal('esctest', resolved.recipe)).toBeNull()
  })
})

function freshSql(): TicketSql {
  return createSqliteTicketSql(openSqliteLog(':memory:'))
}

const RECIPE_GITHUB_TICKETS = `
version: 2
branch: { main: main }
repo: { submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

const RECIPE_DB_TICKETS = `
version: 2
branch: { main: main }
repo: { submodules: false }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

/**
 * The seam every site #383 moved onto — the client and the recipe, built and
 * resolved together, with the ticket side already taken from `ticketsFor`.
 */
describe('projectClient', () => {
  it('answers the client itself as `client` when the recipe names no source', async () => {
    const said: string[] = []
    const github = fakeGitHub(said, RECIPE_GITHUB_TICKETS)

    const { client, resolved } = await projectClient(onePassProject, {
      clientFor: async () => github,
      recipeFor: fromFile,
    })

    expect(client).toBe(github)
    expect(resolved.recipe.source.kinds).toEqual(['bug'])
  })

  /** `token`, `defaultBranch` and `refSha` still answer from the fake — only the eight ticket verbs move. */
  it('answers from dbTickets when the recipe says db, and leaves the rest of the client alone', async () => {
    const said: string[] = []
    const github = fakeGitHub(said, RECIPE_DB_TICKETS)
    const sql = freshSql()

    const { client } = await projectClient(onePassProject, {
      clientFor: async () => github,
      recipeFor: fromFile,
      tickets: { sql, log: { projectStreams: async () => [] } },
    })

    expect(client).not.toBe(github)
    const opened = await dbTickets(sql, PROJECT).createIssue({ title: 'seeded', body: '', labels: ['bug'] })
    await expect(client.getIssue(opened.number)).resolves.toMatchObject({ title: 'seeded' })

    expect(await client.token()).toBe('not-a-real-token')
    expect(await client.defaultBranch()).toBe('main')
    expect(await client.refSha('heads/main')).toBe('0'.repeat(40))
  })
})

describe('describeFilter', () => {
  it('names the recipe, what it picks up and excludes, what a pass costs and when it retries', async () => {
    const filter = await projectFilter(project, async () => client(RECIPE), fromFile)
    const lines = describeFilter(filter)

    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatch(/^lingtai\s+recipe [0-9a-f]{12} from main$/)
    expect(lines[1]).toContain('picks up     bug > tech-debt > documentation')
    expect(lines[1]).toContain('(in priority order)')
    expect(lines[2]).toContain('excludes     blocked, agent:hold')
    // Said when the machine says nothing, as `both` — unassigned work and
    // everybody's, which is what the queue did before it read an assignee (#181).
    const assignee = lines.splice(3, 1)[0]
    expect(assignee).toContain('assignee     any issue, whoever it is assigned to')
    // Printed by a recipe that never mentions it, which is the point: a default
    // that spends money has to be readable without opening Lingtai's source
    // (0025 §2), and a line that only appears when it is on is not that.
    // The product and not the numbers: what an operator is deciding about is
    // what one pass of this project can cost (0039 §3).
    expect(lines[3]).toContain('an attempt   up to 53 implement runs')
    // And for the same reason again: the backoff decides when this project
    // spends money next, and it was in none of the four places that describe a
    // project (#95).
    expect(lines[4]).toContain('retries      after 1h, unless a repair is pending')
  })

  /**
   * A project that will take nothing gets a *line*, not an absence. Being
   * omitted is what an empty queue already looks like, which is the whole
   * confusion #76 records.
   */
  it('gives a project whose recipe will not resolve its own line, loudly', async () => {
    const filter = await projectFilter(project, async () => client('nope: 1\n'), fromFile)
    const lines = describeFilter(filter)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('lingtai')
    expect(lines[0]).toContain('RECIPE INVALID')
    expect(lines[1]).toContain('nothing will be taken from this project')
  })
})

/**
 * What a ticket costs, said once so three places cannot disagree.
 *
 * On 2026-09-10 `lingtai shutdown` told an operator it would wait at most one
 * `wall`. That was true when the sentence was written and false once a refusal
 * could buy another agent run — a sentence in `apps/cli` chasing a number in
 * `packages/recipe`, with nothing between them to notice. The fix is not a
 * better sentence, it is one sentence that is **made of** the numbers, so the
 * only way to make it wrong is to change the numbers.
 */
describe('what a ticket may spend', () => {
  const limits = (
    refusalFixes: number,
    wall = '1h',
    wallMs = 3_600_000,
    newAttempts = 0,
    conflictResolutions = refusalFixes,
  ) => ({
    refusalFixes,
    conflictResolutions,
    newAttempts,
    turns: 150,
    wall,
    wallMs,
  })

  it("multiplies the wall by 0108 §8's product, not by the rounds", () => {
    // One attempt: the work, two refusal fixes, two conflict resolutions and three reruns is eight
    // runs, and a person may be asked five times: thirteen.
    expect(attemptCeiling(limits(2))).toContain('up to 13 implement runs a ticket')
    expect(attemptCeiling(limits(2))).toContain('at most 13h')
  })

  it('says 53 implement runs for the defaults 6, 6 and 2, and lists the other steps without summing them', () => {
    const said = attemptCeiling({
      ...limits(6, '2h', 7_200_000, 2),
      turns: 300,
    })
    // 3 × (1 + 6 + 6 + 3) + 5
    expect(said).toContain('up to 53 implement runs a ticket')
    expect(said).toContain('at most 106h')
    for (const other of [
      'design runs once an attempt',
      'review runs once after each implement',
      'a judge is asked once per refusal',
      'triage runs within triage.limits',
    ]) {
      expect(said).toContain(other)
    }
    expect(said).toContain('not in this figure')
  })

  /** The assertion the ticket asked for: change the number, the sentence moves. */
  it('changes when either attempt bound changes, and they are told apart', () => {
    const one = attemptCeiling(limits(1, '1h', 3_600_000, 0, 1))
    const fixes = attemptCeiling(limits(4, '1h', 3_600_000, 0, 1))
    const conflicts = attemptCeiling(limits(1, '1h', 3_600_000, 0, 4))

    expect(one).toContain('at most 11h')
    expect(fixes).toContain('at most 14h')
    expect(conflicts).toContain('at most 14h')
    expect(fixes).toContain('4 refusal fixes')
    expect(fixes).toContain('1 conflict resolution')
    expect(conflicts).toContain('1 refusal fix')
    expect(conflicts).toContain('4 conflict resolutions')
  })

  it("reads the wall back in the recipe's own words", () => {
    // `15m` and not `900000`: this line is read against the file it came from.
    expect(attemptCeiling(limits(1, '15m', 900_000))).toContain('15m and 150 turns each')
    expect(attemptCeiling(limits(1, '15m', 900_000))).toContain('at most 165m')
  })

  /**
   * `refusalFixes: 0` is the whole of what `repair.on: false` used to say (0039 §4),
   * and it has to read as a choice rather than as an absence — 0025 §2's rule
   * that a default which spends money is shown when it is off as well as on.
   */
  it('says where a refusal and a conflict go when nothing is bought', () => {
    const none = attemptCeiling(limits(0))

    expect(none).toContain('a refusal buys no fix in the same worktree (runtime.limits.attempt.refusalFixes: 0)')
    expect(none).toContain('a merge conflict buys no resolution (runtime.limits.attempt.conflictResolutions: 0)')
    expect(none).toContain('up to 9 implement runs a ticket')
  })

  /**
   * **The ticket's bound multiplies the attempt's** (0040 §5), and this is the
   * assertion that stops it being a ceiling nobody was told about.
   */
  it('multiplies again for the attempts a new attempt can buy', () => {
    // Eight runs an attempt; one new attempt is two attempts; five answers to a person.
    const once = attemptCeiling(limits(2, '1h', 3_600_000, 1))

    expect(once).toContain('up to 21 implement runs a ticket')
    expect(once).toContain('2 attempts of 8 runs')
    expect(once).toContain('once before it is yours')
    expect(once).toContain('at most 21h')
  })

  /**
   * 0025 §2 again, one ceiling along: `newAttempts: 0` is said, so an operator
   * learns that a spent attempt is theirs.
   */
  it('says a spent attempt is yours when no new attempt is bought', () => {
    const none = attemptCeiling(limits(2))

    expect(none).toContain('runtime.limits.ticket.newAttempts: 0')
    expect(none).toContain('goes to you')
  })

  /** The recipe nobody edited prints one sentence, and an empty `steps` changes nothing (`#314`, 0070 §8). */
  it('prints the same sentence with an empty steps as with none', () => {
    const defaults = {
      ...LIMIT_DEFAULTS.attempt,
      ...LIMIT_DEFAULTS.ticket,
      turns: LIMIT_DEFAULTS.run.turns,
      wall: LIMIT_DEFAULTS.run.wall,
      wallMs: parseDuration(LIMIT_DEFAULTS.run.wall),
    }
    expect(attemptCeiling({ ...defaults, steps: [] })).toBe(attemptCeiling(defaults))
    expect(attemptCeiling(defaults)).toContain('up to 53 implement runs a ticket')
    expect(attemptCeiling(defaults)).toContain('2h and 300 turns each')
  })

  /**
   * **And a step that narrows is named, on the same line** (`#314`, 0070 §9).
   *
   * The figure stays `implement`'s, so the other bounds are *named* rather than
   * added, which is what keeps this one line and keeps it true.
   */
  it('names the dispatching steps bounded differently from the one it prints', () => {
    const said = attemptCeiling({ ...limits(2), steps: [{ step: 'review', turns: 50, wall: '30m' }] })

    expect(said).toContain('1h and 150 turns each at implement (review 30m/50 turns)')
    // The arithmetic is untouched: thirteen runs of `implement`'s hour.
    expect(said).toContain('at most 13h')
  })
})

/**
 * `usd`, the dollar ceiling (`#370`). Follows `wallMs`, not `turns` — it
 * multiplies across runs the same way the wall does.
 */
describe('what a ticket may spend in dollars', () => {
  const limits = (refusalFixes: number, newAttempts = 0) => ({
    refusalFixes,
    conflictResolutions: refusalFixes,
    newAttempts,
    turns: 150,
    wall: '1h',
    wallMs: 3_600_000,
  })

  it('names no dollars when usd is absent', () => {
    expect(attemptCeiling(limits(2))).not.toContain('$')
  })

  it('multiplies usd by the runs a ticket can buy, beside the wall', () => {
    const said = attemptCeiling({ ...limits(2), usd: 12 })
    expect(said).toContain('1h, 150 turns and $12 each')
    expect(said).toContain('at most 13h and $156')
  })

  it('multiplies again for the attempts a new attempt can buy', () => {
    const said = attemptCeiling({ ...limits(2, 1), usd: 12 })
    expect(said).toContain('up to 21 implement runs a ticket')
    expect(said).toContain('at most 21h and $252')
  })
})

/** The login is printed, because a wrong one is the mistake this setting can have (#181). */
describe('describeAssignee', () => {
  it('names the login it matches, under each setting', () => {
    expect(describeAssignee(undefined)).toBe('any issue, whoever it is assigned to')
    expect(describeAssignee({ login: 'alice', take: 'mine' })).toBe('only issues assigned to alice')
    expect(describeAssignee({ login: 'alice', take: 'unassigned' })).toBe(
      'only issues assigned to nobody (this machine is alice)',
    )
    expect(describeAssignee({ login: 'alice', take: 'all' })).toBe(
      'any issue, whoever it is assigned to (this machine is alice)',
    )
  })
})

/**
 * #1332: resolving a filter asks GitHub nothing. `doctor` hands in a client that
 * throws on every read, and `links.repository` read `owner` while the filter
 * was being built.
 */
describe('projectFilter, with a GitHub client nothing may read', () => {
  const throwing = (): GitHubClient =>
    new Proxy({} as GitHubClient, {
      get(_target, key) {
        if (key === 'then' || typeof key === 'symbol') return undefined
        throw new Error(`GitHub was asked (${String(key)})`)
      },
    })

  it('resolves ok, and reads owner/repo only when links.repository is read', async () => {
    const gh = throwing()
    const filter = await projectFilter(
      project,
      async () => gh,
      recipeOf(RECIPE),
      async (_state, _recipe, client) => client as never,
    )
    expect(filter.ok).toBe(true)
    if (!filter.ok) return
    expect(() => filter.links?.repository).toThrow('(owner)')

    const ordinary = { owner: 'steven-zhc', repo: 'lingtai', listBlockedBy: async () => [] } as unknown as GitHubClient
    const lazy = await projectFilter(
      project,
      async () => ordinary,
      recipeOf(RECIPE),
      async (_state, _recipe, client) => client as never,
    )
    expect(lazy.ok && lazy.links?.repository).toBe('steven-zhc/lingtai')
  })
})
