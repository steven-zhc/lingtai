/**
 * How this machine reaches GitHub, asked once (ADR 0114 §1, #710): the saved
 * `gh` login, or Lingtai's own App.
 *
 * Declares the slice of the world it needs rather than depending on
 * `InitWorld`, the way `github-app.ts` does, so `init` and `add` both reach it
 * through `runGithubBranch`.
 *
 * **Asked on every run** (0125 §9): the machine list's GitHub entry defaults to what is in force and the
 * runner writes the answer, so this file only asks. An exported `LINGTAI_GITHUB_AUTH` is in force and is
 * never asked.
 *
 * **`gh` is checked, not trusted** — whether it came from the flag or from the
 * terminal: signed out, or without `repo` and `workflow`, it is refused with
 * the command that fixes it, and `github.auth: gh` is not written.
 */
import { paint } from '@lingtai/env/colour'
import { ghScopeGap, type GhRun, type GhStatus } from '@lingtai/github'
import {
  type Asker,
  type AskerAnswer,
  ghNotReady,
  liveMachineText,
  type MachineText,
  writeGithubAuth,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { lift } from './exit.ts'
import { questionEffect, type QuestionWorld } from './question.ts'

export interface GithubAuthWorld extends QuestionWorld {
  github: {
    /** `gh auth status`, as a value — asked when the question is, or `--github-auth gh` is given. */
    ghStatus: () => Effect.Effect<GhStatus, unknown>
    /**
     * `gh` with the terminal handed over (#712). Present only where there is one,
     * so its presence is how the question knows it may offer to sign in.
     */
    gh?: GhRun
  }
}

/**
 * What `github.auth` is once this machine's question is answered; `pending`: `app` was chosen and is
 * written only once the App exists — an `app` written ahead of one would make `add` take an App check
 * that throws rather than answering "not installed".
 */
export type GithubAuthAnswer = { auth: 'gh' | 'app' | 'none'; pending: boolean } | { refused: string }

export { liveMachineText, type MachineText, writeGithubAuth }

/**
 * The terminal's asker for the machine list's GitHub entry. **It always asks** (0125 §9): the default is
 * what is in force, else the system's, and the answer is the runner's to write.
 */
export function githubAuthAsker(world: GithubAuthWorld, cancel: { command?: string } = {}): Asker {
  return (d) =>
    Effect.gen(function* () {
      const kept = d.kept
      const common = {
        name: d.question.name,
        flag: d.question.flag,
        given: null,
        kept,
        validate: d.question.validate,
        ...(d.startOver === undefined ? {} : { startOver: d.startOver }),
        ...cancel,
      }
      let current = yield* world.github.ghStatus()
      for (;;) {
        const why = ghNotReady(current)
        if (why === null && current.ok) {
          const asked = yield* questionEffect(world, {
            ...common,
            prompt:
              `gh, signed in as ${current.login} — Lingtai's labels, comments, pull requests and pushes will appear as ` +
              'that account — app, its own GitHub App — or none, no GitHub on this machine',
            fallback: d.default ?? 'gh',
            choices: ['gh', 'app', 'none'],
          })
          return asked
        }
        const args = signInArgs(current)
        const canSignIn = world.github.gh !== undefined && args !== null
        world.log(paint.signal(`github       gh cannot be used yet — ${why!.replace(/, and run this again$/, '')}`))
        const fallback = d.default === 'app' || d.default === 'none' ? d.default : canSignIn ? 'sign-in' : 'app'
        const asked: AskerAnswer = yield* questionEffect(world, {
          ...common,
          // `gh` is not offered a validate here: choosing it without signing in is refused below, by the reason.
          validate: (answer) => (answer === 'sign-in' ? Effect.succeed(null) : d.question.validate(answer)),
          prompt: canSignIn
            ? `sign-in, to sign gh in now (\`gh ${args.join(' ')}\`) — app, a GitHub App of its own — or none`
            : 'app, a GitHub App of its own — none, no GitHub on this machine — or gh, once you have fixed the above and run this again',
          fallback,
          choices: canSignIn ? ['sign-in', 'app', 'none'] : ['app', 'none', 'gh'],
        })
        if ('refused' in asked) return asked
        if (asked.answer === 'app' || asked.answer === 'none') return asked
        if (!canSignIn) return { refused: `gh was chosen, but ${why}. ${kept}` }

        world.log(`github       handing the terminal to gh: gh ${args.join(' ')}`)
        // `gh` shares the foreground process group, so Ctrl+C reaches it; init
        // ignores its own copy and comes back to the choice (0121 §10: the command owns the process).
        const ignore = () => {}
        const result = yield* Effect.acquireUseRelease(
          Effect.sync(() => void process.on('SIGINT', ignore)),
          () => lift(() => world.github.gh!(args, { stdio: 'inherit' })),
          () => Effect.sync(() => void process.off('SIGINT', ignore)),
        )
        current = yield* world.github.ghStatus()
        if (!('missing' in result) && result.code === 0 && current.ok && ghNotReady(current) === null) {
          world.log(`github       gh, signed in as ${current.login}`)
          return { answer: 'gh' }
        }
        world.log(
          'missing' in result
            ? 'github       gh is not installed'
            : result.code !== 0
              ? `github       gh ${args[0]} ${args[1]} exited ${result.code}`
              : 'github       gh signed in, but it is still not usable',
        )
      }
    })
}

/** The `gh` command that moves this status towards ready, or null where signing in cannot change it (#712). */
function signInArgs(status: GhStatus): string[] | null {
  if (status.ok) {
    return ghScopeGap(status) === null
      ? null
      : ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow']
  }
  return status.reason === 'signed-out' || status.reason === 'no-account'
    ? ['auth', 'login', '--hostname', 'github.com', '--web', '--scopes', 'workflow']
    : null
}
