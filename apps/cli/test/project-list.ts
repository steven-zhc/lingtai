/** A project list over fake ports; never writes a recipe or makes a branch. */
import { keyIn, type RecipeDraft } from '@lingtai/project'
import type { RecipeChange } from '@lingtai/recipe'
import { EMPTY_SETUP_READER, projectContext, projectList, runSetupList, type ProjectPorts } from '@lingtai/setup'
import { Effect } from 'effect'

import { projectAskers } from '../src/project-askers.ts'
import type { QuestionWorld } from '../src/question.ts'

export const RUNTIMES = [
  { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' },
  { id: 'codex', state: 'signed-in', signedIn: true, detail: 'signed in' },
] as const

export function walkProject(
  world: QuestionWorld,
  at: {
    flags?: Record<string, string>
    buildFlags?: readonly string[]
    start?: string | null
    seeds?: readonly RecipeChange[]
    ports?: Partial<ProjectPorts>
    interactive?: boolean
  } = {},
) {
  const text = at.start ?? null
  const start: RecipeDraft = {
    path: '/home/me/.lingtai/widget/recipe.yml',
    text: () => text,
    get: (p) => keyIn(text, p),
    set: () => Effect.die('the list may not set the draft'),
    changes: () => [],
  }
  const ports: ProjectPorts = {
    project: 'widget',
    local: false,
    checkout: null,
    knownLogin: 'sam',
    hostname: 'studio',
    defaultBranch: Effect.succeed('main'),
    branchExists: () => Effect.succeed(true),
    commitsOnlyIn: () => Effect.succeed([]),
    reader: EMPTY_SETUP_READER,
    runtimes: Effect.succeed(RUNTIMES),
    history: () => Effect.succeed([]),
    codexText: Effect.succeed(false),
    onPath: () => Effect.succeed(true),
    ...at.ports,
  }
  const flags = at.flags ?? {}
  const ctx = projectContext({
    start,
    ports,
    flags,
    buildFlags: at.buildFlags ?? [],
    kept: 'Nothing was written',
    seeds: at.seeds ?? (text === null ? [{ path: ['env', 'plantAt'], value: '.env.local' }] : []),
  })
  let printed = 0
  const flush = () => {
    for (; printed < ctx.log.length; printed++) world.log(ctx.log[printed]!)
  }
  const askers = Object.fromEntries(
    Object.entries(projectAskers(world)).map(([id, ask]) => [
      id,
      (d: Parameters<typeof ask>[0]) => {
        flush()
        return ask(d)
      },
    ]),
  )
  return runSetupList(
    projectList(ports),
    {
      flags,
      defaults: flags['defaults'] !== undefined,
      interactive: at.interactive ?? true,
      askers,
      log: world.log,
      kept: () => ({ kept: ctx.kept }),
    },
    ctx,
  ).pipe(
    Effect.map((result) => {
      flush()
      return { result, ctx }
    }),
  )
}
