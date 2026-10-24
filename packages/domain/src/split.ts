/**
 * 0118 §12's `Split`: a concrete plan of child tickets and the order they
 * are worked in, and the one function that says whether it is sound.
 *
 * The same shape is two values. Triage's suggestion lives on
 * `TicketTooBig.split` and is bounded by the `TRIAGE_*` caps, because it is
 * an agent's text; the approved command is `Resolution.Split`, which a person
 * edited, and keeps only the structural rules. Nothing copies one into the
 * other.
 *
 * Imports `zod` and `triage.ts`'s constants only — the leaf-only rule of
 * `wait.ts`'s header applies here too.
 */
import { z } from 'zod'

import { TRIAGE_SPLIT_BODY_MAX, TRIAGE_SPLIT_CHILDREN_MAX, TRIAGE_TEXT_MAX } from './triage.ts'

/** A child's stable name inside the plan, which a dependency refers to. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const KEY_MAX = 40

/** One ticket the split would open. `kind` is the label the queue reads. */
export const ChildTicket = z.object({ key: z.string(), title: z.string(), body: z.string(), kind: z.string() })
export type ChildTicket = z.infer<typeof ChildTicket>

/** `ticket` is blocked by `blockedBy`; both name a child's `key`. */
export const Dependency = z.object({ ticket: z.string(), blockedBy: z.string() })
export type Dependency = z.infer<typeof Dependency>

const planShape = {
  children: z.array(ChildTicket),
  blockedBy: z.array(Dependency),
}

export interface SplitPlanShape {
  readonly children: readonly ChildTicket[]
  readonly blockedBy: readonly Dependency[]
}

/** What is wrong with a plan, naming the keys involved so a editor can point at the row. */
export type SplitProblem =
  | { readonly _tag: 'TooFewChildren'; readonly count: number }
  | { readonly _tag: 'BadKey'; readonly key: string }
  | { readonly _tag: 'DuplicateKey'; readonly key: string }
  | { readonly _tag: 'BlankTitle'; readonly key: string }
  | { readonly _tag: 'BlankBody'; readonly key: string }
  | { readonly _tag: 'UnknownKind'; readonly key: string; readonly kind: string }
  | { readonly _tag: 'MissingNode'; readonly key: string }
  | { readonly _tag: 'SelfDependency'; readonly key: string }
  | { readonly _tag: 'DuplicateDependency'; readonly ticket: string; readonly blockedBy: string }
  | { readonly _tag: 'Cycle'; readonly keys: readonly string[] }

export function describeSplitProblem(problem: SplitProblem): string {
  switch (problem._tag) {
    case 'TooFewChildren':
      return `a split needs at least two children, not ${problem.count}`
    case 'BadKey':
      return `child key "${problem.key}" must be lower case letters, digits and hyphens, up to ${KEY_MAX} characters`
    case 'DuplicateKey':
      return `child key "${problem.key}" is used more than once`
    case 'BlankTitle':
      return `child "${problem.key}" has no title`
    case 'BlankBody':
      return `child "${problem.key}" has no body`
    case 'UnknownKind':
      return `child "${problem.key}" has kind "${problem.kind}", which the queue does not read`
    case 'MissingNode':
      return `a dependency names "${problem.key}", which is not a child`
    case 'SelfDependency':
      return `child "${problem.key}" is blocked by itself`
    case 'DuplicateDependency':
      return `"${problem.ticket}" is blocked by "${problem.blockedBy}" more than once`
    case 'Cycle':
      return `dependencies form a cycle: ${problem.keys.join(' -> ')}`
  }
}

/**
 * Every problem with `plan`, empty when it is sound. `kinds` is the recipe's
 * `source.kinds`; the domain cannot see the recipe, so the schema calls this
 * without it and `resolveWait` with it. A kind outside it is a child the
 * queue would never see.
 */
export function splitPlanProblems(plan: SplitPlanShape, options: { kinds?: readonly string[] } = {}): SplitProblem[] {
  const problems: SplitProblem[] = []
  if (plan.children.length < 2) problems.push({ _tag: 'TooFewChildren', count: plan.children.length })

  const keys = new Set<string>()
  for (const child of plan.children) {
    if (!KEY_PATTERN.test(child.key) || child.key.length > KEY_MAX) problems.push({ _tag: 'BadKey', key: child.key })
    if (keys.has(child.key)) problems.push({ _tag: 'DuplicateKey', key: child.key })
    keys.add(child.key)
    if (child.title.trim().length === 0) problems.push({ _tag: 'BlankTitle', key: child.key })
    if (child.body.trim().length === 0) problems.push({ _tag: 'BlankBody', key: child.key })
    if (options.kinds !== undefined && !options.kinds.includes(child.kind))
      problems.push({ _tag: 'UnknownKind', key: child.key, kind: child.kind })
  }

  const edges = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const { ticket, blockedBy } of plan.blockedBy) {
    let usable = true
    for (const key of [ticket, blockedBy]) {
      if (!keys.has(key)) {
        problems.push({ _tag: 'MissingNode', key })
        usable = false
      }
    }
    if (!usable) continue
    if (ticket === blockedBy) {
      problems.push({ _tag: 'SelfDependency', key: ticket })
      continue
    }
    const id = JSON.stringify([ticket, blockedBy])
    if (seen.has(id)) {
      problems.push({ _tag: 'DuplicateDependency', ticket, blockedBy })
      continue
    }
    seen.add(id)
    edges.set(ticket, [...(edges.get(ticket) ?? []), blockedBy])
  }

  const cycle = findCycle(edges)
  if (cycle !== null) problems.push({ _tag: 'Cycle', keys: cycle })
  return problems
}

/** One cycle in `edges` (node → what blocks it) as `a, b, …, a`, or `null`. */
function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const done = new Set<string>()
  const path: string[] = []
  const visit = (node: string): string[] | null => {
    const at = path.indexOf(node)
    if (at >= 0) return [...path.slice(at), node]
    if (done.has(node)) return null
    path.push(node)
    for (const next of edges.get(node) ?? []) {
      const found = visit(next)
      if (found !== null) return found
    }
    path.pop()
    done.add(node)
    return null
  }
  for (const node of edges.keys()) {
    const found = visit(node)
    if (found !== null) return found
  }
  return null
}

const refuseProblems = (plan: SplitPlanShape, ctx: z.RefinementCtx): void => {
  for (const problem of splitPlanProblems(plan))
    ctx.addIssue({ code: 'custom', message: describeSplitProblem(problem) })
}

/** The plan a person approves: the structural rules and nothing about size. */
export const SplitPlan = z.object(planShape).superRefine(refuseProblems)
export type SplitPlan = z.infer<typeof SplitPlan>

/** `SplitPlan` as the resolution a person submits, tagged for `Resolution`'s union. */
export const SplitResolution = z.object({ _tag: z.literal('Split'), ...planShape }).superRefine(refuseProblems)

/** Triage's suggestion: the same plan, bounded because an agent wrote it. */
export const SplitProposal = z
  .object({
    children: z
      .array(
        z.object({
          key: z.string().max(KEY_MAX),
          title: z.string().max(TRIAGE_TEXT_MAX),
          body: z.string().max(TRIAGE_SPLIT_BODY_MAX),
          kind: z.string().max(TRIAGE_TEXT_MAX),
        }),
      )
      .max(TRIAGE_SPLIT_CHILDREN_MAX),
    blockedBy: z.array(Dependency).max(TRIAGE_SPLIT_CHILDREN_MAX * TRIAGE_SPLIT_CHILDREN_MAX),
  })
  .superRefine(refuseProblems)
export type SplitProposal = z.infer<typeof SplitProposal>
