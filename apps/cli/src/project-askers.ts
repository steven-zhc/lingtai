/**
 * The terminal's input to the project list (ADR 0125 §9, `doc/design/1529.md`, #1529): one asker per question id,
 * and the live trial port. **No list is defined here** — `projectList` is `@lingtai/setup`'s — and **no prompt is
 * written here**: an asker turns the runner's `Decided` into a call to the piece that draws that question, with the
 * default the runner decided (`current` where something is in force, `fallback` where nothing is), the descriptor's own
 * `validate`, and `d.kept`. `ctx` is read for words only (the offer, the base a prompt names); every refusal is the
 * descriptor's.
 *
 * `ProjectAskers` is typed over every id but two, so a question added to the list without an asker fails `tsc`.
 * `where` is always `fixed` and takes no flag, so it has no asker; `findings-judge` is `derive`.
 */
import { keyIn, recipePath, type ProjectView } from '@lingtai/project'
import {
  type Asker,
  type Decided,
  type DetectedSetup,
  type NamedRun,
  type ProjectContext,
  type ProjectPorts,
  type ProjectQuestionId,
  type RuntimeName,
  type Trial,
  type TrialAt,
  detectedOf,
  installRefusal,
  liveTrialBuild,
  namedFromTyped,
  offeredRuntimes,
  personalFallback,
  summariseRecipe,
  trialBaseEffect,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { askReviewer, askReviewerModel, askWriter, askWriterModel } from './agents.ts'
import { askMoveLanding } from './first-project.ts'
import { askBudget, askConflictResolutions, askLandingChoice, askRefusalFixes, askWall } from './landing.ts'
import type { Answered, QuestionWorld } from './question.ts'
import { askEveryDefault, askRegister } from './recipe-flow.ts'
import { askSandboxHosts, askSandboxMode } from './sandbox-step.ts'
import {
  NO_CHECKS_LINE,
  askBuildCommands,
  askInstallCommand,
  askKeepBuildList,
  askTrial,
  detectionWhy,
  runTrialLoop,
} from './setup-build.ts'
import { askKindsList, askTicketSource } from './source.ts'
import { askBaseBranch, askLogin, askMakeBranch, askMode, askPersonal, type Mode } from './team.ts'

/** Every id the terminal asks. `where` is fixed from the ports and `findings-judge` is derived: neither is asked. */
export type ProjectAskers = Record<Exclude<ProjectQuestionId, 'where' | 'findings-judge'>, Asker<ProjectContext>>

type Decision = Decided<ProjectContext>

/** The default as the piece's `current`: what is in force, which the runner already decided the default is. */
const currentOf = (d: Decision): string | null => (d.inForce !== null ? d.default : null)
/** The default as the piece's `fallback`: only where nothing is in force. `undefined` keeps the piece's own bracket. */
const fallbackOf = (d: Decision): string | undefined => (d.inForce === null ? (d.default ?? undefined) : undefined)

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** What detection read, or null where it could not: the entry's `inForce` has already refused a failed read by name. */
const detection = (ctx: ProjectContext): Effect.Effect<DetectedSetup | null> =>
  detectedOf(ctx).pipe(Effect.catch(() => Effect.succeed(null)))

/** A JSON array of commands, as the `checks` descriptor reads and writes it. */
const listOf = (answer: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(answer ?? '[]')
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string') ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/**
 * The build list's question, with no `ctx`: whether to keep `list` (where there is one), else the commands a person
 * types. The record's `checks` asker and the trial's *edit* both call it, so the re-ask is the same code.
 */
export const checksAsk = (
  world: QuestionWorld,
  at: { list: readonly string[]; why: readonly string[]; kept: string },
): Effect.Effect<{ keep: true } | { commands: string[] } | { refused: string }, unknown> =>
  Effect.gen(function* () {
    if (at.list.length > 0) {
      const keep = yield* askKeepBuildList(world, { given: null, why: at.why, kept: at.kept })
      if ('refused' in keep) return keep
      if (keep.answer === 'yes') return { keep: true } as const
    }
    const typed = yield* askBuildCommands(world, { why: at.list.length === 0 ? at.why : [], kept: at.kept })
    return 'refused' in typed ? typed : { commands: typed.commands }
  })

/** `view`, with the branch still to be made read as the one it is cut from: it is not on GitHub yet. */
const viewWithMake = (view: ProjectView, make: { name: string; from: string } | null): ProjectView =>
  make === null
    ? view
    : {
        ...view,
        // The branch to be made is `branch.personal` in team mode and `branch.main` otherwise: either reads as its source.
        get: (path) => {
          const key = path.join('.')
          return (key === 'branch.personal' || key === 'branch.main') && view.get(path) === make.name
            ? make.from
            : view.get(path)
        },
      }

/** One asker per id, over `world`. */
export function projectAskers(world: QuestionWorld): ProjectAskers {
  const keepLimit = (d: Decision) => ({
    given: null,
    current: currentOf(d),
    fallback: fallbackOf(d),
    validate: d.question.validate,
    kept: d.kept,
  })

  return {
    mode: (d) =>
      askMode(world, { given: null, kept: d.kept, current: currentOf(d) as Mode | null }).pipe(
        Effect.map((a) => ('refused' in a ? a : { answer: a.mode })),
      ),

    login: (d) =>
      askLogin(world, { given: null, kept: d.kept, current: currentOf(d) }).pipe(
        Effect.map((a) => ('refused' in a ? a : { answer: a.login })),
      ),

    branch: (d) => {
      const ctx = d.ctx
      if (ctx.answers.mode === 'team') {
        // Only for words: the descriptor's own `validate` runs the same check with the main the write will use.
        const typed = text(ctx.flags['main'])
        return askPersonal(world, {
          given: null,
          fallback: personalFallback(ctx),
          current: currentOf(d),
          main: typed ?? text(ctx.view.get(['branch', 'main'])) ?? '',
          kept: d.kept,
          validate: d.question.validate,
        }).pipe(Effect.map((a) => ('refused' in a ? a : { answer: a.personal })))
      }
      return askBaseBranch(world, {
        given: null,
        current: currentOf(d),
        detected: null,
        fallback: fallbackOf(d),
        validate: d.question.validate,
        kept: d.kept,
      })
    },

    'make-branch': (d) => {
      const ctx = d.ctx
      const at = ctx.answers.branch
      return askMakeBranch(world, {
        name: at?.name ?? 'the branch',
        from: at?.from ?? at?.main ?? 'main',
        where: ctx.ports.local ? { checkout: ctx.ports.checkout ?? '' } : { github: true },
        given: null,
        kept: d.kept,
      })
    },

    'move-landing': (d) =>
      askMoveLanding(world, {
        name: d.ctx.ports.project,
        oldRemote: text(keyIn(d.ctx.start.text(), ['repo', 'remote'])) ?? '',
        kept: d.kept,
      }).pipe(Effect.map((answer) => ({ answer }))),

    defaults: (d) => askEveryDefault(world, { given: null, kept: d.kept }),

    writer: (d) =>
      Effect.gen(function* () {
        const runtimes = yield* d.ctx.ports.runtimes
        return yield* askWriter(world, {
          given: null,
          offered: offeredRuntimes(runtimes),
          current: currentOf(d) as RuntimeName | null,
          fallback: fallbackOf(d),
          detected: null,
          validate: d.question.validate,
          kept: d.kept,
        })
      }),

    'writer-model': (d) =>
      askWriterModel(world, { given: null, current: currentOf(d), validate: d.question.validate, kept: d.kept }),

    reviewer: (d) =>
      Effect.gen(function* () {
        const runtimes = yield* d.ctx.ports.runtimes
        return yield* askReviewer(world, {
          given: null,
          offered: offeredRuntimes(runtimes),
          current: currentOf(d),
          fallback: fallbackOf(d),
          detected: null,
          validate: d.question.validate,
          kept: d.kept,
        })
      }),

    'reviewer-model': (d) =>
      askReviewerModel(world, { given: null, current: currentOf(d), validate: d.question.validate, kept: d.kept }),

    sandbox: (d) =>
      askSandboxMode(world, {
        given: null,
        current: currentOf(d) as 'on' | 'off' | null,
        fallback: fallbackOf(d),
        validate: d.question.validate,
        kept: d.kept,
      }),

    'sandbox-hosts': (d) =>
      askSandboxHosts(world, {
        given: null,
        current: currentOf(d),
        fallback: fallbackOf(d),
        builtIns: d.ctx.ports.proposal?.sandbox?.builtIns ?? [],
        validate: d.question.validate,
        kept: d.kept,
      }),

    install: (d) =>
      Effect.gen(function* () {
        const detected = yield* detection(d.ctx)
        return yield* askInstallCommand(world, {
          given: null,
          current: currentOf(d),
          fallback: fallbackOf(d),
          detected: detected?.install ?? null,
          validate: d.question.validate,
          kept: d.kept,
        })
      }),

    checks: (d) =>
      Effect.gen(function* () {
        const list = listOf(d.default)
        const detected = yield* detection(d.ctx)
        // What detection found explains a default only where the default came from it, not from the file's own list.
        const why = d.inForce === null && detected !== null ? detectionWhy(detected) : []
        const asked = yield* checksAsk(world, { list, why, kept: d.kept })
        if ('refused' in asked) return asked
        return { answer: JSON.stringify('keep' in asked ? list : asked.commands) }
      }),

    trial: (d) =>
      Effect.gen(function* () {
        const ctx = d.ctx
        const base = yield* trialBaseEffect({
          project: ctx.ports.project,
          owner: '',
          repo: '',
          base: ctx.answers.branch?.main ?? '',
          draft: viewWithMake(ctx.view, ctx.answers.make ?? null),
        })
        return yield* askTrial(world, {
          given: null,
          base,
          recipeExisted: ctx.start.text() !== null,
          fallback: fallbackOf(d),
          kept: d.kept,
        })
      }),

    tickets: (d) => askTicketSource(world, keepLimit(d)),

    kinds: (d) => askKindsList(world, keepLimit(d)),

    landing: (d) => askLandingChoice(world, keepLimit(d)),

    'refusal-fixes': (d) => askRefusalFixes(world, keepLimit(d)),

    'conflict-resolutions': (d) => askConflictResolutions(world, keepLimit(d)),

    wall: (d) => askWall(world, keepLimit(d)),

    budget: (d) => askBudget(world, keepLimit(d)),

    register: (d) => {
      const ctx = d.ctx
      const resolved = ctx.view.resolved()
      const summary = resolved === null ? null : summariseRecipe(resolved.recipe)
      return askRegister(world, {
        unseenEmptyBuild: summary !== null && summary.checks.length === 0 && ctx.buildFlags.length === 0,
        unseenUnattended:
          summary !== null && ctx.answers.mode !== 'team' && summary.landsUnattended && ctx.flags['land'] === undefined,
        base: summary?.base ?? '',
        given: null,
        kept: d.kept,
      })
    },
  }
}

/**
 * `ProjectPorts['trial']` over `trialFor`: runs the trial build over `runTrialLoop`, and on *edit* asks install and the
 * build list again through the same code the record's `install` and `checks` askers call. The `trial` entry has
 * already asked *try them once now?*, so the loop's first round does not (`askFirst: false`); an *edit* asks again,
 * as it always did. No terminal is refused where the loop refuses it: at *what to do with the failed build list*.
 */
export function trialPortOver(
  world: QuestionWorld,
  at: { project: string; home?: string | undefined },
  /** The trial to run, given the recipe as the answers so far make it and the base to cut from where it names none. */
  trialFor: (draft: ProjectView, base: string) => Trial,
): NonNullable<ProjectPorts['trial']> {
  return (pt) =>
    Effect.gen(function* () {
      // The branch still to be made is not on GitHub: the trial reads it as the one it is cut from.
      const view = viewWithMake(pt.view, pt.make)
      const original = pt.view.get(['steps', 'build'])
      const looped = yield* runTrialLoop(world, {
        trial: trialFor(view, pt.make?.from ?? text(view.get(['branch', 'main'])) ?? ''),
        install: pt.install,
        build: pt.checks,
        given: pt.given,
        recipeExisted: pt.recipeExisted,
        askFirst: false,
        recipeFile: recipePath(at.project, at.home),
        kept: pt.kept,
        again: {
          install: (previous) =>
            askInstallCommand(world, {
              given: pt.given.install,
              current: previous ?? 'none',
              detected: null,
              validate: (answer) => Effect.succeed(installRefusal(answer)),
              kept: pt.kept,
            }).pipe(Effect.map((a: Answered) => ('refused' in a ? a : { run: a.answer === 'none' ? null : a.answer }))),
          build: (previous: NamedRun[]) =>
            Effect.gen(function* () {
              // `--build` already answered the list: an edit of the install does not ask it again (as `askBuild`).
              if (pt.given.build !== null) {
                const build =
                  pt.given.build[0] === 'none'
                    ? []
                    : namedFromTyped(pt.given.build, Array.isArray(original) ? original : [])
                if (build.length === 0) world.log(NO_CHECKS_LINE)
                return { build }
              }
              const asked = yield* checksAsk(world, { list: previous.map((b) => b.run), why: [], kept: pt.kept })
              if ('refused' in asked) return asked
              if ('keep' in asked) return { build: previous.map(({ name, run }) => ({ name, run })) }
              if (asked.commands.length === 0) world.log(NO_CHECKS_LINE)
              return { build: namedFromTyped(asked.commands, Array.isArray(original) ? original : []) }
            }),
        },
      })
      if ('refused' in looped) return looped
      return { install: looped.install, checks: looped.build, trial: looped.trial }
    })
}

/** The live trial port: a throwaway worktree of the project, cut where the recipe lands. */
export const liveTrialPort = (
  world: QuestionWorld,
  at: Omit<TrialAt, 'base' | 'draft' | 'interrupt'>,
): NonNullable<ProjectPorts['trial']> =>
  trialPortOver(world, at, (draft, base) => liveTrialBuild({ ...at, base, draft }))
