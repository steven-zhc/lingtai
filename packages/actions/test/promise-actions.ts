import type { Step } from '@lingtai/domain'
import type { StepAction } from '@lingtai/recipe'
/**
 * The promise shape of an action, for the tests that await one. Production holds
 * ports (`ActionPort`) and runs them as Effects; `actionOver` in `src/action.ts`
 * is the one registry both shapes share, and the `Effect.runPromise` that turns a
 * port into a promise lives here, outside the ratchet's count.
 */
import { Effect } from 'effect'

import {
  actionOver,
  fromPromiseAction,
  runActionPipelineEffect,
  type Action,
  type ActionPort,
  type PipelineOptions,
  type PipelineResult,
} from '../src/action.ts'
import {
  agentPortDepsFrom,
  makeAgentAction,
  makeDraftAction,
  type AgentActionDeps,
  type AgentActionSpec,
} from '../src/agent-action.ts'
import { filePortDepsFrom, makeFileAction, type FileActionDeps, type FileActionSpec } from '../src/file-action.ts'
import {
  fileBriefPortDepsFrom,
  makeFileBriefAction,
  type FileBriefActionDeps,
  type FileBriefActionSpec,
} from '../src/file-brief-action.ts'
import { actionPortDepsFrom, actionPortsFromRecipe, type ActionDeps } from '../src/from-recipe.ts'
import { makeHumanAction, type HumanActionSpec } from '../src/human-action.ts'
import { keptRunPortDepsFrom, makeKeptRunAction, type KeptRunActionDeps } from '../src/kept-run-action.ts'
import { makeMergeAction, mergePortDepsFrom, type MergeActionDeps, type MergeActionSpec } from '../src/merge-action.ts'
import { makeProcessAction, type ProcessActionSpec } from '../src/process-action.ts'
import { makeQueueAction, queuePortDepsFrom, type QueueActionDeps, type QueueActionSpec } from '../src/queue-action.ts'
import { makeWatchAction, watchPortDepsFrom, type WatchActionDeps, type WatchActionSpec } from '../src/watch-action.ts'
import { makeWorkAction, workPortDepsFrom, type WorkActionDeps, type WorkActionSpec } from '../src/work-action.ts'
import {
  makeWorktreeAction,
  worktreePortDepsFrom,
  type WorktreeActionDeps,
  type WorktreeActionSpec,
} from '../src/worktree-action.ts'

/** The promise shape of a port: same name, kind and yields, `run` awaited. */
export const promiseAction = (port: ActionPort): Action =>
  actionOver(port, (context) => Effect.runPromise(port.run(context)))

export const createAgentAction = (spec: AgentActionSpec, deps: AgentActionDeps): Action =>
  promiseAction(makeAgentAction(spec, agentPortDepsFrom(deps)))
export const createDraftAction = (spec: AgentActionSpec, deps: AgentActionDeps): Action =>
  promiseAction(makeDraftAction(spec, agentPortDepsFrom(deps)))
export const createFileAction = (spec: FileActionSpec, deps: FileActionDeps): Action =>
  promiseAction(makeFileAction(spec, filePortDepsFrom(deps)))
export const createFileBriefAction = (spec: FileBriefActionSpec, deps: FileBriefActionDeps): Action =>
  promiseAction(makeFileBriefAction(spec, fileBriefPortDepsFrom(deps)))
export const createHumanAction = (spec: HumanActionSpec): Action => promiseAction(makeHumanAction(spec))
export const createKeptRunAction = (name: string, inner: Action, deps: KeptRunActionDeps): Action =>
  promiseAction(makeKeptRunAction(name, fromPromiseAction(inner), keptRunPortDepsFrom(deps)))
export const createMergeAction = (spec: MergeActionSpec, deps: MergeActionDeps): Action =>
  promiseAction(makeMergeAction(spec, mergePortDepsFrom(deps)))
export const createProcessAction = (spec: ProcessActionSpec): Action => promiseAction(makeProcessAction(spec))
export const createQueueAction = (spec: QueueActionSpec, deps: QueueActionDeps): Action =>
  promiseAction(makeQueueAction(spec, queuePortDepsFrom(deps)))
export const createWatchAction = (spec: WatchActionSpec, deps: WatchActionDeps): Action =>
  promiseAction(makeWatchAction(spec, watchPortDepsFrom(deps)))
export const createWorkAction = (spec: WorkActionSpec, deps: WorkActionDeps): Action =>
  promiseAction(makeWorkAction(spec, workPortDepsFrom(deps)))
export const createWorktreeAction = (spec: WorktreeActionSpec, deps: WorktreeActionDeps): Action =>
  promiseAction(makeWorktreeAction(spec, worktreePortDepsFrom(deps)))

/** The promise shape of `actionPortsFromRecipe`: the same actions, each through `promiseAction`. */
export const actionsFromRecipe = (step: Step, actions: readonly StepAction[], deps: ActionDeps = {}): Action[] =>
  actionPortsFromRecipe(step, actions, actionPortDepsFrom(deps)).map(promiseAction)

/** The promise shape of `runActionPipelineEffect`: the same pipeline, awaited. */
export const runActionPipeline = (options: PipelineOptions): Promise<PipelineResult> =>
  Effect.runPromise(runActionPipelineEffect({ ...options, actions: options.actions.map(fromPromiseAction) }))
