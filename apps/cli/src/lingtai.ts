#!/usr/bin/env node
/**
 * `lingtai` — the entry point.
 *
 * Deliberately hand-rolled argument parsing. design.md §8 is a list of things
 * not being built until a specific failure demands them, and a dependency for
 * three subcommands is exactly the kind of thing it is warning about.
 *
 * Everything here loads `@lingtai/event-store`, which loads the environment from
 * the repository root — see `packages/event-store/src/env.ts`. Never read
 * `process.env` for a connection string directly.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { hostname } from 'node:os'

import { describeFilters, loadProjects, projectFilters } from '@lingtai/conductor'
import {
  clientsForProjects,
  createStatusTable,
  createWorkLoop,
  describeInFlight,
  inFlight,
  readCodeVersion,
  readControl,
  readStatus,
  recordStart,
  reconcile,
  requestRun,
  requestShutdown,
  requestShutdownUnlessStanding,
  resumeConductor,
  withdrawShutdown,
  controlWatermark,
  startAfter,
  HEARTBEAT_MS,
  startBeacon,
  startDaemon,
  type CodeVersion,
  type ShutdownRequest,
} from '@lingtai/daemon'
import { BOARD_PORT, boardPort, githubApp } from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import { createFileLocker } from '@lingtai/env/lock'
import { createGitHubClient, installationForRepo, parseSlug } from '@lingtai/github'
import { createProjectionRunner, projectionLag } from '@lingtai/projector'
import { backlogProjection, taskViewProjection } from '@lingtai/projector'
import { diskFiles, parseDuration, readRecipeKey, recipePath, setRecipe } from '@lingtai/recipe'

import { askAgents } from './agents.ts'
import { approveCommand } from './approve.ts'
import { answerCommand, askCommand } from './ask.ts'
import { attach } from './attach.ts'
import { backlogCommand } from './backlog.ts'
import {
  boardCommand,
  boardEntry,
  boardLock,
  boardPortOrWhy,
  builtBoardDir,
  parseBoardArgs,
  serveBoard,
  type BoardWorld,
} from './board.ts'
import { closeCommand } from './close.ts'
import { conductorPass } from './conduct.ts'
import { answerOutstanding, onDiscussionRequested } from './discuss.ts'
import { daemonLiveness, doctorReport, formatReport } from './doctor.ts'
import { endReplay } from './end.ts'
import { envCommand } from './env.ts'
import { chooseFirstProject, liveFirstProjectWorld } from './first-project.ts'
import { configPath } from './init.ts'
import { releaseCheck } from './install.ts'
import { askLanding, askLimits, liveQuestionWorld } from './landing.ts'
import { pauseCommand } from './pause.ts'
import { liveAsk, type QuestionWorld } from './question.ts'
import { requeueCommand } from './requeue.ts'
import {
  openDaemon,
  parseRestartArgs,
  prepareRestart,
  queueForTheLock,
  startRecorder,
  restartSupervised,
} from './restart.ts'
import { run as runOnceCommand } from './run.ts'
import { askRuntimes } from './runtimes.ts'
import { BOARD_JOB, keeper, serviceCommand, type ServiceOptions } from './service.ts'
import { askKinds, askTickets, liveHistory } from './source.ts'
import { status } from './status.ts'
import { createSubjectResolver, createSubscriberSet } from './subscribers.ts'
import { ticketClose, ticketEdit, ticketList, ticketNew } from './ticket.ts'
import { versionLine } from './version.ts'
import { WALL_LIMIT } from './wall-limit.ts'

/**
 * Every projection this system runs, named here in the open.
 *
 * A second one exists now (`finding_backlog`, `#137`), and the comment in
 * `projectionCommand` says where it has to be added: here, visibly, or it
 * does not exist.
 */
const PROJECTIONS = [taskViewProjection, backlogProjection] as const

const USAGE = `lingtai — event-sourced scheduler for autonomous code agents

  lingtai init                      a bare machine to the board, on the wizard:
                                git and the agents looked at, a Postgres URL
                                connected to and its tables made,
                                ~/.lingtai/config.yml written. Run it again to
                                continue, or to see what is set
    --store <sqlite|postgres>   the store, instead of being asked — what a
                                script or installer with no terminal gives.
                                postgres takes --database-url with it
    --database-url <url>        instead of being asked
    --port <n>                  the board's port, for this run. default: 17820,
                                or board.port in ~/.lingtai/config.yml
  lingtai add [<owner>/<repo>]      onboard a GitHub repository the App is installed
                                on, or — with no argument, or --local <dir> —
                                a directory on this machine with its own origin
    --github <owner>/<repo>     same as the positional
    --local <dir>                a directory on this machine instead of GitHub
    --project <github|local>    answers the question above without a slug or
                                --local, when neither is given
    --github-app <create|skip>  create or skip the App, asked only when none
                                is configured yet
    --base <branch>             github: where to *read the recipe from*, not
                                what the base is — the recipe's own repo.base
                                says that, and a --base contradicting it is
                                refused. local: the branch the recipe governs,
                                asked for if not given.
                                default: the repository's own default branch
    --tickets <github|db>       where this project's tickets come from, instead
                                of being asked. github: this repository's own
                                issues. db: Lingtai's own table — the only
                                answer a local project takes, and the only one
                                a project already asked this is kept at (#396)
    --kinds <a,b,c>             which labels are work, comma-separated, first
                                taken first, instead of being asked.
                                default: bug, feature, documentation
    --agent <claude-code|codex> which agent writes the change, instead of
                                being asked — where the project already has a
                                recipe. A fresh project is asked nothing here
                                either way (#398)
    --model <name>              the writer's model, instead of being asked
    --reviewer <agent|none>     a cold reviewer, and which agent, or none,
                                instead of being asked
    --reviewer-model <name>     the reviewer's model, instead of being asked
    --land <branch|hold>        where a pass lands, or hold every pass for a
                                person at proposed, instead of being asked
    --rounds <n>                fix rounds a pass may buy, instead of being asked
    --wall <duration>           wall time per agent run, e.g. 1h, instead of
                                being asked
    --budget <usd>              a dollar ceiling per agent run, instead of
                                being asked
  lingtai run <project>             take the queue, in the recipe's priority order
    --issue <n>                 one nominated issue instead of the queue
    --max <n>                   stop after n items (--max 2 is Phase 2's bar)
    --once                      the same as --max 1
    --no-merge                  stop after the steps and ask before merging

  the decisions — each the one the board's card takes, recorded the same way:
  lingtai approve <project> --issue <n>
                                merge what a held run produced, if its head has
                                not moved since the approval was asked for
    --note <text>               recorded with the approval, and required when
                                a step still refuses the head: approving then
                                waives each refusing step, with this as why
  lingtai requeue <project> --issue <n> --note <why>
                                end the wait with a new run instead: a blocked
                                item goes back to the queue — held for approval
                                or not — and the next pass cuts a fresh branch
                                from a base that has since moved. --note is
                                required — a person overruling a block is not
                                anonymous
  lingtai backlog [project]         the minor findings passing steps raised, open
    --all                       decided ones too, and what was decided
  lingtai backlog accept <project> <key> --kind <kind>
                                open one as an issue through the ticket store.
                                One key: there is no accept-all
    --unheld                    without agent:hold, so the next pass may take it
                                Without --kind, opens the issue of an entry
                                already accepted — safe to repeat, never a second
  lingtai backlog decline <project> <key> --reason <why>
                                recorded, so the next attempt does not ask again
  lingtai close <project> --issue <n> "<reason>"
                                a ticket nobody is going to do, ended: the queue
                                stops offering it because the log says it is
                                over. Nothing lifts a close — if the work is
                                wanted again, open a new ticket
  lingtai ticket list               a project's own tickets — only for a project
                                whose recipe keeps them in Lingtai's database
                                (source.tickets: db); a GitHub-backed project's
                                are read with gh issue list instead. Open ones,
                                by default
    --all                       the closed ones too, marked closed
    --project <p>               required with more than one project registered
  lingtai ticket close <n>          closes that row in the table — not lingtai
                                close, which ends a work item on the log; this
                                changes nothing there. The daemon drops a
                                closed ticket on its next sweep, not at once
    --project <p>               as above
  lingtai ticket new                opens $VISUAL or $EDITOR on a short text
                                form — a title, a labels: line, then the body.
                                Saving creates the ticket; quitting with the
                                form unchanged does nothing. No kind label in
                                labels: and the ticket is still created, with
                                a warning that the queue will not take it
    --project <p>               as above
  lingtai ticket edit <n>           the same form, started from the ticket.
                                Saving writes only the fields that changed
    --project <p>               as above
  lingtai ask <project> --issue <n> "<question>"
                                hold a ticket on a decision before any run
                                claims it: nothing is spent, the queue passes
                                over it, and lingtai status prints the question
  lingtai answer <project> --issue <n> "<choice>"
                                answer it on the record: back in the queue, and
                                every attempt at the ticket is told the answer
                                — no editing the issue body
  lingtai attach <runId>            follow a run's log — what it is doing, as it
                                does it, from the beginning however late you
                                attach. Reads a file and asks nothing of the
                                daemon or the database, so it answers on a
                                stopped system and on a run that is long over.
                                A landed run has no log: 0034 keeps exactly the
                                ones still owed an explanation
  lingtai board start               serve the board pnpm build wrote beside this
                                CLI, in this process: the URL is printed and a
                                browser opened, and ctrl-c stops it. A port
                                somebody already holds is said in words. From
                                the source there is no built board:
                                pnpm --filter @lingtai/board dev
    --port <n>                  default 17820, or board.port in
                                ~/.lingtai/config.yml
    --dir <path>                a built board somewhere else
    --no-open                   no browser — what the service's job passes
  lingtai board stop                stop the board this machine is running. Not
                                shutdown: that means finish the pass in flight
                                and waits for it, and a board has no pass to
                                finish. Where a supervisor keeps the board, this
                                is its stop and the board stays stopped until
                                lingtai service start
  lingtai board restart             stop, then start. Unlike lingtai restart it
                                refuses nothing first — no commit to check, no
                                worktree, no doctor: a UI at the wrong commit
                                costs a reload
  lingtai board status              who serves it, whether a board answers, and
                                whether a supervisor keeps one — three facts,
                                none concluded from another
  lingtai status [project]          what is runnable, and what is holding the rest
    --all                       include items that have left the queue
                                and why. Takes nothing and claims nothing.
  lingtai doctor                    check everything that can be checked
  lingtai env set <project> KEY=VALUE
                                write one value into ~/.lingtai/env/<project>.env
  lingtai env set <project> KEY     read the value from stdin, unechoed
  lingtai env list <project>        names and which layer answered — never values
  lingtai env unset <project> KEY   remove one
  lingtai end replay [project]      resolve the end step for items that landed
    --issue <n>                 without it, and deliver what it resolves to
  lingtai start                     hold the projections current and take work.
                                Reads no standing signal: a pause or a shutdown
                                aimed at an earlier daemon was not aimed at this
                                one, so nothing has to be lifted first. If
                                another daemon holds the lock this starts
                                nothing and says so. Unchecked — lingtai restart
                                is the checked start
    --no-conduct                projections only, take nothing
    --no-merge                  as for lingtai run
  lingtai service install|start|shutdown [why]|restart [why]|status|uninstall
                                keep both processes running — the daemon and the
                                board, two jobs: a LaunchAgent each on macOS, a
                                systemd user unit each on Linux. No service
                                manager? run lingtai daemon and lingtai board
                                start in the foreground.
                                shutdown drains the conductor through the log,
                                waits for the pass, unloads it, and then stops
                                the board, which has nothing to drain; restart
                                is that and start, unchecked — lingtai restart
                                is the checked one.
                                status reports each job on its own: one word for
                                both would hide a board that is up beside a
                                conductor launchd respawns every thirty seconds
  lingtai pause <why>               stop the running daemon taking new tickets; a
                                run in flight finishes. About the daemon that is
                                running, and gone when it is — but not for
                                lingtai run, which takes no ticket while a
                                pause stands, daemon or none: one already
                                working finishes the ticket in hand and takes
                                no other
  lingtai resume                    take tickets again
  lingtai shutdown [why]            stop the daemon, letting the ticket in flight
                                finish first — the pass, so the steps and the
                                merge lane run too. It does not outlive the
                                daemon it was sent to, so the next lingtai start
                                needs nothing lifted
    --force                     do not wait. The agent is left running and the
                                next conductor kills it and releases the claim
    --timeout <duration>        give up waiting after this and exit anyway,
                                leaving the agent running. Not with --force,
                                which does not wait at all
  lingtai restart [why]             drain, wait for the pass, and start one daemon
                                here — or through lingtai service, when a
                                supervisor keeps it. Refuses a commit that is not on the
                                tracking remote — a process holds its code for
                                hours, and a commit nobody pushed cannot be
                                reasoned about afterwards — a dirty worktree,
                                and what lingtai doctor failed on. Ctrl+C
                                during the wait leaves the drain standing, and
                                the next restart picks it up
    --dirty                     start from a dirty worktree, having read why not
    --despite-doctor            start in spite of failed doctor checks
    --force, --timeout          as for lingtai shutdown — they are that
                                shutdown's, and the start is unaffected
    --no-conduct, --no-merge    as for lingtai start; refused under a supervisor
  lingtai now <project> --issue <n> ask for one ahead of the queue
  lingtai projection lag            how far each projection is behind the log
  lingtai projection rebuild <name> drop the table, reset the checkpoint, replay
  lingtai version                   the version, and which artifact: platform,
                                binary or script, and the Node running it
  lingtai upgrade                   fetch the newest release from GitHub Releases,
                                check its checksums, unpack it beside this one
                                in ~/.lingtai/versions, drain what conducts,
                                then move ~/.local/bin/lingtai. Starts nothing.
                                With lingtai doctor, the one request to the
                                network this tool makes on its own account
    --despite-doctor            upgrade in spite of failed doctor checks
  lingtai rollback [<version>]      run ~/.local/bin/lingtai from an older version
                                still in ~/.lingtai/versions — the newest one
                                below the current, unless named
  lingtai uninstall                 ask once, remove everything under ~/.lingtai
                                and the shim, then name what it could not: the
                                GitHub App, and the log where the log is a
                                server. Where the log is a file under
                                ~/.lingtai it is named before the question,
                                because the removal takes it
    --yes                       do not ask
    --nothing-conducts          remove a conductor's state though the lock
                                under ~/.lingtai/locks could not be read
  lingtai help

Projections: ${PROJECTIONS.map((p) => p.name).join(', ')}
`

async function doctor(): Promise<number> {
  const report = await doctorReport()
  // Here and not in `runDoctor`, which `lingtai restart` gates on: the one
  // outbound request this tool makes is asked by `doctor` and `upgrade` (#184),
  // and a restart is neither.
  const release = await releaseCheck({ fetch, env: process.env, self: import.meta.filename })
  report.results.push(release)
  if (release.status === 'ok') report.ok++
  else if (release.status === 'warn') report.warned++
  else {
    // `notChecked` and not `deferred`: a release check that skipped did so
    // because *this copy* is not an installed one, which is a fact about this
    // machine and belongs on the half of the summary that says so (#214).
    report.skipped++
    report.notChecked++
  }
  console.log(formatReport(report))
  // Non-zero on any failure. `lingtai restart` runs the same report (0042) but
  // does not refuse on the same number: a failure marked `restartAnswers` exits
  // this 1 and lets a restart through, since the restart is its remedy — see
  // `gatingFailures`. A deferred check is not a failure; a missing one would be.
  return report.failed === 0 ? 0 : 1
}

/**
 * `--flag value` pairs plus positionals. Enough for three commands.
 *
 * A flag whose next token is another flag, or which ends the line, is a boolean
 * and consumes nothing. Without that rule `--no-merge --no-conduct` parsed as
 * `no-merge: "--no-conduct"` and swallowed the second flag whole, so the second
 * stayed on while the command line said to turn it off — a flag that reads as
 * ignored is the one kind that is worse than a flag that errors.
 */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const next = args[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[a.slice(2)] = ''
      } else {
        flags[a.slice(2)] = next
        i++
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

/**
 * The repository's default branch, through the same three calls `add()` makes
 * to read it (`onboard.ts:251-276`) — asked here only as a fallback for the
 * land question's own default, and answered null on any failure, since a
 * question's `detected` is just one more thing a person can type past (#399).
 */
async function defaultBranchOf(owner: string, repo: string): Promise<string | null> {
  try {
    const auth = githubApp()
    const installation = await installationForRepo(auth, owner, repo)
    const client = await createGitHubClient({ auth, owner, repo, installation })
    return await client.defaultBranch()
  } catch {
    return null
  }
}

/**
 * What `lingtai add` asks and checks before a GitHub project is registered,
 * once a slug is known (#398, #399): `--land` against `--base`, then the
 * writer and reviewer, then — once a recipe is already there — the ticket
 * source and the kinds (#396), the landing branch and the limits. Each
 * answer is written as soon as it is given, not collected for one write at
 * the end. Null to go on to the registration, or the exit code to stop with.
 * A local project, and a GitHub one picked on the board, reach none of this
 * yet.
 */
async function askBeforeGithubAdd(slug: string, flags: Record<string, string>): Promise<number | null> {
  // Tier, gates and the base are the recipe's, in the managed repository, which
  // is why this takes a slug and — at most — the branch to find the file on.
  // `named`, because a person typed it here: a recipe that contradicts `--base`
  // is refused rather than adopted (#75), which is a refusal only a typed flag
  // may earn.
  const base = flags['base']
  const land = flags['land']
  // `--land <branch>` and `--base` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--base` against the recipe's own `repo.base`).
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    console.error(
      `--land ${land} and --base ${base} name two different branches, and this command will not pick one ` +
        'silently. Nothing was written',
    )
    return 2
  }

  // Which agent writes the change, and which cold-reviews it, is asked here —
  // before `add()` resolves the recipe — because `resolveLocalRecipe` throws
  // `AgentUnresolvedError` on a file naming no `runtime.agent` the moment more
  // than one runtime is signed in (`#398`). An absent recipe is not created
  // here (`doc/design/398.md`): with no file, `add()` still refuses with
  // `RecipeMissingError` as it always has, except a flag naming an agent is
  // refused by name rather than silently ignored.
  const { owner, repo } = parseSlug(slug)
  const path = recipePath(repo)
  const existing = await diskFiles.read(path)
  const agentFlags = {
    agent: flags['agent'],
    model: flags['model'],
    reviewer: flags['reviewer'],
    reviewerModel: flags['reviewer-model'],
  }
  if (existing === null) {
    if (Object.values(agentFlags).some((v) => v !== undefined)) {
      console.error(`--agent needs a recipe to write into; there is none at ${path}. Nothing was written`)
      return 1
    }
  } else {
    // A file that `extends:` a preset and writes no `steps:` of its own
    // inherits every step from the preset — the first `steps.*` answer below
    // pins that preset's steps into the file for good (`write.ts`'s
    // `widenStepsIfNeeded`). Named here, before the writer question, because
    // showing that to a person is this caller's line to print, not
    // `agents.ts`'s.
    const extendsPreset = await readRecipeKey(repo, ['extends'])
    const stepsWritten = await readRecipeKey(repo, ['steps'])
    if (typeof extendsPreset === 'string' && stepsWritten === null) {
      console.log(
        `${path} extends ${extendsPreset} and writes no steps: of its own — the first answer here pins that ` +
          "preset's steps into the file, so a later change to the preset no longer reaches this project",
      )
    }

    const runtimes = await askRuntimes()
    const world: QuestionWorld = { ask: liveAsk, log: (line) => console.log(line) }
    const asked = await askAgents(world, { project: repo, runtimes, flags: agentFlags })
    if ('refused' in asked) {
      console.error(asked.refused)
      return 1
    }
    // `changes` sets an action's `agent:` (or creates it) and `modelChanges`
    // that same action's `model:`, written one after the other.
    await setRecipe(repo, asked.changes)
    await setRecipe(repo, asked.modelChanges)
  }

  // The questions are asked before add() runs, and only when the recipe is
  // already there — an absent one is add()'s own refusal to speak, and
  // nothing here seeds a file that cannot resolve on its own (#395).
  if (existsSync(path)) {
    const world = liveQuestionWorld()

    // #396's two questions, asked and written before `askLanding` — each as
    // soon as it is answered, so a Ctrl+C at either keeps what came before it.
    // `addCommand` hands this same `flags` object to `chooseFirstProject`
    // once this function returns — deleted as soon as each is read, so that
    // call's `runGithubBranch` does not see them again and refuse what this
    // function already asked and wrote (#396 fix round, finding 1).
    const givenTickets = flags['tickets'] ?? null
    delete flags['tickets']
    const tickets = await askTickets(world, repo, false, givenTickets, {
      history: liveHistory,
      kept: 'the writer and reviewer chosen above are kept',
    })
    if ('refused' in tickets) {
      console.error(tickets.refused)
      return 1
    }
    if (tickets.changes.length > 0) await setRecipe(repo, tickets.changes)

    const givenKinds = flags['kinds'] ?? null
    delete flags['kinds']
    const kinds = await askKinds(world, repo, givenKinds, {
      kept: 'the writer, reviewer and ticket source chosen above are kept',
    })
    if ('refused' in kinds) {
      console.error(kinds.refused)
      return 1
    }
    if (kinds.changes.length > 0) await setRecipe(repo, kinds.changes)

    const landed = await askLanding(world, repo, land ?? null, {
      defaultBranch: () => defaultBranchOf(owner, repo),
    })
    if ('refused' in landed) {
      console.error(landed.refused)
      return 1
    }
    const limited = await askLimits(
      world,
      repo,
      { rounds: flags['rounds'], wall: flags['wall'], budget: flags['budget'] },
      {},
    )
    if ('refused' in limited) {
      console.error(limited.refused)
      return 1
    }
  }

  return null
}

/**
 * `lingtai add <owner>/<repo>`, or — since #394 — `lingtai add` with no
 * positional, which asks the same GitHub-or-directory question `lingtai init`
 * does, through the one function both share (`chooseFirstProject`).
 *
 * A bare slug is still `--github <owner>/<repo>`, so every invocation that
 * worked before this still does. Tier, gates and the base are the recipe's,
 * in the managed repository, which is why the GitHub branch takes a slug and
 * — at most — the branch to find the file on: `--base`, named because a
 * person typed it here, is refused rather than silently adopted when the
 * recipe disagrees (#75).
 */
async function addCommand(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args)
  // A positional beside either flag names a second project, and neither one
  // may be dropped without a word (#394's review).
  for (const flag of ['local', 'github'] as const) {
    if (positional[0] !== undefined && flags[flag] !== undefined && flags[flag] !== positional[0]) {
      console.error(
        `lingtai add ${positional[0]} and --${flag} ${flags[flag]} name two different projects. Pass one or the ` +
          'other. Nothing was written',
      )
      return 1
    }
  }
  if (positional[0] !== undefined && flags['local'] === undefined) {
    flags['github'] = positional[0]
  }

  const slug = flags['github']
  if (slug !== undefined && slug !== '') {
    const stopped = await askBeforeGithubAdd(slug, flags)
    if (stopped !== null) return stopped
  }

  const world = liveFirstProjectWorld({ ask: liveAsk, log: (line) => console.log(line) })
  const result = await chooseFirstProject(world, flags)
  if ('refused' in result) {
    console.error(result.refused)
    return 1
  }
  if (result.project === 'github' && result.slug === undefined) {
    // Nothing was registered — the same claim `lingtai add <owner>/<repo>`
    // with no slug at all used to refuse with exit 2, before #394 let a bare
    // `lingtai add` reach this branch with no slug of its own. A script
    // checking the exit code must not read this as success (#394 finding 3).
    console.error(
      'no repository was picked — run lingtai add <owner>/<repo>, or lingtai init --project github to use the board',
    )
    return 2
  }
  return 0
}

async function projectionCommand(args: string[]): Promise<number> {
  const [sub, name] = args

  if (sub === 'lag') {
    const lags = await projectionLag()
    if (lags.length === 0) {
      console.log('no projection has a checkpoint yet')
      return 0
    }
    for (const l of lags) {
      console.log(`${l.name}\t${l.lastSeq}/${l.headSeq}\t${l.lag} behind\t${l.updatedAt?.toISOString() ?? 'never'}`)
    }
    return 0
  }

  if (sub === 'rebuild') {
    if (!name) {
      console.error('lingtai projection rebuild <name>')
      return 2
    }
    // Named, not discovered. A list whose only job was to let a projection be
    // written and silently left out of it — no table, no checkpoint, no failing
    // check — is what 0022 refused; `PROJECTIONS` is written out above, and a
    // projection missing from it is missing from `--help` too.
    const projection = PROJECTIONS.find((p) => p.name === name)
    if (!projection) {
      console.error(`unknown projection "${name}" — known: ${PROJECTIONS.map((p) => p.name).join(', ')}`)
      return 2
    }
    const runner = createProjectionRunner({ projection })
    try {
      // Drop the table, reset the checkpoint, replay. This is what makes a
      // projection's shape free to change: a rebuild, not a migration.
      await runner.rebuild()
      const lag = await runner.lag()
      console.log(`${name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`)
      return lag.lag === 0n ? 0 : 1
    } finally {
      await runner.close()
    }
  }

  // Gone, and answered by name rather than by falling through to the usage.
  //
  // It was an alias for `lingtai daemon`, and that is exactly what made it
  // confusing: it read as a second way to follow the log, when it was only the
  // same one wearing another name. Two names for one process is how "why is
  // the board stale" gets a different answer depending on which name you
  // happened to learn. Since 0022 there is one behaviour everywhere — every
  // process that appends holds a projector while it runs.
  if (sub === 'run') {
    console.error(
      'lingtai projection run is gone — it was another name for lingtai daemon, which is the process that follows the projections. Use that.',
    )
    return 2
  }

  console.error(USAGE)
  return 2
}

/** What `lingtai service` reads off the log, shared with the restart that starts through it. */
function serviceOptions(): ServiceOptions {
  return {
    // The board's job, beside the daemon's (#187). `answering` is the board's
    // own word for being up, which a job the supervisor has loaded is not.
    board: boardOptions(),
    // A read that throws, so a beacon that could not be read says so.
    // Doctor folds that into "no daemon has run", and here it would be the
    // one wrong answer this command exists to avoid. It is the only read:
    // a second one could fail where this succeeded.
    liveness: async () => (await daemonLiveness(() => readStatus())).detail,
    shutdown: async () => (await readControl()).shutdown,
    pause: async () => {
      const c = await readControl()
      return c.paused ? { by: c.by, reason: c.reason, until: c.until } : null
    },
    // `lingtai shutdown`'s own append and a wait on the lock (#174): the
    // supervisor is told only once this command holds the conductor lock.
    drain: {
      ask: (by, reason) => requestShutdownUnlessStanding(by, reason),
      // Not caught here: a read that failed is not "nothing is in flight", and
      // `service shutdown` says it could not be read.
      holding: async () => describeInFlight(await inFlight()),
      queue: () => queueForTheLock(),
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason),
    },
    // A supervisor's exit code says the job was asked for, not that a daemon
    // won the lock and took work — so a start is confirmed by the record the
    // daemon appends before its first pass (#167).
    started: {
      watermark: () => controlWatermark(),
      after: (version) => startAfter(version),
    },
  }
}

/**
 * The board's leg of `ServiceOptions` (#187), and **the port is read here
 * rather than left to be read by every field**.
 *
 * `boardPort()` throws on a `board.port` that is not a port number, and this
 * object is built for every `lingtai service` verb and for `lingtai restart`.
 * Read where the fields were written — `boardUrl()` in the literal — a typo in
 * a UI setting took the conductor down with it: `service shutdown "moving the
 * database"` threw before `serviceCommand` was entered, so nothing was drained
 * and nothing unloaded, and the only thing said was about the board's port. So
 * the failure becomes the board's own `missing`, which no verb refuses over,
 * and the drain runs.
 */
function boardOptions(): ServiceOptions['board'] {
  const asked = boardPortOrWhy()
  if ('why' in asked) {
    const why = asked.why
    return {
      // No port was read, so there is no address of this machine's. The
      // default's is where a board would answer once the file reads, and
      // `missing` says in the same breath that nothing is on it.
      url: `http://127.0.0.1:${BOARD_PORT}`,
      answering: async () => null,
      missing: () => ({
        why,
        remedy: [`the board's port is set in ${configPath(process.env)}, and nothing else here reads it`],
      }),
      // Never reached: every verb asks `missing` first and starts no board.
      heldBy: async () => {
        throw new Error(why)
      },
    }
  }
  const { port } = asked
  return {
    url: `http://127.0.0.1:${port}`,
    answering: () => boardAnswering(port),
    missing: boardMissing,
    // The key `lingtai board start` takes, read without taking it — so a board
    // in a terminal is not a job the supervisor respawns every thirty seconds.
    heldBy: () => createFileLocker().holder(boardLock(port)),
  }
}

/**
 * Why `lingtai board start` would serve nothing here, or null.
 *
 * The same question `board start` itself asks, asked before a job is written
 * to run it (#187): the supervisor's job runs this file from the source, and
 * from the source the board is whatever `pnpm build` left in `dist/`. Where
 * there is none, `lingtai service` writes no board job rather than one launchd
 * respawns every thirty seconds.
 */
function boardMissing(): { why: string; remedy: readonly string[] } | null {
  const entry = boardEntry(builtBoardDir())
  return existsSync(entry)
    ? null
    : {
        why: `no built board at ${entry}`,
        remedy: [
          'pnpm build writes the board, and pnpm lingtai service install then adds the job',
          'from a checkout, pnpm --filter @lingtai/board dev serves the same port in a terminal',
        ],
      }
}

/**
 * Whether a **Lingtai** board answers on `port`, as its own page says so.
 *
 * The title and not a 200: a port some other server holds answers too, and
 * calling that one a board is how `board stop` ends up signalling somebody
 * else's process. `lingtai init` asks the same question the same way.
 */
async function boardAnswering(port: number): Promise<string | null> {
  const url = `http://127.0.0.1:${port}`
  try {
    const res = await fetch(`${url}/setup/github-app`, { signal: AbortSignal.timeout(5000) })
    return (await res.text()).includes('<title>Lingtai</title>') ? url : null
  } catch {
    return null
  }
}

function liveBoardWorld(): BoardWorld {
  return {
    host: '127.0.0.1',
    hostname: hostname(),
    answering: boardAnswering,
    bound: (port) =>
      new Promise<boolean>((resolve) => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => resolve(false))
      }),
    locker: createFileLocker(),
    // The supervisor's job is `lingtai board start --no-open` with no `--port`
    // (`BOARD_JOB.argv`), so the board it keeps is on `boardPort()` and on no
    // other. A `--port` that names a different one is a board of this
    // terminal's, and the supervisor keeps nothing there — asked without the
    // port, `board stop --port 18080` booted out the job serving 17820 and
    // reported that as the stop of the board it was given (#187). A port that
    // could not be read at all is one no job is serving either.
    keeper: (port) => {
      let supervised: number
      try {
        supervised = boardPort()
      } catch {
        return { kept: false }
      }
      return port === supervised ? keeper({}, BOARD_JOB) : { kept: false }
    },
    exec: (call) => {
      const r = spawnSync(call[0]!, call.slice(1), { encoding: 'utf8' })
      if (r.error) return { status: 127, out: r.error.message }
      return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
    serve: serveBoard,
    open: (url) =>
      new Promise((resolve) => {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
        const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
        child.once('error', () => resolve(false))
        child.once('spawn', () => {
          child.unref()
          resolve(true)
        })
      }),
    // `kill` with no signal would only ask whether it exists; SIGTERM is the
    // stop, and a board installs no handler that could swallow it.
    signal: (pid) => {
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {
        return false
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    whereThePortIsSet: `board.port in ${configPath(process.env)}, or --port for this one run`,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}

/**
 * `lingtai daemon` — the process that holds the long-lived work.
 *
 * The follower used to live in this file, which meant nothing held it unless
 * somebody kept a terminal open. It is in `@lingtai/daemon` now, behind one
 * lock, so this is the command and not the mechanism.
 *
 * Losing the lock exits 0. Running this while the service's copy is up is a
 * reasonable thing to do, and answering it with an error would teach people to
 * ignore errors. `lingtai restart` is the one caller that wanted a daemon and
 * is entitled to be told it did not get one — it passes `restart`, and losing
 * the lock exits **non-zero**, because it is not known to be a success: the
 * holder may be a `lingtai run` that exits when its one pass ends, or a launchd
 * copy that read the drain before it was withdrawn and is draining back out.
 * Either leaves no daemon, so the line says what is known and where to look.
 *
 * **The one place a daemon is started**, and that is deliberate: the beacon, the
 * reconcile, the `ConductorStarted` append and the drain handlers are one
 * sequence, and a second way in would be a second place for them to drift apart.
 */
async function daemonCommand(
  flags: Record<string, string> = {},
  /** Who asked for this start, why, and the code their checks examined — when it is a restart. */
  restart: { by: string; reason: string; examined: CodeVersion } | null = null,
): Promise<number> {
  // The lock, the status table, the code this process loaded, and — for a
  // restart — the refusals only a started daemon can be asked. One function for
  // all of it, so the terminal restart's side of `RESTART_GUARDS` is the code
  // `integration/restart.test.ts` runs and not a copy of it (#167).
  const opened = await openDaemon(restart, {
    start: () => startDaemon({ projections: PROJECTIONS, log: (line) => console.log(line) }),
    code: async () => {
      // The beacon. One timer in the whole system, and it decides nothing — it
      // says "still here", which is the difference between a board that is behind
      // and a board that is broken. Two work items merged for real while their
      // cards sat still and nothing reported it; this is what makes that a glance.
      await createStatusTable()
      // Read once, here, and carried on every beat afterwards. Node caches a module
      // at import, so this process runs whatever `HEAD` pointed at now for as long
      // as it lives — a merge into `main` reaches the CLI, the gates and the board
      // and does not reach this. #88 landed thirty-nine minutes after a daemon
      // started and never executed once; nothing in the beacon could have said so.
      return readCodeVersion()
    },
    control: () => readControl(),
    log: (line) => console.log(line),
  })
  if (!opened.ok) return opened.code
  const { started, code } = opened

  // **Beating from here**, and not from after the reconcile below — which is
  // what `#144` was. The two lines that follow this one read a recipe per
  // project over the network, and the reconcile after them writes GitHub
  // labels; a startup with two divergences to fix crossed fifteen seconds, and
  // for the second half of it `lingtai doctor` said `not running` about a
  // daemon whose lock it printed on the next line. `startBeacon` keeps one
  // timer for the whole life of the process, so there is no stretch of it
  // during which nothing says "still here".
  const beacon = startBeacon('starting', { code })
  console.log(
    `running ${code.sha ? code.sha.slice(0, 7) : 'an unrecorded commit'}` +
      `${code.dirty ? ' (worktree dirty)' : ''} — lingtai doctor says how far behind that is`,
  )

  // And in the log, where the beacon cannot help: a beacon is one mutable row
  // that the next start overwrites, so it says a daemon is up and never said
  // that one *started*, from what code, or at whose hand. A restart at 23:06 on
  // 2026-09-09 is unattributable for exactly that reason (0042).
  //
  // Reported and not fatal. Refusing to conduct because a control append lost a
  // version race would be a daemon that will not run for want of a record of
  // itself — but a start nobody can trace is the defect this closes, so it is
  // said in the accent that means *look at this*.
  //
  // **A person only where a person's hand is on it**, and whose hand is
  // `attributeStart`'s to decide: `lingtai restart` here, a terminal, or
  // nobody's — launchd's and systemd's starts included (0048).
  //
  // **Not decided here.** A read taken now and a shutdown noticed after the
  // reconcile are two reads, and a restart's withdrawal can land between them —
  // a start that saw the drain, recorded nothing, and then took work. So this
  // is handed the one read that decides whether work is taken: the loop's
  // shutdown check, or the `--no-conduct` listener's (`startRecorder`).
  const noteStart = startRecorder({
    restart,
    tty: Boolean(process.stdin.isTTY),
    user: process.env['USER'] ?? 'operator',
    record: (a) => recordStart(a.by, a.reason, code),
    log: (line) => console.log(line),
  })

  // Before anything is taken. A worktree left by a killed daemon is holding a
  // branch checked out, which stops git updating that ref on the next attempt —
  // so the tidy-up has to happen before the next attempt, not after it fails.
  // All four checks, GitHub included (`#69`). The clients are built here and
  // injected rather than reached for inside `reconcile`, so a reconcile in a
  // test — or on a machine with no App — still does the other three.
  const registered = await loadProjects().catch(() => [])

  // What this daemon will and will not take, per project, **before it takes
  // anything**. The same lines `lingtai status` prints, from the same function,
  // so the two cannot disagree about whether a queue is empty or unreadable.
  //
  // #76 is why this is at startup rather than only in a pass. A recipe on
  // `main` naming a label the core did not know stopped parsing, every issue in
  // the project left the queue, and the only place that said so was a `lingtai
  // status` nobody ran — `conduct.ts` put it in `outcome.refused` and the loop
  // logged one `pass failed:` line, but only once a pass had run, and one line
  // into scrollback. A daemon that cannot read a recipe now says so in the
  // block you are already reading while it starts.
  if (registered.length === 0) console.log('no project registered — run lingtai add <owner>/<repo>')
  const filters = await projectFilters(registered)
  for (const line of describeFilters(filters)) console.log(line)

  const { clients, unresolved } = await clientsForProjects(registered)
  // **Report, don't repair** (#389). A project whose client will not build —
  // a recipe that will not resolve, or (`#355`) a no-owner project's own
  // `ownerlessRefusal`, whose recipe resolves fine — is dropped from
  // `clients` rather than falling back to the raw client — see
  // `clientsForProjects`' own doc comment — and the consequence is said here,
  // once per project per daemon start, because `reconcile(` has one caller
  // and nothing on the work loop reaches this line again until the next
  // start. `doctor` reads the same filter live, which is the per-sweep half
  // of this report. `u.problem` already names the specific cause, so the
  // line around it says only that reconcile is skipped — never "its recipe
  // will not resolve", which is false for the ownerless case.
  for (const u of unresolved) {
    console.log(
      paint.fail(
        `reconcile skipped ${u.project}: ${u.problem}. ` +
          'Labels, closes and leftover arms are not converged while this stands.',
      ),
    )
  }
  const found = await reconcile({
    log: (line) => console.log(line),
    // Told what world it is repairing: which projections should be current,
    // which projects' claims are ours, and how to reach GitHub. Each check
    // no-ops without its own input rather than guessing at a global scan.
    projections: PROJECTIONS.map((p) => p.name),
    projects: registered,
    github: { projects: registered, clients },
  }).catch((err: unknown) => {
    // Reported, never fatal. Refusing to start because a directory could not be
    // removed would turn a mess into an outage.
    console.error(`reconcile failed: ${(err as Error).message}`)
    return []
  })
  if (found.length > 0) console.log(paint.pass(`reconciled ${found.length} divergence(s)`))
  // The slow half is done. The timer has been running throughout it; this is
  // the word changing, not the beating starting.
  void beacon.say('up')

  /**
   * How a daemon that takes no work hears a shutdown. Unset while it takes work,
   * because then the loop reads the control stream itself.
   *
   * The loop is what reads the control stream, so a `--no-conduct` daemon was
   * deaf to `lingtai shutdown` entirely — the request landed, nothing read it,
   * and the process stayed up. That was invisible while stopping was the whole
   * of the command; `lingtai restart` waits for the drain it asked for, and a
   * drain nothing will ever perform is a wait that never ends (0042).
   *
   * On the beacon's period, and deciding nothing about work — only when to stop.
   */
  let listening: ReturnType<typeof setInterval> | undefined

  // Taking work is the default now that there is a way to stop it (#45).
  // `--no-conduct` is for a daemon you want keeping the board current while
  // you work on something else.
  let loop: ReturnType<typeof createWorkLoop> | null = null

  // ------------------------------------------------------------ stopping ----
  //
  // Two ways in and one behaviour, from
  // [0030](../../../doc/decisions-archive/0030-shutting-down-safely.md): `lingtai
  // shutdown` reaches the loop through the log, a signal reaches this handler,
  // and both drain. **Draining is waiting for the pass**, which spans the
  // agent, the gates, the merge lane and the `end` point — not for the agent's
  // exit, which is only the first of those.

  /** The request the loop read, when the log is what began this. */
  let asked: ShutdownRequest | null = null
  let draining = false
  let stopping = false

  /**
   * Stop now, without waiting.
   *
   * The second Ctrl+C and the `--timeout` that trips both come here, and both
   * knowingly leave the agent running: it is detached, so it survives this
   * process, and the next conductor's reconcile kills it before releasing its
   * claim (0030 §5). Ending with `process.exit` because the pass in flight is
   * holding the event loop open — returning would be a daemon that says it has
   * stopped and has not.
   */
  const stopNow = (why: string): void => {
    if (stopping) return
    stopping = true
    console.log(paint.held(why))
    void (async () => {
      // The last word, and the timer off with it — `stop` does both, in that
      // order, so nothing lands after it.
      await beacon.stop('stopping')
      started.daemon.stop()
      // The projections are stopped and the lock is released by this; what it
      // does not do, and must not, is wait for the pass.
      await started.daemon.stopped
      process.exit(0)
    })()
  }

  /**
   * Finish the pass in flight, then stop — and say so before waiting.
   *
   * The first Ctrl+C prints what is draining and what a second one costs. Both
   * sentences are honest only because the agent is in its own process group
   * (§3): before that, the signal that began the shutdown killed the agent in
   * the same instant, and there was nothing left to finish.
   */
  const drain = async (why: string, timeoutMs: number | null): Promise<void> => {
    if (draining) return
    draining = true

    const held = await inFlight().catch(() => [])
    // The held colour, which is the board's own answer for this exact fact:
    // `draining.tsx` wears `chip held` with the comment "Held rather than
    // warned: nothing is broken, and a red chip would send…". A shutdown is a
    // person's word, and a person's word is never the green one nor the red.
    console.log(paint.held(`draining — ${describeInFlight(held)}, then stopping (${why}).`))
    console.log(paint.muted('press ctrl-c again to stop now, leaving its agent orphaned.'))
    console.log(
      paint.muted(
        timeoutMs === null
          ? // **A pass is no longer one agent**, and this sentence has now been
            // wrong twice for the same reason. It first said one
            // `runtime.limits.wall`, which the fix loop made an understatement.
            // It was then rewritten as *each with its own <wall>, so several
            // times that* — a multiple, to avoid naming a number this line cannot
            // know. `#141` then made `WALL_LIMIT` a whole sentence rather than a
            // phrase, and the two collided into "each with its own the recipe's
            // runtime.limits — by default, up to 3 agent runs".
            //
            // It says the product now, because `passCeiling` computes one and
            // there is no longer anything to approximate: the multiple *is* the
            // number, and asking the reader to multiply was only ever the cost of
            // not having it.
            `a pass is the agents, the steps and the merge lane. What one may spend is ${WALL_LIMIT}. It is waiting, not hung.`
          : `giving up after ${Math.round(timeoutMs / 1000)}s if it has not finished, which leaves the agent running.`,
      ),
    )
    await beacon.say('draining')

    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== null) {
      timer = setTimeout(
        () =>
          stopNow(
            `--timeout reached — leaving the agent running. The next conductor kills it and releases the claim (lingtai doctor names it).`,
          ),
        timeoutMs,
      )
      timer.unref?.()
    }

    clearInterval(listening)
    // The drain itself. No timeout around this one on purpose (§6).
    await loop?.stop()
    clearTimeout(timer)
    if (stopping) return
    stopping = true
    await beacon.stop('stopping')
    started.daemon.stop()
  }

  // **Where the control stream was when this daemon started** (`#159`). Every
  // signal it obeys is read from here, so a pause or a shutdown appended before
  // it began belongs to the daemon before it and not to this one. That is what
  // makes `lingtai start` need nothing lifted first: there is no such thing as
  // a signal standing over a process that did not exist when it was sent.
  //
  // **Read by `startDaemon`, before the lock** (#174). It used to be read here,
  // after the lock and the projections, and a `service shutdown` appended in
  // that gap was below the watermark of the only daemon holding the lock — so
  // nothing ever obeyed it, and the command waiting for the lock waited for ever.
  const since = started.since

  if (!('no-conduct' in flags)) {
    // Who is told what happened, straight off the recipes and named nowhere
    // here (`#123`). This block used to construct `macNotifier()` by name,
    // which is what 0037 §3 exists to remove: Lingtai's own desktop
    // notification is now a `run:` line in a `subscribers:` block, started by
    // exactly the code that will start somebody else's.
    //
    // Fire and forget, as it always was: a notification retried later, about a
    // decision already made, trains you to ignore the next one.
    //
    // A project whose recipe could not be read here is said to be unread, not
    // quiet, and asked again before each pass until it is.
    const declared = await createSubscriberSet({
      filters,
      reread: (projects) => projectFilters(registered.filter((p) => projects.includes(p.project ?? '(unnamed)'))),
      subject: createSubjectResolver(),
      // The daemon's own directory. There is no worktree for an event — it is
      // not about a diff — and a subscriber that wants one has to make it.
      cwd: process.cwd(),
      log: (line) => console.log(line),
    })
    for (const line of declared.describe()) console.log(line)

    loop = createWorkLoop({
      log: (line) => console.log(line),
      subscribers: () => declared.subscribers(),
      // The third kind of agent, hosted here because the daemon is where money
      // is spent (0033 §3). Off the pass path: a question must not queue behind
      // a run, and it takes no claim and provisions nothing that would need to.
      discuss: (event) => onDiscussionRequested(event, (line) => console.log(line)),
      // Asked from the log every pass. A pause issued while a run is in flight
      // has to land at the next opportunity without anybody restarting this.
      paused: async () => (await readControl(undefined, since)).paused,
      // And a shutdown in the same breath, from the same fold (0030 §2). The
      // command appends and returns; this is where it lands.
      shutdown: async () => {
        const control = await readControl(undefined, since)
        asked = control.shutdown
        // The start is recorded off this read and no other, before the first
        // pass it permits — see `startRecorder`.
        await noteStart(control)
        // The remedy in the sentence, because this is also what a daemon
        // started *after* an unwithdrawn request prints on its way straight
        // back out — and at that point it is the only thing worth knowing.
        // No remedy in the sentence any more. It used to say "lingtai resume
        // lifts it", because this was also what a daemon started *after* an
        // unwithdrawn request printed on its way straight back out. That start
        // cannot happen now: `since` makes an older request invisible, so
        // reaching here means somebody asked *this* daemon to stop, and they
        // know they did.
        return asked ? `asked by ${asked.by} — ${asked.reason}` : null
      },
      // The loop has stopped taking work. What it cannot do is exit the
      // process, so the host does — after the drain `stop()` performs.
      // `--force` takes the other exit. `stopNow` is not new: it is where
      // `--timeout` already went when it tripped, so forcing asks for a state
      // the system already knows how to be in rather than inventing one.
      onShutdown: (why) =>
        asked?.force === true
          ? stopNow(
              `${why} — forced, so the pass is not finished. The agent is left running for the next conductor to kill.`,
            )
          : void drain(why, asked?.timeoutMs ?? null),

      pass: async (reason) => {
        await declared.retry()
        const outcome = await conductorPass({
          merge: !('no-merge' in flags),
          // The commit read at startup, so a refusal on the log says which
          // process refused (#148).
          codeSha: code.sha,
          // Asked again inside the pass, before each project and ticket, with
          // the same scope as the loop's own (#159): a run that stands the
          // conductor down must stop the next claim in this pass, not the next
          // pass (#210).
          paused: async () => {
            try {
              const c = await readControl(undefined, since)
              return c.paused ? `paused by ${c.by} — ${c.reason}` : null
            } catch (err) {
              // Not "not paused": a pause that could not be read is not consent.
              return `could not read whether the conductor is paused: ${(err as Error).message}`
            }
          },
          log: (line) => console.log(line),
        })
        // The run told GitHub as it went (0022), so there is nothing left
        // here to send and nothing to report about sending it.
        // A routine pass, in the accent — structure, not a verdict. What the
        // pass *decided* is coloured line by line above this; this one only
        // says the loop went round.
        console.log(
          paint.accent(
            `pass (${reason}): ${outcome.projects} project(s), ${outcome.ran} run(s)` +
              (outcome.refused.length > 0 ? `, ${outcome.refused.length} refused` : ''),
          ),
        )
      },
    })
    // **Scoped, like the loop's** (`#159`). It used to fold the whole stream,
    // so a daemon that had just started announced a pause from before it
    // existed and then took work anyway — the report and the loop disagreeing
    // about the same question, which is worse than either answer.
    //
    // A pause this daemon *will* obey is one somebody made after it started,
    // and that is the only one worth printing here. `lingtai status` keeps the
    // unscoped read, because it answers *what is standing* rather than *what
    // will this process do*.
    const control = await readControl(undefined, since)
    // Held, for the same reason `paused.tsx` wears `chip held`: nothing is
    // broken and a person stopped it.
    if (control.paused) console.log(paint.held(`paused by ${control.by} — ${control.reason}`))
    await loop.start()
    // A question asked while nothing was listening is waiting in the stream,
    // exactly as a pause is (0013). After `start`, so the subscription is
    // already up and a question that arrives during this one is not missed.
    const waiting = await answerOutstanding((line) => console.log(line)).catch((err: unknown) => {
      console.error(`discussions: ${(err as Error).message}`)
      return 0
    })
    if (waiting > 0) console.log(`answered ${waiting} discussion(s) that were waiting`)
  } else {
    // Discussions go with the conductor, and that is what this flag says: they
    // spend money and 0033 §3 puts everything that spends money in the process
    // that takes work. A daemon told to take none answers none either.
    console.log(paint.muted('projections only — no work will be taken and no question answered'))

    // It still stops when it is told to. Nothing is in flight here — there is
    // no pass to finish — so this drain is over as soon as it begins, which is
    // the honest shape of "finish what you are holding" for a daemon holding
    // nothing.
    const hearShutdown = async (): Promise<void> => {
      const control = await readControl().catch(() => null)
      if (control) await noteStart(control)
      const standing = control?.shutdown ?? null
      if (standing) await drain(`asked by ${standing.by} — ${standing.reason}`, standing.timeoutMs)
    }
    listening = setInterval(() => void hearShutdown(), HEARTBEAT_MS)
    // Asked once before waiting for the timer, so a daemon started after an
    // unwithdrawn request goes straight back out — as a conducting one does.
    await hearShutdown()
  }

  // The first signal drains and says so; the second stops now. `kill <pid>` is
  // the same two presses, because it used to be the worse of the two: it
  // reached the daemon alone, orphaned the agent, and took with it the code
  // that would have appended the outcome (#87).
  let signals = 0
  const stop = (signal: string) => {
    signals += 1
    if (signals === 1) {
      void drain(signal === 'SIGINT' ? 'ctrl-c' : signal, null)
      return
    }
    stopNow('stopping now — its agent is left running, and the next conductor kills it.')
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const reason = await started.daemon.stopped
  if (reason === 'projection-failed') {
    const failed = started.daemon.failure
    console.error(`stopped: ${failed?.projection} failed — ${String(failed?.error)}`)
    return 1
  }
  console.log('stopped')
  return 0
}

/**
 * `lingtai pause` / `lingtai resume` / `lingtai shutdown` / `lingtai now` — the
 * operator's controls.
 *
 * They append and return. The daemon is listening, so a pause takes effect at
 * its next opportunity; if it is down, the command is waiting when it comes
 * back rather than being a race somebody has to handle.
 *
 * `shutdown` is the same shape for the same reasons, and for one more that is
 * not an implementation detail: a signal cannot carry it
 * ([0030](../../../doc/decisions-archive/0030-shutting-down-safely.md)). Ctrl+C goes to
 * the whole foreground group, so before §3 detached the agent, the signal that
 * began the shutdown killed the run it claimed to be waiting for.
 *
 * **The one place that does not hold a projector**, and deliberately: a
 * projector catches up to the head before it returns, so a pause issued against
 * a daemon that has been down would replay the backlog before pausing anything.
 * See `withProjector` for the rule and for this exception.
 */
async function controlCommand(verb: 'pause' | 'resume' | 'shutdown' | 'now', args: string[]): Promise<number> {
  // **`--help` is a question, never an instruction.** `lingtai shutdown --help`
  // took `--help` as the reason and stopped the daemon — asking what a command
  // does by doing it, on the one command whose cost is a running system. Caught
  // by typing it.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  const { positional, flags } = parseFlags(args)
  const by = `human:${process.env['USER'] ?? 'operator'}`

  if (verb === 'pause') {
    const reason = flags['reason'] ?? positional.join(' ')
    if (!reason.trim()) {
      // A pause with no reason is one nobody can undo confidently, because
      // nobody can tell whether the thing it was waiting for has happened.
      console.error('lingtai pause <why>  — a pause needs a reason')
      return 2
    }
    await pauseCommand(by, reason)
    return 0
  }

  if (verb === 'resume') {
    await resumeConductor(by)
    console.log(paint.pass(`resumed by ${by}`))
    return 0
  }

  if (verb === 'shutdown') {
    // A reason is welcome and not required, unlike a pause's: a pause has to be
    // lifted by somebody who can tell whether the thing it was waiting for has
    // happened, and a shutdown is over when the process is.
    const reason = (flags['reason'] ?? positional.join(' ')).trim() || 'no reason given'

    let timeoutMs: number | null = null
    if ('timeout' in flags) {
      const text = flags['timeout'] ?? ''
      try {
        timeoutMs = parseDuration(text)
      } catch {
        console.error(`--timeout takes a duration like 30m or 90s, not "${text}"`)
        return 2
      }
      if (timeoutMs <= 0) {
        console.error('--timeout takes a positive duration')
        return 2
      }
    }

    // Safe is the default and `--force` is the loud one (`#159`). A command
    // whose ordinary form throws away a pass in flight is one people learn to
    // fear; this way the dangerous thing has to be asked for by name.
    const force = 'force' in flags
    if (force && 'timeout' in flags) {
      console.error('--timeout is about waiting for the pass, and --force does not wait. Use one.')
      return 2
    }

    await requestShutdown(by, reason, timeoutMs, undefined, force)
    console.log(paint.held(`shutdown asked by ${by} — ${reason}`))

    if (force) {
      // What `--timeout` has always done when it tripped, and what a second
      // Ctrl+C does. The orphan is the point, and it already has an owner.
      console.log(
        '--force: it stops without finishing the pass. The agent is left running, and the next conductor kills it and releases the claim.',
      )
      return 0
    }

    // Said up front, because the alternative is a command that has returned
    // and a daemon that looks hung (0030 §6). What is being waited for is the
    // *pass* — the agent, then the gates, then the merge lane.
    const held = await inFlight().catch(() => [])
    console.log(
      timeoutMs === null
        ? // No "lingtai resume lifts it" any more (`#159`). It was true when the
          // request outlived the daemon it was aimed at; the next `lingtai start`
          // now needs nothing lifted, so saying otherwise would send a person to
          // a command that has nothing to do.
          `the daemon finishes the pass in flight first — ${describeInFlight(held)} — which can take as long as ${WALL_LIMIT}.`
        : `the daemon finishes the pass in flight — ${describeInFlight(held)} — or gives up after ${Math.round(timeoutMs / 1000)}s and exits with the agent still running, for the next conductor to kill.`,
    )
    return 0
  }

  const project = positional[0]
  const issue = flags['issue'] ?? positional[1]
  if (!project || !issue) {
    console.error('lingtai now <project> --issue <n>')
    return 2
  }
  await requestRun(project, issue, by)
  console.log(`requested ${project} #${issue}`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case 'add':
      return addCommand(rest)
    case 'run': {
      const { flags } = parseFlags(rest)
      const positional = rest.filter((a) => !a.startsWith('--') && a !== flags['issue'] && a !== flags['max'])
      const project = positional.find((p) => p !== '--once') ?? flags['project']
      if (!project) {
        console.error('lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]')
        return 2
      }

      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const issue = 'issue' in flags ? Number(flags['issue']) : undefined
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error('--issue takes a number')
        return 2
      }
      const max = 'max' in flags ? Number(flags['max']) : 'once' in flags && issue === undefined ? 1 : undefined
      if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
        console.error('--max takes a positive number')
        return 2
      }

      return runOnceCommand({
        project,
        ...(issue === undefined ? {} : { issue }),
        ...(max === undefined ? {} : { max }),
        // `--no-merge` is absence of merging, so the flag's presence is the
        merge: !('no-merge' in flags),
      })
    }
    case 'approve': {
      const { positional, flags } = parseFlags(rest)
      const issue = Number(flags['issue'])
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error('lingtai approve <project> --issue <n> [--note <text>]')
        return 2
      }
      if ('reject' in flags) {
        // Gone (#150): it appended `ApprovalRevoked` and put the run straight
        // back into `awaiting-approval`, so the wait it seemed to end went on.
        console.error('--reject is gone: it asked the same question again and ended nothing.')
        console.error(`lingtai requeue ${positional[0]} --issue ${issue} --note <why> ends the wait with a new run`)
        return 2
      }
      return approveCommand({ project: positional[0], issue, note: flags['note'] })
    }
    case 'backlog':
      return backlogCommand(rest)
    case 'requeue': {
      const { positional, flags } = parseFlags(rest)
      const issue = Number(flags['issue'])
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error('lingtai requeue <project> --issue <n> --note <why>')
        return 2
      }
      // `--note` with nothing after it parses as the empty string, which is the
      // same silence as leaving the flag off — so both arrive as "" and the
      // command refuses them identically. Not defaulted here or there.
      return requeueCommand({ project: positional[0], issue, note: flags['note'] ?? '' })
    }
    case 'ask':
    case 'answer': {
      const { positional, flags } = parseFlags(rest)
      const issue = Number(flags['issue'])
      const usage =
        command === 'ask'
          ? `lingtai ask <project> --issue <n> "<question>"`
          : `lingtai answer <project> --issue <n> "<choice>"`
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error(usage)
        return 2
      }
      // Everything after the project is the sentence, so an unquoted one still
      // arrives whole. Blank is refused by the command, not defaulted here.
      const text = positional.slice(1).join(' ')
      const options = { project: positional[0], issue, text }
      return command === 'ask' ? askCommand(options) : answerCommand(options)
    }
    case 'close': {
      const { positional, flags } = parseFlags(rest)
      const issue = Number(flags['issue'])
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error(`lingtai close <project> --issue <n> "<reason>"`)
        return 2
      }
      // Everything after the project is the reason, as `ask` takes its question:
      // an unquoted sentence still arrives whole, and blank is refused by the
      // command rather than defaulted here.
      return closeCommand({ project: positional[0], issue, reason: positional.slice(1).join(' ') })
    }
    case 'ticket': {
      const [verb, ...ticketRest] = rest
      const { positional, flags } = parseFlags(ticketRest)
      const project = flags['project']
      if (verb === 'list') {
        if (positional.length > 0) {
          console.error('lingtai ticket list [--all] [--project <p>]')
          return 2
        }
        return ticketList({ ...(project === undefined ? {} : { project }), all: 'all' in flags })
      }
      if (verb === 'close') {
        const issue = Number(positional[0])
        if (!positional[0] || !Number.isInteger(issue)) {
          console.error('lingtai ticket close <n> [--project <p>]')
          return 2
        }
        return ticketClose({ issue, ...(project === undefined ? {} : { project }) })
      }
      if (verb === 'new') {
        if (positional.length > 0) {
          console.error('lingtai ticket new [--project <p>]')
          return 2
        }
        return ticketNew(project === undefined ? {} : { project })
      }
      if (verb === 'edit') {
        const issue = Number(positional[0])
        if (!positional[0] || !Number.isInteger(issue)) {
          console.error('lingtai ticket edit <n> [--project <p>]')
          return 2
        }
        return ticketEdit({ issue, ...(project === undefined ? {} : { project }) })
      }
      console.error(
        'lingtai ticket list [--all] [--project <p>]\nlingtai ticket close <n> [--project <p>]\n' +
          'lingtai ticket new [--project <p>]\nlingtai ticket edit <n> [--project <p>]',
      )
      return 2
    }
    case 'attach': {
      const runId = parseFlags(rest).positional[0]
      if (!runId) {
        console.error('lingtai attach <runId>')
        return 2
      }
      // Ctrl-C detaches rather than killing the process, so the command gets to
      // say that the run is still going and where its log is. Nothing is being
      // stopped: this is a reader, and 0034's file does not know it has one.
      const detach = new AbortController()
      process.on('SIGINT', () => detach.abort())
      return attach({ runId, signal: detach.signal })
    }
    case 'board': {
      const parsed = parseBoardArgs(rest)
      if ('refused' in parsed) {
        console.error(parsed.refused)
        return 2
      }
      // `--port` is this run's; without it the machine file's, and without that
      // 17820 (#187). A file that does not parse is refused by name here rather
      // than serving on a port nobody chose.
      let port: number
      try {
        port = parsed.port ?? boardPort()
      } catch (err) {
        console.error((err as Error).message)
        return 1
      }
      return boardCommand({ ...parsed, port, dir: parsed.dir ?? builtBoardDir() }, liveBoardWorld())
    }
    case 'status': {
      const { positional, flags } = parseFlags(rest)
      return status({ project: positional[0], all: 'all' in flags })
    }
    case 'doctor':
      return doctor()
    // Positional throughout, and not through `parseFlags`: a value is an
    // argument here, and `KEY=--anything` is a legitimate one.
    case 'env':
      return envCommand(rest)
    case 'end': {
      const { positional, flags } = parseFlags(rest)
      // One subcommand, spelled out. `lingtai end` on its own would read like
      // an instruction to end something.
      if (positional[0] !== 'replay') {
        console.error('lingtai end replay [<project>] [--issue <n>]')
        return 2
      }
      const issue = 'issue' in flags ? Number(flags['issue']) : undefined
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error('--issue takes a number')
        return 2
      }
      return endReplay({
        ...(positional[1] === undefined ? {} : { project: positional[1] }),
        ...(issue === undefined ? {} : { issue }),
      })
    }
    case 'start':
    // **`daemon` still answers, and that is not indecision** (`#159`). An
    // installed LaunchAgent or systemd unit has `lingtai daemon` written into
    // its plist, and renaming a command must not stop a supervisor that is
    // already on disk. `start` is the name; this is the one it used to have.
    case 'daemon':
      return daemonCommand(parseFlags(rest).flags)
    case 'service':
      return serviceCommand(rest, serviceOptions())
    case 'restart': {
      const parsed = parseRestartArgs(rest)
      if (!parsed.ok) {
        console.error(parsed.message)
        return 2
      }
      // Asked before anything stops, like every other refusal. Under launchd or
      // systemd the start is the supervisor's: a daemon started here would be a
      // conductor in a terminal beside the one it keeps (0042 §8).
      const kept = keeper()
      if ('unread' in kept) {
        console.log(paint.fail(`not restarting: ${kept.unread}. Nothing was asked to stop and nothing was stopped.`))
        return 1
      }
      if (kept.kept && (parsed.args.noConduct || parsed.args.noMerge)) {
        console.error(
          `${kept.path} decides how the supervisor starts the daemon, so --no-conduct and --no-merge cannot reach it — ` +
            'pnpm lingtai service shutdown, then lingtai restart with them, runs one in this terminal instead',
        )
        return 2
      }
      // Where a supervisor keeps the daemon, the drain and the start are
      // `lingtai service`'s and every refusal is still the restart's — the same
      // functions as below, and `RESTART_GUARDS` is the table of both (#167).
      if (kept.kept) {
        const options = serviceOptions()
        return restartSupervised(parsed.args, {
          service: (argv, asked) =>
            serviceCommand(argv, {
              ...options,
              drain: {
                ...options.drain,
                ask: (by: string, reason: string) =>
                  requestShutdownUnlessStanding(by, reason, asked.timeoutMs, undefined, asked.force),
              },
            }),
        })
      }
      // Two halves of one command, and the seam is the only place a daemon is
      // started. `prepareRestart` refuses, drains and waits; everything after
      // this line is `lingtai daemon`.
      const prepared = await prepareRestart(parsed.args)
      if (!prepared.ok) return prepared.code
      const flags: Record<string, string> = {
        ...(parsed.args.noConduct ? { 'no-conduct': '' } : {}),
        ...(parsed.args.noMerge ? { 'no-merge': '' } : {}),
      }
      return daemonCommand(flags, prepared)
    }
    case 'pause':
      return controlCommand('pause', rest)
    case 'resume':
      return controlCommand('resume', rest)
    case 'shutdown':
      return controlCommand('shutdown', rest)
    case 'now':
      return controlCommand('now', rest)
    case 'projection':
      return projectionCommand(rest)
    // `entry.ts` answers this before the log is loaded; here for a process
    // started from this file, as a service's plist starts it.
    case 'version':
      console.log(versionLine())
      return 0
    // The same: `entry.ts` answers it, since it runs before there is a log to load.
    case 'init':
      console.error(
        'lingtai init runs from the entry, before the log is loaded — pnpm lingtai init, or the installed lingtai',
      )
      return 2
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return command === undefined ? 2 : 0
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`)
      return 2
  }
}

/**
 * Every ending is a sentence, not a stack trace.
 *
 * The commands report their own refusals and return an exit code, but anything
 * that *throws* went straight to Node — which printed a stack, a file path and
 * a version banner over the one line that mattered. `lingtai add` against a
 * repository whose default branch has no recipe did exactly that, and the
 * README's claim that "every refusal names itself" was false for it.
 *
 * The stack is still there for the errors that are bugs rather than refusals;
 * it just has to be asked for.
 *
 * A promise and not a top-level `await`: `pnpm build` bundles this file to CJS
 * for a SEA (#183), and CJS has no top-level `await`.
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    const error = err as Error
    console.error(error.message || String(err))
    if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
    else console.error('\n(LINGTAI_DEBUG=1 for the stack)')
    process.exitCode = 1
  },
)
