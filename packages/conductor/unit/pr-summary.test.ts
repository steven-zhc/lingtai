import { SpentFor, prStream, reducePr, ticketStream } from '@lingtai/domain'
import type { Envelope } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import type { GitHub, OpenPull } from '@lingtai/github'
import { editPrSummary, recordPrFixLanded } from '@lingtai/project'
/**
 * The `pr:` agent's summary and top-up (#1318, 0131 §2, §5): written before the draft opens, topped up after CI for each
 * pr-fix that joined, paid as a `RunSpent` on the PR's own stream, and pushed to the code host — where the person's words
 * win a race against a run.
 */
import { submitPr } from '@lingtai/project/test/submit'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BRIEF,
  SUMMARY_EXAMPLE,
  TOPUP_BRIEF,
  type PrSummarizer,
  joinedSinceSummary,
  parseSummary,
} from '../src/pr-summary.ts'
import { type PrPorts, type PrStep, IN_PROGRESS_STEPS, servePr } from '../src/pr.ts'

const team = {
  mode: 'team',
  branch: { main: 'main', personal: 'lingtai-team' },
  runtime: { agent: 'claude-code' },
} as unknown as Recipe
const FROZEN = 'f'.repeat(40)

async function landed(store: EventStore, issue: string, base = 'lingtai-team') {
  await store.append(ticketStream('lingtai', issue), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: issue,
        title: `ticket ${issue}`,
        kind: 'bug',
        labels: [],
      },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: `m${issue}`, base } },
  ])
}

interface World {
  refs: Map<string, string>
  posts: Record<string, unknown>[]
  patches: { number: number; title: string; body: string }[]
  prompts: string[]
  answer: { text: string | null; failure?: { kind: string; detail: string } }
  locked: string | null
  /** Runs in the middle of an agent run: where a person's edit lands. */
  during?: () => Promise<void>
  runs: number
  open: Record<string, boolean | null>
  pullState: OpenPull['state']
}

const aWorld = (): World => ({
  refs: new Map(),
  posts: [],
  patches: [],
  prompts: [],
  answer: { text: 'Add the thing\n\nIt does the thing, because the team needed it.' },
  locked: null,
  runs: 0,
  open: { '1': true, '2': false, '3': true },
  pullState: 'open',
})

const pull = (number: number): OpenPull => ({
  number,
  nodeId: `PR_${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  headRef: 'lingtai-team-pr-1',
  headSha: FROZEN,
  state: 'open',
  draft: true,
})

function ports(store: EventStore, w: World, options: { summarizer?: boolean } = {}): PrPorts {
  const github = {
    findOpenPull: () => Effect.succeed([] as OpenPull[]),
    openDraftPull: (input: Record<string, unknown>) => {
      w.posts.push({ ...input })
      return Effect.succeed(pull(7))
    },
    updatePull: (number: number, input: { title: string; body: string }) => {
      w.patches.push({ number, ...input })
      return Effect.void
    },
  } as unknown as GitHub
  const summarizer: PrSummarizer = {
    write: (_project, request) =>
      Effect.promise(async () => {
        w.runs++
        w.prompts.push(request.prompt)
        await w.during?.()
        return {
          turns: 3,
          durationMs: 1200,
          costUsd: 0.18,
          text: w.answer.text,
          failure: w.answer.failure ?? null,
        }
      }),
    runtimeVersion: () => Effect.succeed('1.0.0'),
    ticketBody: (_project, ticket) => Effect.succeed(`the body of ticket ${ticket}`),
    locked: () => Effect.succeed(w.locked),
  }
  return {
    store,
    recipe: () => Effect.succeed(team),
    candidates: () => Effect.succeed([{ issue: '1' }, { issue: '2' }, { issue: '3' }]),
    fetch: () => Effect.void,
    projects: () => Effect.succeed(['lingtai']),
    merge: () => Effect.succeed({ kind: 'failed', text: 'never merges' }),
    sweep: () => Effect.void,
    build: () => Effect.succeed({ kind: 'unknown', why: 'never builds' }),
    checkedOut: () => Effect.succeed(null),
    tickets: () => Effect.fail(new Error('no ticket channel')),
    github: () => Effect.succeed(github),
    facts: (_project, tickets) =>
      Effect.succeed(tickets.map((ticket) => ({ ticket, open: w.open[ticket] ?? null, spend: 0.5 }))),
    git: (_project, args) =>
      Effect.succeed(
        args[0] === 'rev-parse'
          ? { code: 0, stdout: `${FROZEN}\n`, stderr: '' }
          : args[0] === 'diff'
            ? { code: 0, stdout: ` src/${args[args.length - 1]}.ts | 2 +-\n`, stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
      ),
    remote: (_project, args) =>
      Effect.sync(() => {
        if (args[0] === 'ls-remote') {
          const lines = [...w.refs].filter(([ref]) => ref.startsWith(args[3]!)).map(([ref, sha]) => `${sha}\t${ref}`)
          return { code: 0, stdout: lines.join('\n'), stderr: '' }
        }
        const [sha, ref] = args[2]!.split(':')
        w.refs.set(ref!, sha!)
        return { code: 0, stdout: '', stderr: '' }
      }),
    ...(options.summarizer === false ? {} : { summarizer }),
  }
}

const events = (store: EventStore): Promise<Envelope[]> => store.read(prStream('lingtai', 1))
const types = async (store: EventStore) =>
  (await events(store)).map((e) => e.type).filter((t) => t !== 'PrDraftTicketAdded')
const state = async (store: EventStore) => reducePr(await events(store))
const named = (...names: string[]): PrStep[] => IN_PROGRESS_STEPS.filter((s) => names.includes(s.name))
const SUBMIT = named('summary', 'push', 'open')
const serve = (p: PrPorts, steps: readonly PrStep[] = SUBMIT) => Effect.runPromise(servePr(p, 'lingtai', 1, steps))

async function frozen(): Promise<EventStore> {
  const store = createMemoryEventStore()
  await landed(store, '1')
  await landed(store, '2')
  await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
  await Effect.runPromise(servePr(ports(store, aWorld()), 'lingtai', 1, []))
  return store
}

describe('parseSummary', () => {
  it('takes the first line as the title and the rest as the summary', () => {
    expect(parseSummary('# A title\n\nSome words.\n\nMore.\n')).toEqual({
      title: 'A title',
      summary: 'Some words.\n\nMore.',
    })
  })

  it('answers one line as a title and no summary, never an empty string', () => {
    expect(parseSummary('Only a title')).toEqual({ title: 'Only a title', summary: null })
  })

  it('cuts the title to 256 characters, and reads nothing from nothing', () => {
    expect(parseSummary('x'.repeat(400))!.title).toHaveLength(256)
    expect(parseSummary('  \n \n')).toBeNull()
    expect(parseSummary(null)).toBeNull()
  })
})

describe('the Pr spend member', () => {
  it('still parses a conflict agent’s row, and a summary row too', () => {
    const resolve = { _tag: 'Pr', purpose: 'resolve', merging: 'main', commit: 'a'.repeat(40), round: 1 }
    expect(SpentFor.parse(resolve)).toEqual(resolve)
    expect(SpentFor.parse({ _tag: 'Pr', purpose: 'summary', at: 'submit' })).toEqual({
      _tag: 'Pr',
      purpose: 'summary',
      at: 'submit',
    })
    expect(() => SpentFor.parse({ _tag: 'Pr', purpose: 'summary' })).toThrow()
  })
})

describe('the summary, at submit', () => {
  it('is written before the push, paid on the PR’s stream, and the draft opens with its title and body', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))

    const log = await events(store)
    const order = log.map((e) => e.type)
    expect(order.indexOf('PrSummaryWritten')).toBeGreaterThan(-1)
    expect(order.indexOf('PrSummaryWritten')).toBeLessThan(order.indexOf('PrPushed'))
    const spent = log.filter((e) => e.type === 'RunSpent')
    expect(spent).toHaveLength(1)
    expect(spent[0]!.data).toMatchObject({
      for: { _tag: 'Pr', purpose: 'summary', at: 'submit' },
      runtime: 'claude-code',
      costUsd: 0.18,
    })
    expect(log.find((e) => e.type === 'PrSummaryWritten')!.data).toMatchObject({
      by: 'agent',
      title: 'Add the thing',
      summary: 'It does the thing, because the team needed it.',
    })

    expect(w.posts).toHaveLength(1)
    expect(w.posts[0]).toMatchObject({ title: 'Add the thing' })
    const body = w.posts[0]!['body'] as string
    expect(body.startsWith('It does the thing, because the team needed it.')).toBe(true)
    expect(body).toContain('Closes #1')
    // No PATCH on a first submit: the draft opened with what the log holds.
    expect(w.patches).toEqual([])
    expect((await state(store)).descriptionOwed).toBe(false)
  })

  it('tells the agent each ticket’s number, title, body, merge commit and diffstat, with pr.prompt appended', async () => {
    const store = await frozen()
    const w = aWorld()
    const p = ports(store, w)
    const withPrompt = {
      ...p,
      recipe: () =>
        Effect.succeed({
          ...team,
          pr: { prompt: 'Write it for the security team.', limits: { turns: 20, wall: '5m' } },
        } as unknown as Recipe),
    }
    await serve(withPrompt)
    const prompt = w.prompts[0]!
    expect(prompt).toContain('#1 — ticket 1')
    expect(prompt).toContain('the body of ticket 2')
    expect(prompt).toContain('Merge commit: m1')
    expect(prompt).toContain('src/m2.ts | 2 +-')
    expect(prompt.trimEnd().endsWith('Write it for the security team.')).toBe(true)
  })

  it('makes no run on a second serve, a rework or a retry: what was tried is the PR’s own', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    const first = await types(store)
    await serve(ports(store, w), named('summary'))
    expect(w.runs).toBe(1)
    expect(await types(store)).toEqual(first)
  })

  it('appends PrSummaryNotWritten with the lock sentence, no RunSpent, and the PR still opens', async () => {
    const store = await frozen()
    const w = aWorld()
    w.locked = 'the day’s ceiling is reached'
    await serve(ports(store, w))
    const log = await events(store)
    expect(log.find((e) => e.type === 'PrSummaryNotWritten')!.data).toMatchObject({
      at: 'submit',
      why: 'the day’s ceiling is reached',
    })
    expect(log.some((e) => e.type === 'RunSpent')).toBe(false)
    expect(w.runs).toBe(0)
    // With no run the title is the first ticket's.
    expect(w.posts[0]).toMatchObject({ title: 'ticket 1' })
    expect((await state(store)).host).toMatchObject({ number: 7 })
  })

  it('records a reason for a run that timed out, and for one that answered nothing', async () => {
    for (const answer of [
      { text: null, failure: { kind: 'timeout', detail: 'ran out of time' } },
      { text: '   \n' },
    ] as const) {
      const store = await frozen()
      const w = aWorld()
      w.answer = answer
      await serve(ports(store, w))
      const log = await events(store)
      expect(log.some((e) => e.type === 'PrSummaryWritten')).toBe(false)
      const why = (log.find((e) => e.type === 'PrSummaryNotWritten')!.data as { why: string }).why
      expect(why.length).toBeGreaterThan(0)
      // The run was made and paid for: its spend is on the log whatever it answered.
      expect(log.filter((e) => e.type === 'RunSpent')).toHaveLength(1)
      expect(w.posts[0]).toMatchObject({ title: 'ticket 1' })
    }
  })

  it('appends nothing and runs nothing where no summarizer is wired', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w, { summarizer: false }))
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrStepDone',
      'PrPushed',
      'PrDraftOpened',
      'PrDescriptionPushed',
    ])
  })

  it('keeps a person’s edit that lands while the agent writes, and sets the agent’s text aside', async () => {
    const store = await frozen()
    const w = aWorld()
    w.during = async () => {
      await Effect.runPromise(
        editPrSummary(
          { project: 'lingtai', n: 1, mode: 'team' },
          { by: 'human:steven', summary: 'My own words.' },
          store,
        ),
      )
    }
    await serve(ports(store, w))
    const s = await state(store)
    expect(s.summary?.text).toBe('My own words.')
    const log = await events(store)
    expect(log.some((e) => e.type === 'PrSummaryWritten')).toBe(false)
    expect((log.find((e) => e.type === 'PrSummaryNotWritten')!.data as { why: string }).why).toContain('set aside')
    // The run was paid for all the same.
    expect(log.filter((e) => e.type === 'RunSpent')).toHaveLength(1)
    expect(w.posts[0]!['body'] as string).toContain('My own words.')
  })
})

describe('the top-up, after CI', () => {
  async function opened(): Promise<{ store: EventStore; w: World }> {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    return { store, w }
  }

  const landFix = async (store: EventStore) => {
    await landed(store, '3', 'lingtai-team-pr-1')
    await Effect.runPromise(
      recordPrFixLanded('lingtai', 1, { ticket: '3', mergeCommit: 'm3', title: 'ticket 3' }, store),
    )
  }

  it('runs nothing and appends nothing when no pr-fix joined since the summary', async () => {
    const { store, w } = await opened()
    const before = await types(store)
    await serve(ports(store, w), named('topup'))
    expect(w.runs).toBe(1)
    expect(await types(store)).toEqual([...before, 'PrStepDone'])
  })

  it('hands the agent the current summary and only the joining ticket, pays at pr-fix, and pushes once', async () => {
    const { store, w } = await opened()
    await landFix(store)
    w.answer = { text: 'Add the thing and fix it\n\nIt does the thing, and now it is fixed too.' }
    // `summary` makes no run at the pr-fix pass; the top-up does, once, and the description follows.
    await serve(ports(store, w), named('summary', 'topup'))

    expect(w.runs).toBe(2)
    const prompt = w.prompts[1]!
    expect(prompt).toContain('It does the thing, because the team needed it.')
    expect(prompt).toContain('#3 — ticket 3')
    expect(prompt).not.toContain('#1 — ticket 1')
    expect(prompt).not.toContain('#2 — ticket 2')

    const spent = (await events(store)).filter((e) => e.type === 'RunSpent').map((e) => e.data)
    expect(spent).toHaveLength(2)
    expect(spent[1]).toMatchObject({ for: { _tag: 'Pr', purpose: 'summary', at: 'pr-fix' } })

    expect(w.patches).toHaveLength(1)
    expect(w.patches[0]).toMatchObject({ number: 7, title: 'Add the thing and fix it' })
    expect(w.patches[0]!.body).toContain('now it is fixed too')
    expect(w.patches[0]!.body).toContain('Closes #1, Closes #3')
    const s = await state(store)
    expect(s.descriptionOwed).toBe(false)

    // A serve after it runs and pushes nothing more.
    await serve(ports(store, w), named('summary', 'topup'))
    expect(w.runs).toBe(2)
    expect(w.patches).toHaveLength(1)
  })

  it('goes on with the summary it has when locked, and still pushes the description with the new ticket', async () => {
    const { store, w } = await opened()
    await landFix(store)
    w.locked = 'paused by steven'
    await serve(ports(store, w), named('summary', 'topup'))
    expect(w.runs).toBe(1)
    const log = await events(store)
    expect(log.filter((e) => e.type === 'PrSummaryNotWritten').map((e) => e.data)).toMatchObject([
      { at: 'pr-fix', why: 'paused by steven' },
    ])
    expect(w.patches).toHaveLength(1)
    expect(w.patches[0]!.body).toContain('Closes #1, Closes #3')
    expect(w.patches[0]!.title).toBe('Add the thing')
  })
})

describe('what a run saw, and what a push rendered', () => {
  it('does not count a pr-fix that landed while the run was in flight as summarised', async () => {
    const store = await frozen()
    const w = aWorld()
    w.during = async () => {
      await landed(store, '3', 'lingtai-team-pr-1')
      await Effect.runPromise(
        recordPrFixLanded('lingtai', 1, { ticket: '3', mergeCommit: 'm3', title: 'ticket 3' }, store),
      )
    }
    await serve(ports(store, w))
    // The run saw the PR before the fix: the top-up still owes it.
    expect(joinedSinceSummary(await state(store)).map((f) => f.ticket)).toEqual(['3'])
  })

  it('leaves the description owed when an edit landed after the version the push rendered', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    const stale = (await state(store)).version
    await Effect.runPromise(
      editPrSummary({ project: 'lingtai', n: 1, mode: 'team' }, { by: 'human:steven', summary: 'B.' }, store),
    )
    await store.append(prStream('lingtai', 1), (await events(store)).length, [
      { type: 'PrDescriptionPushed', actor: 'conductor', data: { bodyHash: 'a'.repeat(64), basedOn: stale } },
    ])
    expect((await state(store)).descriptionOwed).toBe(true)
    await serve(ports(store, w), [])
    expect(w.patches.at(-1)!.body.startsWith('B.')).toBe(true)
    expect((await state(store)).descriptionOwed).toBe(false)
  })
})

describe('the person’s edit', () => {
  it('is pushed to the PR once, whatever step the PR is at, and the ticket lines are regenerated', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    const asked = await Effect.runPromise(
      editPrSummary(
        { project: 'lingtai', n: 1, mode: 'team' },
        { by: 'human:steven', summary: 'Corrected words.' },
        store,
      ),
    )
    expect(asked).toEqual({ kind: 'appended' })
    expect((await state(store)).descriptionOwed).toBe(true)

    await serve(ports(store, w), [])
    expect(w.patches).toHaveLength(1)
    expect(w.patches[0]!.title).toBe('Add the thing')
    expect(w.patches[0]!.body.startsWith('Corrected words.')).toBe(true)
    expect(w.patches[0]!.body).toContain('Closes #1')
    expect((await types(store)).at(-1)).toBe('PrDescriptionPushed')

    // Served again, nothing is owed and nothing is pushed.
    await serve(ports(store, w), [])
    expect(w.patches).toHaveLength(1)
  })

  it('is refused by name for a PR that is merged', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    await store.append(prStream('lingtai', 1), (await events(store)).length, [
      { type: 'PrMerged', actor: 'conductor', data: { how: 'host', headSha: FROZEN, mergeSha: 'c'.repeat(40) } },
    ])
    const asked = await Effect.runPromise(
      editPrSummary({ project: 'lingtai', n: 1, mode: 'team' }, { by: 'human:steven', summary: 'Too late.' }, store),
    )
    expect(asked.kind).toBe('refused')
    expect((asked as { detail: string }).detail).toContain('merged')
    expect(await types(store)).not.toContain('PrSummaryEdited')
  })
})

describe('the briefs', () => {
  it.each([
    ['BRIEF', BRIEF],
    ['TOPUP_BRIEF', TOPUP_BRIEF],
  ])('%s asks for bullets with ticket numbers, a 60-character title, and carries the example', (_name, brief) => {
    expect(brief).toContain('bullet')
    expect(brief).toContain('ticket numbers')
    expect(brief).toContain('60 characters')
    expect(brief).toContain('Review closely')
    expect(brief).toContain(SUMMARY_EXAMPLE)
    expect(brief).toContain('no Closes lines')
    expect(SUMMARY_EXAMPLE).not.toContain('Closes')
  })
})
