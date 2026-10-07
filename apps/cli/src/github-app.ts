/**
 * The GitHub App step (#393): asked only for a GitHub project, and waited for
 * with a deadline and a way to skip — never the unconditional, no-deadline
 * wait `init.ts` used to open with.
 *
 * Declares the slice of the world it needs rather than depending on
 * `InitWorld`, the way `question.ts` does (`question.ts:8-10`), so `lingtai
 * add`'s GitHub branch (#394) can call `askFirstProject` and `waitForApp` too.
 */
import { paint } from '@lingtai/env/colour'

import { question, type QuestionWorld } from './question.ts'

/** A person reading GitHub's manifest page gets this long before coming back. */
export const APP_WAIT_MS = 10 * 60_000

export type FirstProject = { project: 'local' } | { project: 'github'; app: 'create' | 'skip' } | { refused: string }

/**
 * At most two seam questions, asked through `question()` (#392) and writing
 * nothing. Call this only when no App is configured yet — a configured App
 * already says the project is GitHub, and nothing here is asked about it.
 *
 * `kept` defaults to `init.ts`'s own sentence, since that was this function's
 * only caller before #394: it is called once the store is already written, so
 * a refusal here cannot say "Nothing was written" — that line is
 * `question()`'s default, written for a question asked before any write
 * exists. `lingtai add` (`first-project.ts`) has no store to report kept, and
 * passes its own `'Nothing was written'` instead (#394 finding 5).
 */
export async function askFirstProject(
  world: QuestionWorld,
  flags: Record<string, string>,
  kept = 'the store chosen above is kept',
): Promise<FirstProject> {
  const kind = await question(world, {
    name: 'the project',
    flag: '--project github, or --project local',
    given: flags['project'] ?? null,
    prompt: 'a GitHub project, or one on this machine only',
    fallback: 'github',
    choices: ['github', 'local'],
    kept,
  })
  if ('refused' in kind) return { refused: kind.refused }
  if (kind.answer === 'local') {
    // The same rule `chooseStore` holds to for `--store`: a flag naming
    // anything else is refused rather than silently discarded (#393) — and
    // `--github-app` names something `local` never asks for.
    if (flags['github-app'] !== undefined) {
      return {
        refused:
          `--github-app ${flags['github-app']}, but --project local creates no GitHub App. Leave out ` +
          `--github-app, or pass --project github. ${kept}`,
      }
    }
    return { project: 'local' }
  }

  const how = await question(world, {
    name: 'the GitHub App',
    flag: '--github-app create, or --github-app skip',
    given: flags['github-app'] ?? null,
    prompt: 'create the GitHub App now, or skip it for later',
    fallback: 'create',
    choices: ['create', 'skip'],
    kept,
  })
  if ('refused' in how) return { refused: how.refused }
  return { project: 'github', app: how.answer as 'create' | 'skip' }
}

export interface AppWaitWorld {
  log: (line: string) => void
  open: (url: string) => Promise<boolean>
  /** Resolves once an App is configured and answers; stops polling on abort. */
  appeared: (signal: AbortSignal) => Promise<{ slug: string; owner: string }>
  /** Resolves on any keypress at a TTY; never, at no TTY, until aborted. */
  pressed: (signal: AbortSignal) => Promise<void>
}

export type AppWaitResult = { made: { slug: string; owner: string } } | { skipped: true } | { timedOut: true }

/** The come-back line: nothing is lost at a skip or a timeout, because the App's key is the board's to write, not init's. */
export function appComeBackLine(boardUrl: string, reason: string): string {
  return paint.signal(
    `app          not created (${reason}) — create it at ${boardUrl}/setup/github-app while this board runs, ` +
      'or run lingtai init again',
  )
}

function describeWait(waitMs: number): string {
  const minutes = waitMs / 60_000
  return minutes >= 1
    ? `no answer in ${Math.round(minutes)} minutes`
    : `no answer in ${Math.max(1, Math.round(waitMs / 1000))}s`
}

/**
 * Opens the browser on the manifest flow, prints the URL whether or not that
 * worked, and races three things: the App appearing, any key being pressed,
 * and `waitMs`. Always lets `init` go on — a skip or a timeout logs the one
 * come-back line rather than leaving anything looking lost.
 */
export async function waitForApp(
  world: AppWaitWorld,
  boardUrl: string,
  { waitMs }: { waitMs: number },
): Promise<AppWaitResult> {
  const wizard = `${boardUrl}/setup/github-app`
  world.log(
    (await world.open(wizard))
      ? paint.pass(`opened ${wizard}`)
      : paint.signal(`no browser could be opened here — open ${wizard}`),
  )
  world.log(paint.signal('waiting for the App — press Create on that page, or any key here to skip'))

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: { made: { slug: string; owner: string } } | 'skipped' | 'timedOut'
  try {
    const timedOut = new Promise<'timedOut'>((resolve) => {
      timer = setTimeout(() => resolve('timedOut'), waitMs)
    })
    const settled = Promise.race([
      world.appeared(controller.signal).then((made) => ({ made }) as const),
      world.pressed(controller.signal).then(() => 'skipped' as const),
    ])
    result = await Promise.race([settled, timedOut])
  } finally {
    // The race's loser, whichever it was: a timer left running would fire
    // into a board that may have moved on, and a signal left live would leave
    // `pressed`'s raw mode never undone.
    controller.abort()
    clearTimeout(timer)
  }

  if (typeof result === 'object') {
    world.log(paint.pass(`app          ${result.made.slug}, owned by ${result.made.owner} — it answered`))
    return result
  }
  if (result === 'skipped') {
    world.log(appComeBackLine(boardUrl, 'skipped'))
    return { skipped: true }
  }
  world.log(appComeBackLine(boardUrl, describeWait(waitMs)))
  return { timedOut: true }
}
