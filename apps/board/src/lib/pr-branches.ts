/**
 * A PR's three branches, drawn from its events (#1373): the agreed mock is `doc/milestone/0.16.0/team-mode/pr-branches.html`.
 *
 * Two pure functions. `prBranches` decides **what is drawn**, in log order: lanes, nodes, edges, the brace of tickets and
 * where *now* is. `layoutBranches` decides **where**, by the mock's rule: lanes at fixed heights, time left to right, every
 * connector at 45° with the node it reaches placed to fit. Tests match nodes and edges, never pixel positions.
 *
 * **Draw only what the log says.** A node with no event behind it is drawn hollow (`todo`) or not at all, never as done.
 * **No git here**: the board reads events and never git (`events.ts` `PrMergedBack`'s note, #1314), so the `main` commit a
 * sync merged is `BranchSynced.mainCommit` — recorded since the event was added — and nothing reads `main`'s tip later.
 * That is why the mock's frame 11 (*`e4c4ae6` · not in this PR*) draws as frame 08: no event names that commit while the
 * PR is in review.
 */
import { type Envelope, type PayloadOf, type PrState, prStepRows } from '@lingtai/domain'

import { type DraftTicket, WAIT_WORDS } from './pr-board.ts'

export type BranchLane = 'main' | 'pr' | 'personal'

export interface BranchNode {
  readonly id: string
  readonly lane: BranchLane
  readonly kind: 'done' | 'todo' | 'running' | 'waiting' | 'ticket' | 'outside' | 'main' | 'merged'
  readonly label: string
  /** The commit the node is, or null where no event names one. */
  readonly sha: string | null
  /** A node that anchors a connector and shows nothing: where the PR branch starts and ends. */
  readonly hidden?: true
  readonly tone?: 'mut' | 'red' | 'sig'
  /** The longer word a tooltip carries. */
  readonly title?: string
  /** Which walk it belongs to; 0 is the freeze, which no cap drops. */
  readonly walk: number
}

export interface BranchEdge {
  readonly from: string
  readonly to: string
  readonly kind: 'fork' | 'sync' | 'back' | 'merge' | 'catch-up'
  readonly state: 'done' | 'todo' | 'red'
}

export interface BranchModel {
  readonly lanes: {
    readonly main: string
    readonly personal: string
    readonly pr: string | null
    readonly gone: boolean
  }
  readonly nodes: readonly BranchNode[]
  readonly edges: readonly BranchEdge[]
  /** The tickets' brace under the personal lane: its words and the two nodes it spans. */
  readonly brace: { readonly text: string; readonly from: string; readonly to: string } | null
  /** The node *now* stands at. */
  readonly now: string | null
  /** Words where a line would lie, and what the gutter says. */
  readonly words: readonly string[]
}

export interface BranchOptions {
  readonly main: string
  readonly personal: string
  /** The conductor's own step list, in order. */
  readonly stepNames: readonly string[]
}

const TICKET_DOTS = 5
const WALKS_SHOWN = 3
const short = (sha: string | null): string => (sha === null ? '?' : sha.slice(0, 7))
const STEP_WORD: Record<string, string> = {
  sync: 'sync',
  build: 'build',
  ci: 'CI',
  push: 'push',
  open: 'open',
  ready: 'ready',
}

interface Walk {
  readonly n: number
  sync: { node: BranchNode; main: BranchNode; edge: BranchEdge; done: boolean } | null
  how: PayloadOf<'BranchSynced'>['how'] | null
  ready: boolean
  tail: BranchNode | null
  closed: boolean
}

/** What is drawn for one PR, or for the draft when `pr` is null. `null` when the draft's tickets could not be read. */
export function prBranches(
  pr: PrState | null,
  events: readonly Envelope[],
  draft: readonly DraftTicket[] | { readonly error: string },
  opts: BranchOptions,
): BranchModel | null {
  const lanes = {
    main: pr?.main ?? opts.main,
    personal: pr?.branch ?? opts.personal,
    pr: pr?.prBranch ?? null,
    gone: false,
  }
  if (pr === null) {
    if ('error' in draft) return null
    const shown = draft.slice(0, TICKET_DOTS)
    const nodes: BranchNode[] = shown.map((t, i) => ({
      id: `t${i}`,
      lane: 'personal',
      kind: 'ticket',
      label: `#${t.ticket}`,
      sha: null,
      title: `#${t.ticket} ${t.title}`,
      walk: 0,
    }))
    nodes.push({ id: 'submit', lane: 'personal', kind: 'todo', label: 'Submit freezes here', sha: null, walk: 0 })
    const text = `${draft.length} ${draft.length === 1 ? 'ticket' : 'tickets'} not in a PR yet${draft.length > shown.length ? ` · +${draft.length - shown.length} more` : ''}`
    return {
      lanes,
      nodes,
      edges: [],
      brace: shown.length === 0 ? null : { text, from: 't0', to: `t${shown.length - 1}` },
      now: 'submit',
      words: ['no PR yet'],
    }
  }

  const nodes: BranchNode[] = []
  const edges: BranchEdge[] = []
  const words: string[] = []
  let counter = 0
  const add = (n: Omit<BranchNode, 'id' | 'walk'>, walk: number): BranchNode => {
    const node: BranchNode = { ...n, id: `n${counter++}`, walk }
    nodes.push(node)
    return node
  }
  const total = events.filter((e) => e.type === 'PrInProgress').length
  if (total === 0) return { lanes, nodes, edges, brace: null, now: null, words: ['not started'] }

  const walks: Walk[] = []
  let walk: Walk | null = null
  let frozen: BranchNode | null = null
  // The commit the personal branch was frozen at: only the first `PrInProgress`'s. A later walk's `frozenSha` is the PR
  // branch's own head (a pr-fix lands there), which the personal branch does not hold until it is merged back.
  let personalFrozen: string | null = null
  let backRequested = false
  let closedNode: BranchNode | null = null
  let lastMergedBack: { node: BranchNode; index: number } | null = null
  let mergedBackCount = 0
  const backHeads = new Set<string>()
  const failedHeads = new Set<string>()
  let nowNode: BranchNode | null = null

  // The step the latest walk is in the middle of: running, or the one it waits at. A close after a wait keeps the wait.
  const waitOf = (): PayloadOf<'PrWaiting'> | null => {
    if (pr.status === 'waiting') return pr.wait
    if (pr.status !== 'closed') return null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (e.type === 'PrInProgress') return null
      if (e.type === 'PrWaiting') return e.data as PayloadOf<'PrWaiting'>
    }
    return null
  }

  const syncNode = (
    w: Walk,
    kind: BranchNode['kind'],
    label: string,
    sha: string | null,
    state: BranchEdge['state'],
  ) => {
    const main = add({ lane: 'main', kind: 'main', label: '', sha: null }, w.n)
    const node = add({ lane: 'pr', kind, label, sha }, w.n)
    const edge: BranchEdge = { from: main.id, to: node.id, kind: 'sync', state }
    edges.push(edge)
    w.sync = { node, main, edge, done: state === 'done' }
    return w.sync
  }

  /** The end of a walk's steps: the latest walk's from the PR's own state, an earlier walk's keeps only its ready. */
  const closeWalk = (w: Walk) => {
    if (w.closed) return
    w.closed = true
    if (w.n !== total) {
      if (w.ready) w.tail = add({ lane: 'pr', kind: 'done', label: 'ready', sha: null }, w.n)
      else w.tail = w.sync?.node ?? w.tail
      return
    }
    const rows = prStepRows(opts.stepNames, pr)
    const done = (s: string) => rows.some((r) => r.step === s && r.status === 'done')
    const wait = waitOf()
    let inFlight = false
    let last: BranchNode | null = w.sync?.node ?? w.tail
    for (const r of rows) {
      if (r.status === 'done') {
        if (r.step === 'build') last = add({ lane: 'pr', kind: 'done', label: 'build ✓', sha: r.headSha }, w.n)
        else if (r.step === 'push')
          last = add(
            {
              lane: 'pr',
              kind: 'done',
              label: pr.host === null ? 'pushed' : `pushed · #${pr.host.number}`,
              sha: r.headSha,
            },
            w.n,
          )
        else if (r.step === 'ci' && !done('ready'))
          last = add({ lane: 'pr', kind: 'done', label: 'CI ✓', sha: r.headSha }, w.n)
        else if (r.step === 'ready')
          last = add({ lane: 'pr', kind: 'done', label: done('ci') ? 'CI ✓ · ready' : 'ready', sha: r.headSha }, w.n)
        continue
      }
      if (inFlight) continue
      const word = STEP_WORD[r.step] ?? r.step
      if (wait !== null && wait.step === r.step) {
        inFlight = true
        const label = WAIT_WORDS[wait.reason]
        if (r.step === 'sync' && w.sync === null) {
          const conflictMain = wait.conflict?.merging === 'main' ? wait.conflict.commit : null
          const s = syncNode(w, 'waiting', label, null, 'red')
          nodes[nodes.indexOf(s.main)] = {
            ...s.main,
            sha: conflictMain,
            label: conflictMain === null ? '' : short(conflictMain),
          }
          last = s.node
          nowNode = s.node
        } else {
          last = add({ lane: 'pr', kind: 'waiting', label, sha: wait.headSha, tone: 'red', title: wait.detail }, w.n)
          nowNode = last
        }
      } else if (pr.status === 'in-progress' || pr.status === 'requested') {
        inFlight = true
        if (r.step === 'sync' && w.sync === null) {
          const s = syncNode(w, 'running', 'sync …', null, 'todo')
          last = s.node
          nowNode = s.node
        } else {
          last = add({ lane: 'pr', kind: 'running', label: `${word} …`, sha: null, tone: 'sig' }, w.n)
          nowNode = last
        }
      }
    }
    if (!done('ready') && pr.status !== 'closed' && pr.status !== 'merged') {
      last = add({ lane: 'pr', kind: 'todo', label: 'ready', sha: null }, w.n)
    }
    w.tail = last
  }

  const start = (e: Envelope, first: boolean) => {
    const d = e.data as PayloadOf<'PrInProgress'>
    if (first) {
      const shown = d.tickets.slice(0, TICKET_DOTS)
      for (const t of shown)
        add(
          {
            lane: 'personal',
            kind: 'ticket',
            label: `#${t.ticket}`,
            sha: t.mergeCommit,
            title: `#${t.ticket} ${t.title}`,
          },
          0,
        )
      personalFrozen = d.frozenSha
      frozen = add({ lane: 'personal', kind: 'done', label: `${short(d.frozenSha)} frozen`, sha: d.frozenSha }, 0)
    }
    const w: Walk = { n: walks.length + 1, sync: null, how: null, ready: false, tail: null, closed: false }
    walks.push(w)
    walk = w
    if (first) {
      const p0 = add({ lane: 'pr', kind: 'done', label: '', sha: d.frozenSha, hidden: true }, 0)
      edges.push({ from: frozen!.id, to: p0.id, kind: 'fork', state: 'done' })
      w.tail = p0
    } else w.tail = walks[walks.length - 2]?.tail ?? null
  }

  for (const e of events) {
    const w = walk as Walk | null
    switch (e.type) {
      case 'PrInProgress':
        if (w !== null) closeWalk(w)
        nowNode = null
        start(e, w === null)
        break
      case 'PrOpened':
        if (w !== null && (e.data as PayloadOf<'PrOpened'>).host !== 'none') w.ready = true
        break
      case 'PrStepDone': {
        const d = e.data as PayloadOf<'PrStepDone'>
        if (w === null) break
        if (d.step === 'ready') w.ready = true
        // A clean merge is done before its build has run: the merge exists, but *main is in the PR's commit* is not yet true.
        if (d.step === 'sync' && w.sync === null) {
          const s = syncNode(w, 'done', `${short(d.headSha)} sync`, d.headSha, 'todo')
          if (d.main !== undefined) nodes[nodes.indexOf(s.main)] = { ...s.main, label: short(d.main), sha: d.main }
          w.tail = s.node
        }
        break
      }
      case 'BranchSynced': {
        if (w === null) break
        const d = e.data as PayloadOf<'BranchSynced'>
        w.how = d.how
        if (w.sync === null || w.sync.done) {
          if (d.how === 'already') {
            // Nothing was merged: main's commit is drawn, and no line from it.
            const main = add(
              {
                lane: 'main',
                kind: 'main',
                label: `${short(d.mainCommit)} — already in ${w.n === 1 ? 'your branch' : 'this PR'}`,
                sha: d.mainCommit,
              },
              w.n,
            )
            w.tail = add({ lane: 'pr', kind: 'done', label: 'sync: nothing to merge', sha: d.head, tone: 'mut' }, w.n)
            w.sync = {
              node: w.tail,
              main,
              edge: { from: main.id, to: w.tail.id, kind: 'sync', state: 'done' },
              done: true,
            }
          } else {
            const s = syncNode(w, 'done', `${short(d.head)} sync`, d.head, 'done')
            nodes[nodes.indexOf(s.main)] = { ...s.main, label: short(d.mainCommit), sha: d.mainCommit }
            w.tail = s.node
          }
        } else {
          // The sync step wrote its merge before the build ran; the event that says main is in it completes the node.
          const s = w.sync
          nodes[nodes.indexOf(s.main)] = { ...s.main, label: short(d.mainCommit), sha: d.mainCommit }
          nodes[nodes.indexOf(s.node)] = { ...s.node, label: `${short(d.head)} sync`, sha: d.head }
          const at = edges.indexOf(s.edge)
          edges[at] = { ...s.edge, state: 'done' }
          s.done = true
          w.tail = nodes.find((n) => n.id === s.node.id) ?? s.node
        }
        break
      }
      case 'PrOutsideMerged': {
        if (w === null) break
        const d = e.data as PayloadOf<'PrOutsideMerged'>
        const first = d.commits[0]
        const more = d.commits.length - 1 + d.omitted
        const label =
          first === undefined ? short(d.head) : `${short(first.sha)} · ${first.author}${more > 0 ? ` +${more}` : ''}`
        w.tail = add({ lane: 'pr', kind: 'outside', label, sha: d.head, tone: 'sig' }, w.n)
        break
      }
      case 'PrHeadAdopted': {
        if (w === null) break
        const d = e.data as PayloadOf<'PrHeadAdopted'>
        w.tail = add(
          { lane: 'pr', kind: 'outside', label: `${short(d.head)} · ${d.by}`, sha: d.head, tone: 'sig' },
          w.n,
        )
        break
      }
      case 'PrFixLanded': {
        if (w === null) break
        closeWalk(w)
        const d = e.data as PayloadOf<'PrFixLanded'>
        nowNode = null
        w.tail = add(
          { lane: 'pr', kind: 'ticket', label: `#${d.ticket} pr-fix`, sha: d.mergeCommit, title: d.title },
          w.n,
        )
        break
      }
      case 'PrMergedBack': {
        if (w === null) break
        closeWalk(w)
        const d = e.data as PayloadOf<'PrMergedBack'>
        const node = add(
          { lane: 'personal', kind: 'done', label: `${short(d.mergeCommit)} merged back`, sha: d.mergeCommit },
          w.n,
        )
        if (w.tail !== null) edges.push({ from: w.tail.id, to: node.id, kind: 'back', state: 'done' })
        backHeads.add(d.prHead)
        nowNode = null
        mergedBackCount++
        lastMergedBack = { node, index: nodes.length - 1 }
        break
      }
      case 'PrMergeBackFailed': {
        if (w === null) break
        closeWalk(w)
        const d = e.data as PayloadOf<'PrMergeBackFailed'>
        const node = add(
          {
            lane: 'personal',
            kind: 'waiting',
            label: `merge back: ${WAIT_WORDS_BACK[d.why]}`,
            sha: d.prHead,
            tone: 'red',
            title: d.detail,
          },
          w.n,
        )
        if (w.tail !== null) edges.push({ from: w.tail.id, to: node.id, kind: 'back', state: 'red' })
        failedHeads.add(d.prHead)
        nowNode = node
        break
      }
      case 'PrCaughtUp': {
        const d = e.data as PayloadOf<'PrCaughtUp'>
        if (d.mergeCommit === null) {
          words.push('already caught up')
          break
        }
        const main = add({ lane: 'main', kind: 'main', label: short(d.mainSha), sha: d.mainSha }, w?.n ?? 0)
        const node = add(
          { lane: 'personal', kind: 'done', label: 'caught up with main', sha: d.mergeCommit },
          w?.n ?? 0,
        )
        edges.push({ from: main.id, to: node.id, kind: 'catch-up', state: 'done' })
        nowNode = null
        break
      }
      case 'PrCatchUpFailed': {
        const d = e.data as PayloadOf<'PrCatchUpFailed'>
        const main = add({ lane: 'main', kind: 'main', label: short(d.mainSha), sha: d.mainSha }, w?.n ?? 0)
        const node = add(
          {
            lane: 'personal',
            kind: 'waiting',
            label: `catch-up: ${WAIT_WORDS_BACK[d.why]}`,
            sha: null,
            tone: 'red',
            title: d.detail,
          },
          w?.n ?? 0,
        )
        edges.push({ from: main.id, to: node.id, kind: 'catch-up', state: 'red' })
        nowNode = node
        break
      }
      case 'PrBackRequested':
        backRequested = true
        break
      case 'PrMerged': {
        if (w === null) break
        closeWalk(w)
        const d = e.data as PayloadOf<'PrMerged'>
        nowNode = null
        const end = add({ lane: 'pr', kind: 'done', label: '', sha: d.headSha, hidden: true }, w.n)
        const into = add(
          {
            lane: 'main',
            kind: 'merged',
            label: d.mergeSha === null ? 'merged' : `${short(d.mergeSha)} merged`,
            sha: d.mergeSha,
          },
          w.n,
        )
        edges.push({ from: end.id, to: into.id, kind: 'merge', state: 'done' })
        break
      }
      case 'PrClosed': {
        if (w === null) break
        closeWalk(w)
        const d = e.data as PayloadOf<'PrClosed'>
        closedNode = add(
          {
            lane: 'pr',
            kind: 'todo',
            label: `× closed${backRequested ? ' by lingtai pr back' : ''}`,
            sha: d.headSha,
            tone: 'mut',
          },
          w.n,
        )
        if (mergedBackCount === 0)
          add({ lane: 'personal', kind: 'todo', label: 'the tickets are Draft again', sha: null, tone: 'mut' }, w.n)
        else if (lastMergedBack !== null) {
          const m: { node: BranchNode; index: number } = lastMergedBack
          nodes[m.index] = { ...m.node, label: `${m.node.label} — stays`, tone: 'sig' }
        }
        break
      }
      default:
        break
    }
  }

  const latest = walk as Walk | null
  if (latest !== null) closeWalk(latest)

  // What is still owed, drawn hollow: the merge into main, and a merge back that has not happened.
  const tail = latest?.tail ?? null
  if (pr.status === 'in-review' && tail !== null) {
    const owed = pr.lastPushed !== null && !backHeads.has(pr.lastPushed) && !failedHeads.has(pr.lastPushed)
    const nothing = latest?.how === 'already' && pr.lastPushed !== null && pr.lastPushed === personalFrozen
    if (owed && nothing) words.push('nothing to merge back')
    else if (owed) {
      const back = add({ lane: 'personal', kind: 'todo', label: 'merge back', sha: null }, latest!.n)
      edges.push({ from: tail.id, to: back.id, kind: 'back', state: 'todo' })
    }
    const end = add({ lane: 'pr', kind: 'done', label: '', sha: null, hidden: true }, latest!.n)
    const you = add(
      { lane: 'main', kind: 'todo', label: pr.host === null ? 'you merge' : `you merge #${pr.host.number}`, sha: null },
      latest!.n,
    )
    edges.push({ from: end.id, to: you.id, kind: 'merge', state: 'todo' })
  }

  // Only the last walks are kept: the freeze stays and the gutter says how many earlier ones there were.
  const drop = Math.max(0, walks.length - WALKS_SHOWN)
  if (drop > 0) words.push(`earlier walks: ${drop}`)
  const kept = nodes.filter((n) => n.walk === 0 || n.walk > drop)
  const ids = new Set(kept.map((n) => n.id))
  const keptEdges = edges.filter((x) => ids.has(x.from) && ids.has(x.to))

  const tickets = pr.tickets
  const shownT = Math.min(tickets.length, TICKET_DOTS)
  const dots = kept.filter((n) => n.lane === 'personal' && n.kind === 'ticket' && n.walk === 0)
  const brace =
    shownT === 0 || dots.length === 0
      ? null
      : {
          text: `${pr.status === 'merged' ? 'closed' : 'in this PR'}: ${tickets
            .slice(0, shownT)
            .map((t) => `#${t.ticket}`)
            .join(' ')}${tickets.length > shownT ? ` +${tickets.length - shownT}` : ''}`,
          from: dots[0]!.id,
          to: dots[dots.length - 1]!.id,
        }
  const fallback = [...kept].reverse().find((n) => !n.hidden && n.kind !== 'todo') ?? null
  const nowId =
    nowNode !== null && ids.has((nowNode as BranchNode).id) ? (nowNode as BranchNode).id : (fallback?.id ?? null)
  return {
    lanes: { ...lanes, gone: closedNode !== null },
    nodes: kept,
    edges: keptEdges,
    brace,
    now: nowId,
    words,
  }
}

const WAIT_WORDS_BACK: Record<'conflict' | 'red' | 'unknown' | 'lost-push' | 'locked', string> = {
  conflict: 'conflicts',
  red: 'build red',
  unknown: 'could not tell',
  'lost-push': 'push lost',
  locked: 'agent locked out',
}

// ── Where it goes ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface LaidNode extends BranchNode {
  readonly x: number
  readonly y: number
  /** Whether the label sits above the lane. */
  readonly above: boolean
  readonly anchor: 'start' | 'end'
}

export interface LaidEdge extends BranchEdge {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export interface Drawing extends Omit<BranchModel, 'nodes' | 'edges' | 'brace' | 'now'> {
  readonly width: number
  readonly height: number
  readonly laneY: Record<BranchLane, number>
  /** Where the lane names end and time begins. */
  readonly gutter: number
  readonly nodes: readonly LaidNode[]
  readonly edges: readonly LaidEdge[]
  readonly prSpan: readonly [number, number] | null
  readonly brace: { readonly text: string; readonly x1: number; readonly x2: number } | null
  readonly nowX: number | null
}

/** What the drawing writes beside a node: its label, and the commit it carries where the label does not already say so. */
export const shownLabel = (n: BranchNode): string =>
  n.label === '' || n.hidden
    ? ''
    : n.sha === null || n.label.includes(short(n.sha)) || (n.kind === 'ticket' && n.lane === 'personal')
      ? n.label
      : `${n.label} · ${short(n.sha)}`

const CHAR = 6.2
const LABEL_GAP = 10

export const LANE_Y: Record<BranchLane, number> = { main: 56, pr: 156, personal: 256 }
const GUTTER = 190
const GAP = 34

/**
 * Each node's x. Every connector runs rightward at 45° (`dx = |dy|`), so a node a connector reaches is placed from the
 * one it leaves, and the order along a lane is the order they were drawn in. The result is a fixed point of lower bounds,
 * which only ever move right; the spacing shrinks until everything fits `width`.
 */
export function layoutBranches(model: BranchModel, width: number): Drawing {
  const ns = model.nodes
  const index = new Map(ns.map((n, i) => [n.id, i]))
  const dyOf = (a: number, b: number) => Math.abs(LANE_Y[ns[a]!.lane] - LANE_Y[ns[b]!.lane])
  // A label is written to the right of its node; two on one side of one lane must not overwrite each other.
  const prOrder = ns.filter((n) => n.lane === 'pr' && !n.hidden && n.label !== '').map((n) => n.id)
  const aboveOf = (n: BranchNode): boolean =>
    n.lane === 'pr' ? prOrder.indexOf(n.id) % 2 === 0 : n.lane === 'main' || n.kind === 'ticket'
  const reach = ns.map((n) => shownLabel(n).length * CHAR)
  const sides = new Map<string, number[]>()
  ns.forEach((n, i) => {
    if (reach[i] === 0) return
    const key = `${n.lane}/${aboveOf(n)}`
    sides.set(key, [...(sides.get(key) ?? []), i])
  })
  const solve = (step: number): { xs: number[]; ok: boolean } => {
    const xs = ns.map((_, i) => GUTTER + 24 + i * step)
    const lanes: BranchLane[] = ['main', 'pr', 'personal']
    const chains = lanes.map((l) => ns.map((n, i) => (n.lane === l ? i : -1)).filter((i) => i >= 0))
    const links = model.edges.map((e) => [index.get(e.from)!, index.get(e.to)!] as const)
    for (let pass = 0; pass < 400; pass++) {
      let moved = false
      const raise = (i: number, to: number) => {
        if (xs[i]! < to - 1e-9) {
          xs[i] = to
          moved = true
        }
      }
      for (const chain of chains)
        for (let k = 1; k < chain.length; k++) raise(chain[k]!, xs[chain[k - 1]!]! + Math.min(GAP, step))
      for (const side of sides.values())
        for (let k = 1; k < side.length; k++) raise(side[k]!, xs[side[k - 1]!]! + reach[side[k - 1]!]! + LABEL_GAP)
      for (const [a, b] of links) {
        const dy = dyOf(a, b)
        raise(b, xs[a]! + dy)
        raise(a, xs[b]! - dy)
      }
      if (!moved) break
    }
    return { xs, ok: Math.max(0, ...xs.map((x, i) => x + reach[i]!)) <= width - 8 }
  }
  let step = 60
  let solved = solve(step)
  while (!solved.ok && step > 10) {
    step *= 0.85
    solved = solve(step)
  }
  const xs = solved.xs
  const w = Math.max(width, Math.max(0, ...xs.map((x, i) => x + reach[i]!)) + 8)

  const laid: LaidNode[] = ns.map((n, i) => ({
    ...n,
    x: xs[i]!,
    y: LANE_Y[n.lane],
    above: aboveOf(n),
    anchor: 'start' as const,
  }))
  const at = new Map(laid.map((n) => [n.id, n]))
  const prXs = laid.filter((n) => n.lane === 'pr').map((n) => n.x)
  const brace =
    model.brace === null
      ? null
      : { text: model.brace.text, x1: at.get(model.brace.from)!.x - 8, x2: at.get(model.brace.to)!.x + 8 }
  return {
    lanes: model.lanes,
    words: model.words,
    width: w,
    height: 330,
    laneY: LANE_Y,
    gutter: GUTTER,
    nodes: laid,
    edges: model.edges.map((e) => {
      const a = at.get(e.from)!
      const b = at.get(e.to)!
      return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }),
    prSpan: prXs.length === 0 ? null : [Math.min(...prXs), Math.max(...prXs)],
    brace,
    nowX: model.now === null ? null : (at.get(model.now)?.x ?? null),
  }
}
