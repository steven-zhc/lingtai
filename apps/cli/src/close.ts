import { userInfo } from 'node:os'

/**
 * `lingtai close <project> --issue <n> "<reason>"` — a ticket nobody is going
 * to do, ended on the log (#151).
 *
 * A wrapper over `close()` in `@lingtai/conductor` and nothing more, for the
 * reason `ask` gives: one decision, one function, whichever side asks.
 *
 * **It holds a projector**, for `withProjector`'s rule — this moves a card the
 * board is showing, out of every lane and into the archive.
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
import { close, loadProject } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { hasGitHubApp } from '@lingtai/env'

import { withProjector } from './projector.ts'
import { VERBS, fromOutcome, logVerdict, refusal, type Answered } from './verdict.ts'

export interface CloseCommandOptions {
  project: string
  issue: number
  /** Why. Refused when blank — this decision is the one nothing reverses. */
  reason: string
  by?: string
}

export async function closeVerdict(options: CloseCommandOptions, progress: (line: string) => void): Promise<Answered> {
  if (!options.reason.trim()) {
    return refusal(2, 'blank', `lingtai close <project> --issue <n> "<reason>" — nothing lifts a close, so say why`)
  }

  const project = await loadProject(options.project)
  if (!project?.owner) {
    return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
  }
  if (!hasGitHubApp()) {
    return refusal(
      1,
      'no-github-app',
      'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
    )
  }

  const { client, resolved } = await projectClient(project)

  return withProjector(progress, async (): Promise<Answered> => {
    // The local account, as `requeue`, `ask` and the board record it (0007).
    const by = options.by ?? `human:${userInfo().username}`
    const outcome = await close({
      project: options.project,
      issue: options.issue,
      reason: options.reason,
      by,
      state: project,
      client,
      recipe: async () => resolved,
    })
    return fromOutcome(outcome)
  })
}

export async function closeCommand(options: CloseCommandOptions, log = console.log): Promise<number> {
  return logVerdict(VERBS['close'], await closeVerdict(options, log), log)
}
