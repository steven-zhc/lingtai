import { userInfo } from 'node:os'

/**
 * `lingtai close <project> --issue <n> "<reason>"` — a ticket nobody is going
 * to do, ended on the log (#151).
 *
 * A wrapper over `close()` in `@lingtai/conductor` and nothing more, for the
 * reason `ask` gives: one decision, one function, whichever side asks.
 *
 * **It holds no projector** (0100 §13): the conductor lock's holder is the
 * board's only writer, so it says when none is up.
 *
 * **It brings a client, so the `end` point can run** (0044). What the issue
 * itself ends up as is the recipe's call — a `close: true` action at `end` with
 * `when: closed` or `when: any` closes it — and Lingtai's own labels come off
 * either way. Without the client this would append a terminal and leave a
 * configured point unresolved, which is the silence the point exists to stop;
 * it is also the manual step that made `lingtai close` half a command, since
 * somebody still had to run `gh issue close` afterwards.
 *
 * No GitHub App configured is a refusal here rather than a quiet half-close,
 * for the same reason `lingtai approve` refuses.
 */
import { closeEffect } from '@lingtai/conductor/close'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { loadProjectEffect } from '@lingtai/conductor/projects'
import { hasGitHubAuth } from '@lingtai/env'
import { Effect } from 'effect'

import { noteConductor } from './conductor-note.ts'
import { VERBS, fromOutcome, logVerdict, refusal, type Answered } from './verdict.ts'

export interface CloseCommandOptions {
  project: string
  issue: number
  /** Why. Refused when blank — this decision is the one nothing reverses. */
  reason: string
  by?: string
}

export function closeVerdict(
  options: CloseCommandOptions,
  progress: (line: string) => void,
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    if (!options.reason.trim()) {
      return refusal(2, 'blank', `lingtai close <project> --issue <n> "<reason>" — nothing lifts a close, so say why`)
    }

    const project = yield* loadProjectEffect(options.project)
    if (!project?.owner) {
      return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    }
    if (!hasGitHubAuth()) {
      return refusal(
        1,
        'no-github-app',
        'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
      )
    }

    const { client, resolved } = yield* projectClientEffect(project)

    const append = Effect.gen(function* () {
      // The local account, as `requeue`, `ask` and the board record it (0007).
      const by = options.by ?? `human:${userInfo().username}`
      const outcome = yield* closeEffect({
        project: options.project,
        issue: options.issue,
        reason: options.reason,
        by,
        state: project,
        client,
        // A value already held, handed over as the seam's promise thunk: no IO hides here.
        recipe: () => Promise.resolve(resolved),
      })
      return fromOutcome(outcome)
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* noteConductor(progress)
    return answered
  })
}

export function closeCommand(options: CloseCommandOptions, log = console.log): Effect.Effect<number, unknown> {
  return Effect.map(closeVerdict(options, log), (answered) => logVerdict(VERBS['close'], answered, log))
}
