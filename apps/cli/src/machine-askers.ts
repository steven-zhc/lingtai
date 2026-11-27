/**
 * The terminal's input to the machine list (0125 §9, #1522): one asker per question id, and the ports the
 * list reads the world through. **No list is defined here** — `machineQuestions` is `@lingtai/setup`'s —
 * and `MACHINE_ASKERS` is typed over `MachineQuestionId`, so a question added to the list without an
 * asker fails `tsc`.
 */
import { join } from 'node:path'

import {
  claudeTokenState,
  machineDayCeiling,
  machineFileFrom,
  redactUrl,
  stateDir,
  storeChoice,
  githubAuthElectionFrom,
} from '@lingtai/env'
import type { SchemaOutcome } from '@lingtai/event-store/schema'
import type { EventStore } from '@lingtai/event-store/store'
import type { GhRun, GhStatus } from '@lingtai/github'
import { loadAllProjectsEffect, recipePath, recipeText } from '@lingtai/project'
import { resolveSource, type Recipe } from '@lingtai/recipe'
import {
  type Asker,
  type MachinePorts,
  type MachineQuestionId,
  type MachineText,
  type SetupInput,
  type SetupQuestion,
  liveMachineText,
  machineQuestions,
  runSetupList,
} from '@lingtai/setup'
import { Effect } from 'effect'

import type { AppCheck } from './app-check.ts'
import { claudeTokenAsker, liveSetupTokenRun, obtainClaudeToken, type ClaudeTokenWorld } from './claude-token.ts'
import { githubAuthAsker, type GithubAuthAnswer } from './github-auth.ts'
import { questionEffect, spunEffect, type QuestionWorld } from './question.ts'

/** The slice of a world the machine list reads: `init`'s `InitWorld` has all of it, and `add` builds it live. */
export interface MachineWorld extends QuestionWorld {
  env: NodeJS.ProcessEnv
  machine: MachineText
  /** `config.yml`'s path. */
  path: string
  /** False where there is no terminal. Never inferred from `ask` answering nothing. */
  interactive: boolean
  /** Connect, and create the tables where there are none. Absent where the store is never asked (`add`). */
  database?: (url: string) => Effect.Effect<{ ok: true; schema: SchemaOutcome } | { ok: false; why: string }, unknown>
  app: () => Effect.Effect<AppCheck, unknown>
  ghStatus: () => Effect.Effect<GhStatus, unknown>
  gh?: GhRun
  /** Every registered project's recipe that can be read. */
  recipes: () => Effect.Effect<readonly Recipe[], unknown>
  run: ClaudeTokenWorld['run']
}

/** The registered projects' recipes, each read the way `lingtai add` does; one that cannot be read is left out. */
export const registeredRecipes = (opts: {
  projects: () => Effect.Effect<readonly { project: string | null }[], unknown>
  home: string
  store?: EventStore
}): Effect.Effect<readonly Recipe[], unknown> =>
  Effect.gen(function* () {
    const found: Recipe[] = []
    for (const p of yield* opts.projects()) {
      if (typeof p.project !== 'string') continue
      const path = recipePath(p.project, opts.home)
      const text = yield* recipeText(p.project, {
        home: opts.home,
        ...(opts.store === undefined ? {} : { store: opts.store }),
      }).pipe(Effect.catch(() => Effect.succeed(null)))
      if (text === null) continue
      try {
        found.push(resolveSource(text, path, path).recipe)
      } catch {
        // A recipe that cannot be read is not one that needs the token; the project path refuses it (0125 §6).
      }
    }
    return found
  })

/** `add`'s world, over the live machine: the process's environment, `~/.lingtai/config.yml`, a real `gh`. */
export const liveMachineWorld = (
  base: Pick<QuestionWorld, 'ask' | 'log' | 'spin'>,
  extra: Pick<MachineWorld, 'app' | 'ghStatus'> & { gh?: GhRun },
): MachineWorld => ({
  ...base,
  env: process.env,
  machine: liveMachineText(),
  path: join(stateDir(process.env), 'config.yml'),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  recipes: () => registeredRecipes({ projects: () => loadAllProjectsEffect(), home: stateDir(process.env) }),
  run: liveSetupTokenRun(),
  ...extra,
})

export interface MachineSetup {
  ports: MachinePorts
  list: readonly SetupQuestion[]
  askers: Record<MachineQuestionId, Asker>
  /** `GET /app` once per setup, however many entries ask. */
  app: () => Effect.Effect<AppCheck, unknown>
  /** What the last check of this URL created or found. */
  schemaOf: (url: string) => SchemaOutcome | undefined
  input: (o: { flags: Readonly<Record<string, string>>; defaults: boolean } & Partial<SetupInput>) => SetupInput
}

/** The ports, the list and the askers for one run, over `world`. */
export function machineSetup(world: MachineWorld, opts: { githubRequired: boolean; command?: string }): MachineSetup {
  const schemas = new Map<string, SchemaOutcome>()
  let appMemo: AppCheck | null = null
  const app = (): Effect.Effect<AppCheck, unknown> =>
    Effect.gen(function* () {
      appMemo ??= yield* world.app()
      return appMemo
    })
  const tokenWorld: ClaudeTokenWorld & QuestionWorld = {
    ask: world.ask,
    log: world.log,
    run: world.run,
    machine: world.machine,
    path: world.path,
    env: world.env,
    interactive: world.interactive,
  }
  const fileNow = () => machineFileFrom(world.path, world.machine.read(world.path))

  const ports: MachinePorts = {
    path: world.path,
    machine: world.machine,
    env: world.env,
    say: world.log,
    store: () => {
      const read = storeChoice(world.env, fileNow())
      if ('refused' in read) {
        return read.because === 'nothing chosen' ? { store: null } : { store: null, fault: read.refused }
      }
      return read.store === 'sqlite'
        ? { store: 'sqlite' }
        : { store: 'postgres', url: read.url, environment: read.where === 'environment' }
    },
    githubAuth: () => {
      const read = githubAuthElectionFrom(world.env, fileNow())
      if ('refused' in read) return { refused: read.refused, environment: read.refused.startsWith('LINGTAI_') }
      if (read.kind === null) {
        return read.none === undefined
          ? { kind: null, environment: false, written: false }
          : { kind: 'none', environment: read.none.startsWith('LINGTAI_'), written: true }
      }
      const exported = read.source.startsWith('LINGTAI_GITHUB_AUTH')
      return { kind: read.kind, environment: exported, written: exported || read.source.endsWith('github.auth') }
    },
    dayCeiling: () => {
      const exported = world.env['LINGTAI_LIMITS_DAY_USD']
      const environment = exported !== undefined && exported !== ''
      try {
        const value = machineDayCeiling(world.env, fileNow())
        return { value: value ?? null, environment }
      } catch (e) {
        return { fault: (e as Error).message, environment }
      }
    },
    tokenState: () => {
      try {
        return claudeTokenState(world.env, world.path, world.machine.read(world.path))
      } catch {
        return { unreadable: `${world.path} could not be read, so claude.oauth_token is unknown` }
      }
    },
    database: (url) =>
      world.database === undefined
        ? Effect.succeed({ ok: false, why: 'this command has no database to connect to' } as const)
        : spunEffect(world, 'connecting to the database', world.database(url)).pipe(
            Effect.map((check) => {
              if (check.ok) {
                schemas.set(url, check.schema)
                return { ok: true } as const
              }
              return { ok: false, why: check.why } as const
            }),
          ),
    ghStatus: world.ghStatus,
    app,
    recipes: world.recipes,
    obtainToken: () => obtainClaudeToken(tokenWorld, false),
  }

  const storeAsker: Asker = (d) =>
    Effect.gen(function* () {
      const current = d.inForce === null ? undefined : (d.default ?? '')
      return yield* questionEffect(world, {
        name: d.question.name,
        command: opts.command ?? 'lingtai init',
        flag: d.question.flag,
        given: null,
        // Where Postgres is what answers, an empty answer keeps it, so SQLite is a word of its own.
        prompt:
          current !== undefined && current !== ''
            ? 'a Postgres URL for the log — empty keeps the one shown, sqlite for SQLite'
            : 'a Postgres URL for the log — empty for SQLite',
        ...(current === undefined ? {} : { current }),
        fallback: d.default ?? '',
        show: redactUrl,
        secret: true,
        kept: d.kept,
        ...(d.startOver === undefined ? {} : { startOver: d.startOver }),
        validate: d.question.validate,
      })
    })

  const ceilingAsker: Asker = (d) =>
    questionEffect(world, {
      name: d.question.name,
      command: opts.command ?? 'lingtai init',
      flag: d.question.flag,
      given: null,
      prompt:
        'the most one day may spend, in dollars — a positive number, or none for no ceiling ' +
        '(without one the conductor runs a single attempt at a time)',
      ...(d.inForce !== null && !('fault' in d.inForce) ? { current: d.default ?? '' } : {}),
      fallback: d.default ?? '100',
      kept: d.kept,
      ...(d.startOver === undefined ? {} : { startOver: d.startOver }),
      validate: d.question.validate,
    })

  const askers: Record<MachineQuestionId, Asker> = {
    store: storeAsker,
    github: githubAuthAsker(
      { ...world, github: { ghStatus: world.ghStatus, ...(world.gh === undefined ? {} : { gh: world.gh }) } },
      { command: opts.command ?? 'lingtai init' },
    ),
    ceiling: ceilingAsker,
    'claude-token': claudeTokenAsker(tokenWorld),
  }

  return {
    ports,
    list: machineQuestions(ports, { githubRequired: opts.githubRequired }),
    askers,
    app,
    schemaOf: (url) => schemas.get(url),
    input: (o) => ({
      interactive: world.interactive,
      askers,
      log: world.log,
      ...o,
    }),
  }
}

/**
 * The token's entry on its own, for a project path whose recipe has just been made — `add`, which asks no other
 * machine question but GitHub's, and `init`'s deferred entries. Never refuses the add: a refusal here is a line.
 */
export const askTokenFor = (
  setup: MachineSetup,
  world: Pick<MachineWorld, 'log'>,
  flags: Readonly<Record<string, string>>,
  recipe: Recipe,
  list: readonly SetupQuestion[] = setup.list.filter((q) => q.id === 'claude-token'),
): Effect.Effect<void, unknown> =>
  runSetupList(list, setup.input({ flags, defaults: flags['defaults'] !== undefined }), { draft: recipe }).pipe(
    Effect.map((result) => {
      if (result.refused !== undefined) world.log(result.refused)
    }),
  )

/**
 * `lingtai add`'s GitHub question (#1487): the list's own GitHub entry, with `none` refused as an answer, run alone.
 * Where the environment decided there is nothing to read back, and `none` is what it reports.
 */
export const githubEntryFor = (
  world: MachineWorld,
  flags: Readonly<Record<string, string>>,
  kept: string,
  /** `add`'s: a GitHub project needs a way to reach GitHub, so `none` is refused. */
  required = true,
): Effect.Effect<GithubAuthAnswer, unknown> => {
  const setup = machineSetup(world, { githubRequired: required, command: 'lingtai add' })
  return runSetupList(
    setup.list.filter((q) => q.id === 'github'),
    setup.input({ flags, defaults: flags['defaults'] !== undefined }),
  ).pipe(
    Effect.map((result): GithubAuthAnswer => {
      if (result.refused !== undefined) return { refused: `${result.refused}. ${kept}` }
      const entry = result.entries[0]!
      return { auth: (entry.after ?? 'none') as 'gh' | 'app' | 'none', pending: entry.pending }
    }),
  )
}
