/**
 * **The `pr:` agent writes a PR's title and summary, and tops it up** (#1318, 0131 §2, §5).
 *
 * Two steps of In progress, one paid run each, **no tools**:
 * - `summary`, before `push`: at submit, so the draft opens with the real title and summary. It runs once per PR — what
 *   is recorded is the PR's own (`PrState.summaryTried`), not a step's, because a pr-fix pass walks the steps again and a
 *   rework never rewrites it.
 * - `topup`, after `ci` and before `ready`: when a `lingtai:pr-fix` ticket joined since the summary was tried, the agent
 *   extends the current summary with it; with nothing new the step answers `done` and spends nothing.
 *
 * **The run is recorded inside the step, not as its `record`**: `walkPr` drops a step's answer when the target moved
 * while it ran, and a run of minutes may meet a pr-fix landing. The prompt, the `RunSpent` and the answer are on the log
 * by the time the step answers, so a dropped answer is not a second run.
 *
 * **The person's words win a race**: the answer carries the version it began at (`basedOn`), and the transition that
 * appends it sets it aside for a `PrSummaryEdited` that landed later (`summaryWrittenTransition`).
 *
 * Where no `summarizer` is wired nothing here runs and nothing is appended.
 */
import { type PrState, prStream } from '@lingtai/domain'
import { readPr, recordPrRunSpent, recordPrSummaryNotWritten, recordPrSummaryWritten } from '@lingtai/project'
import { callForPr } from '@lingtai/recipe'
import { Effect, Result } from 'effect'

import type { PrDispatch, PrDispatched, PrPorts, PrStep, StepAnswer } from './pr.ts'
import { recordPrompt } from './record-prompt.ts'

/** GitHub's limit on a pull request's title. */
const TITLE_LIMIT = 256

/** What a summary run needs: one agent run **with no tools**, and the facts around it. */
export interface PrSummarizer {
  /** One run of the agent with no tools. **Not bounded like a read**: its limit is the recipe's `pr.limits`. */
  write(project: string, request: Omit<PrDispatch, 'cwd'>): Effect.Effect<PrDispatched, Error>
  /** The runtime's `--version`, or null where it could not be asked (#929). */
  runtimeVersion(project: string, runtime: PrDispatch['runtime']): Effect.Effect<string | null>
  /** A ticket's body, or the reason it could not be read. */
  ticketBody(project: string, ticket: string): Effect.Effect<string, Error>
  /** The sentence for a lock that stops new work on the project (0126 §6), or null when none does. */
  locked(project: string): Effect.Effect<string | null>
}

/** What a good answer looks like, shown to the agent in both briefs. It has no `Closes` line for the model to copy. */
export const SUMMARY_EXAMPLE = `Board traces, PR draft state, more outcome forms

- Board: traces show which page and which event stream is slow (#1359, #1360, #1361, #1362, #1375)
- PR: a PR has a draft state, and appendAll writes several streams in one transaction; nothing calls them yet (#1389, #1390)
- Daemon: a landing whose process died after the push is recorded at the next start (#1397)
- Docs: the docs are a ten-chapter book; chapters 2–3 written (#1367, #1376, #1399)

Review closely: #1398 also keeps the redo's reason across a daemon restart, wider than the ticket asked.`

export const BRIEF = `You write the title and summary of a pull request, for the team's reviewers, who read it in under a minute.

Answer as the text of the pull request and nothing else:
- the first line is the pull request's title, at most 60 characters, naming the two or three largest themes, without a leading "#";
- then one bullet per area (Board, PR, Daemon, Docs, … as the tickets suggest), each one sentence saying what is now true, ending with its ticket numbers in parentheses;
- every ticket's number appears in exactly one bullet; no transition sentences, no paragraphs;
- only when a ticket's change is wider than its title says, one last line starting "Review closely:"; otherwise no such line;
- no Closes lines: Lingtai appends them itself.

An example of the shape:

${SUMMARY_EXAMPLE}
`

export const TOPUP_BRIEF = `You keep the summary of a pull request up to date, for the team's reviewers. Below is its current text and what changed since it was written.

Keep the current summary and extend it with what changed. Answer as the whole new text of the pull request and nothing else:
- the first line is the pull request's title, at most 60 characters; it stays as it is unless it no longer fits;
- then the bullets: add a bullet for what changed, or add its ticket numbers to an existing bullet — never a paragraph;
- every ticket's number appears in exactly one bullet; a "Review closely:" line only when a ticket's change is wider than its title says;
- no Closes lines: Lingtai appends them itself.

An example of the shape:

${SUMMARY_EXAMPLE}
`

/**
 * The agent's answer as a title and a summary: the first non-empty line, without a leading `#`, is the title (cut to
 * GitHub's limit); the rest, trimmed, is the summary. **One line is a title and no summary** — never an empty string; an
 * answer with nothing in it is null.
 */
export function parseSummary(text: string | null): { title: string; summary: string | null } | null {
  if (text === null) return null
  const lines = text.trim().split(/\r?\n/)
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1) return null
  const title = (lines[first] ?? '')
    .trim()
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, TITLE_LIMIT)
    .trim()
  if (title === '') return null
  const rest = lines
    .slice(first + 1)
    .join('\n')
    .trim()
  return { title, summary: rest === '' ? null : rest }
}

type Item = { readonly ticket: string; readonly mergeCommit: string; readonly title: string }

/** One ticket as the prompt tells it: number, title, body, merge commit and its diffstat. A part that cannot be read says so. */
const describeItem = (ports: PrPorts, summarizer: PrSummarizer, project: string, item: Item) =>
  Effect.gen(function* () {
    const body = yield* summarizer.ticketBody(project, item.ticket).pipe(
      Effect.map((text) => text.trim()),
      Effect.catch((err: unknown) =>
        Effect.succeed(`(the body could not be read: ${err instanceof Error ? err.message : String(err)})`),
      ),
    )
    const stat = yield* ports
      .git(project, [
        'diff',
        '--stat',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        `${item.mergeCommit}^1`,
        item.mergeCommit,
      ])
      .pipe(
        Effect.map((a) => (a.code === 0 ? a.stdout.trim() : `(the diffstat could not be read: git exited ${a.code})`)),
        Effect.catch((err: unknown) =>
          Effect.succeed(`(the diffstat could not be read: ${err instanceof Error ? err.message : String(err)})`),
        ),
      )
    return [
      `## #${item.ticket} — ${item.title}`,
      `Merge commit: ${item.mergeCommit}`,
      '',
      body === '' ? '(no body)' : body,
      '',
      'Diffstat:',
      stat === '' ? '(empty)' : stat,
    ].join('\n')
  })

/** One paid run, from the lock check to the record of its answer. Answers the step's `done`. */
const runSummary = (context: {
  project: string
  n: number
  ports: PrPorts
  summarizer: PrSummarizer
  at: 'submit' | 'pr-fix'
}): Effect.Effect<StepAnswer, Error> =>
  Effect.gen(function* () {
    const { project, n, ports, summarizer, at } = context
    const first = yield* readPr(project, n, ports.store)
    const target = first?.target ?? first?.frozenSha ?? ''
    const done: StepAnswer = { kind: 'done', headSha: target }
    if (first === null) return { kind: 'again' } as StepAnswer
    const notWritten = (why: string) =>
      recordPrSummaryNotWritten(project, n, { at, why, basedOn: first.version }, ports.store).pipe(Effect.as(done))

    const recipe = yield* ports.recipe(project)
    const call = callForPr(recipe)
    if (call.agent === null) {
      return yield* notWritten(
        `${recipe.runtime.agent} cannot run with no tools, and pr.agent names no other: no summary was written`,
      )
    }
    const locked = yield* summarizer.locked(project)
    if (locked !== null) return yield* notWritten(locked)

    // The version this run began at, read before the prompt is built: an edit after it is the person's, and wins.
    const basedOn = first.version
    // Told from what this read holds, so what `basedOn` claims covered is what the prompt held.
    const items: readonly Item[] = at === 'submit' ? first.tickets : joinedSinceSummary(first)
    const others = outsideSinceSummary(first)
    if (items.length === 0 && others.length === 0) return done
    const told = yield* Effect.forEach(items, (item) => describeItem(ports, summarizer, project, item))
    const conflicts =
      at === 'submit'
        ? first.resolutions.map(
            (r) =>
              `- a conflict with main at ${r.mainCommit.slice(0, 7)} was resolved by the conflict agent (merge ${r.head.slice(0, 7)})`,
          )
        : []
    const current =
      first.summary === null
        ? ''
        : [first.summary.title ?? '', first.summary.text ?? ''].filter((p) => p !== '').join('\n\n')
    const prompt = [
      at === 'submit' ? BRIEF : TOPUP_BRIEF,
      ...(at === 'pr-fix' ? ['\n# The current text\n', current === '' ? '(none yet)' : current, ''] : []),
      at === 'submit' ? '\n# The tickets\n' : '\n# What changed since: the tickets that joined\n',
      told.join('\n\n'),
      ...(conflicts.length === 0 ? [] : ['\n# Conflicts resolved on this PR\n', conflicts.join('\n')]),
      ...(others.length === 0
        ? []
        : ['\n# Commits others pushed to the PR branch, merged in\n', outsideLines(others).join('\n')]),
      ...(call.prompt === undefined ? [] : ['\n', call.prompt]),
    ].join('\n')

    const spentFor = { _tag: 'Pr', purpose: 'summary', at } as const
    const version = yield* summarizer.runtimeVersion(project, call.agent).pipe(Effect.orElseSucceed(() => null))
    yield* Effect.promise(() =>
      recordPrompt(
        ports.store,
        prStream(project, n),
        { for: spentFor, promptVersion: `pr-summary@${prompt.length}`, runtimeVersion: version, prompt },
        ports.log,
      ),
    )
    const outcome = yield* summarizer
      .write(project, {
        runtime: call.agent,
        ...(call.model === undefined ? {} : { model: call.model }),
        prompt,
        runId: `pr-${project}-${n}:summary:${at}:${first.summaryTried ?? 0}`,
        limits: { turns: call.turns, wallMs: call.wallMs },
      })
      .pipe(Effect.result)
    // A run that threw returned no outcome, and a killed process has nothing to record (0110 §2).
    if (Result.isFailure(outcome))
      return yield* notWritten(`the run did not finish (crash): ${outcome.failure.message}`)
    const ran = outcome.success
    // A `RunSpent` that cannot be appended is said and the summary is still used, as a discussion's is.
    yield* recordPrRunSpent(
      project,
      n,
      {
        for: spentFor,
        runtime: call.agent,
        turns: ran.turns,
        durationMs: ran.durationMs,
        costUsd: ran.costUsd,
        usage: ran.usage ?? [],
      },
      ports.store,
    ).pipe(
      Effect.catch((err: Error) =>
        Effect.sync(() => ports.log?.(`pr ${project} PR ${n}: the summary's RunSpent was lost: ${err.message}`)),
      ),
    )
    if (ran.failure !== null) {
      return yield* notWritten(`the run did not finish (${ran.failure.kind}): ${ran.failure.detail}`)
    }
    const parsed = parseSummary(ran.text)
    if (parsed === null) return yield* notWritten('the agent answered nothing')
    yield* recordPrSummaryWritten(
      project,
      n,
      { by: 'agent', at, title: parsed.title, summary: parsed.summary, basedOn },
      ports.store,
    )
    return done
  })

/**
 * The pr-fix tickets owed a top-up: those that joined after the summary was last tried. None before it was tried — the
 * summary step has the whole PR to tell then.
 */
export const joinedSinceSummary = (state: PrState): readonly Item[] =>
  state.summaryTried === null ? [] : state.fixesLanded.filter((f) => f.version > (state.summaryTried ?? 0))

/** The merges of commits others pushed to the PR branch since the summary was tried (#1353); all of them before it was. */
export const outsideSinceSummary = (state: PrState): PrState['outsideMerged'] =>
  state.summaryTried === null
    ? state.outsideMerged
    : state.outsideMerged.filter((m) => m.version > (state.summaryTried ?? 0))

/** The commits others pushed, as the prompt tells them. */
const outsideLines = (merges: PrState['outsideMerged']): string[] =>
  merges.flatMap((m) => [
    ...m.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject} (${c.author})`),
    ...(m.omitted > 0 ? [`- … and ${m.omitted} more`] : []),
  ])

/** `summary`: once per PR, before `push`. Absent a summarizer, or tried already, it answers `done` and does nothing. */
export const summaryStep: PrStep = {
  name: 'summary',
  run: ({ project, n, state, ports }) =>
    Effect.gen(function* () {
      const target = state.target ?? state.frozenSha ?? ''
      const summarizer = ports.summarizer
      if (summarizer === undefined || state.summaryTried !== null)
        return { kind: 'done', headSha: target } as StepAnswer
      return yield* runSummary({ project, n, ports, summarizer, at: 'submit' })
    }),
}

/** `topup`: after `ci`, when a pr-fix joined since the summary was tried; otherwise `done`, no run, nothing appended. */
export const topupStep: PrStep = {
  name: 'topup',
  run: ({ project, n, state, ports }) =>
    Effect.gen(function* () {
      const target = state.target ?? state.frozenSha ?? ''
      const summarizer = ports.summarizer
      // A round with only others' commits merged in is still a top-up (#1353).
      const joined = joinedSinceSummary(state)
      if (summarizer === undefined || (joined.length === 0 && outsideSinceSummary(state).length === 0))
        return { kind: 'done', headSha: target } as StepAnswer
      return yield* runSummary({ project, n, ports, summarizer, at: 'pr-fix' })
    }),
}
