/** A preview is an isolated list walk. Adoption copies its answers, never replays its reads or writes. */
import { Effect } from 'effect'

import { projectContext, projectList, type ProjectContext } from './project-list.ts'
import { runSetupList, setupRows, type SetupInput, type SetupRow } from './setup-list.ts'

export function forkProjectContext(ctx: ProjectContext): ProjectContext {
  const fork = projectContext({
    ...ctx,
    seeds: structuredClone(ctx.pending),
    // Construct the list without the trial capability, too: applicability captures the ports.
    ports: { ...ctx.ports, trial: undefined },
  })
  fork.answers = structuredClone(ctx.answers)
  return fork
}

export function runProjectList(
  ctx: ProjectContext,
  input: SetupInput<ProjectContext>,
  previewInput: SetupInput<ProjectContext>,
) {
  return Effect.gen(function* () {
    const list = projectList(ctx.ports)
    const split = list.findIndex((q) => q.defaultsSwitch)
    const prefix = yield* runSetupList(list.slice(0, split), input, ctx)
    if (prefix.refused !== undefined) return { ...prefix, rows: [] as SetupRow[] }
    const configuration = list.slice(split + 1).filter((q) => q.id !== 'trial' && q.id !== 'register')
    const fork = forkProjectContext(ctx)
    const previewList = projectList(fork.ports).filter((q) => configuration.some((c) => c.id === q.id))
    const preview = yield* runSetupList(previewList, { ...previewInput, log: () => {} }, fork)
    // Disabling the capability must not describe the preview as lacking a checkout.
    fork.answers.trial = { trial: 'not-run', because: 'declined' }
    const resolution = fork.view.resolution()
    const failure =
      preview.refused ??
      ('error' in resolution
        ? `this setup does not resolve — ${resolution.error instanceof Error ? resolution.error.message : String(resolution.error)}`
        : undefined)
    const rows = setupRows(previewList, fork)
    const why =
      failure === undefined
        ? rows.map((r) => `${r.label}  ${r.text}`)
        : [`${preview.failedId ?? 'setup'}  could not read — ${failure}`]
    const question = { ...list[split]!, why }
    const choice = yield* runSetupList([question], input, ctx)
    const entries = [...prefix.entries, ...choice.entries]
    if (choice.refused !== undefined) return { ...choice, entries, rows: [] as SetupRow[] }
    if (ctx.answers.defaults === 'yes') {
      if (failure !== undefined) return { refused: failure, entries, deferred: [], rows: [] as SetupRow[] }
      ctx.pending.splice(0, ctx.pending.length, ...fork.pending)
      ctx.answers = { ...fork.answers, defaults: 'yes' }
      // Preview diagnostics are discarded. Completion still runs against the live ports.
      const completion = yield* runSetupList(
        list.filter((q) => q.id === 'trial' || q.id === 'register'),
        {
          ...input,
          // A typed yes takes the trial's safe default without accepting registration.
          askers:
            ctx.flags['check-build'] === undefined
              ? { ...input.askers, trial: () => Effect.succeed({ answer: 'no' }) }
              : input.askers,
        },
        ctx,
      )
      return {
        ...completion,
        entries: [...entries, ...preview.entries, ...completion.entries],
        rows: setupRows(list, ctx),
      }
    }
    const rest = yield* runSetupList(list.slice(split + 1), input, ctx)
    return { ...rest, entries: [...entries, ...rest.entries], rows: setupRows(list, ctx) }
  })
}
