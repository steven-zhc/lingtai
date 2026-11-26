/**
 * A PR's three branches, drawn from its events (#1373): the agreed mock is `doc/milestone/0.16.0/team-mode/pr-branches.html`.
 *
 * Two pure functions. `prBranches` decides **what is drawn**, in log order: lanes, nodes, edges, the brace of tickets and
 * where *now* is. `layoutBranches` decides **where**, by the mock's rule: lanes at fixed heights, event order left to right, every
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
import type { PreviousPr } from './pr-page.ts'

export type BranchLane = 'main' | 'pr' | 'personal'

/** One event's words on a dot: a dot is one commit, and the events that happened at it are its lines, in log order. */
export interface BranchLine {
  readonly text: string
  readonly tone?: 'mut' | 'red' | 'sig'
  /** Every walk that said this: a repeated line keeps them all, so the cap keeps it while any of them is kept. */
  readonly walks: readonly number[]
}

export interface BranchNode {
  readonly id: string
  /** What the dot says, one line per event; an unfolded node has one, a hidden one none. */
  readonly lines: readonly BranchLine[]
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

/** A node as the event loop adds it, one per event; `foldCommits` turns these into dots with their lines. */
type RawNode = Omit<BranchNode, 'lines'>
const lineOf = (n: RawNode): BranchLine[] =>
  n.label === '' || n.hidden
    ? []
    : [{ text: n.label, ...(n.tone === undefined ? {} : { tone: n.tone }), walks: [n.walk] }]
const oneLine = (n: RawNode): BranchNode => ({ ...n, lines: lineOf(n) })

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
  /** False on an empty Next PR: two lanes, the PR lane's label and line are not drawn. */
  readonly prLane: boolean
  /** A dashed line from a node to a PR the drawing has no node for, named by its text. */
  readonly pointer: { readonly from: string; readonly text: string } | null
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
  sync: { node: RawNode; main: RawNode; edge: BranchEdge; done: boolean } | null
  how: PayloadOf<'BranchSynced'>['how'] | null
  ready: boolean
  tail: RawNode | null
  closed: boolean
}

/**
 * An empty Next PR: main and the personal branch, one dot on the personal branch for where the tickets went — the newest
 * caught-up point, else the freeze commit of the PR they went into — and a dashed pointer from it to that PR. A closed or
 * refused newest PR gets no pointer: its tickets are not in it.
 */
function emptyDraft(lanes: BranchModel['lanes'], previous?: PreviousPr): BranchModel {
  const pr = previous?.pr
  const named = pr !== undefined && pr.status !== 'closed' && pr.status !== 'refused' ? pr : undefined
  const k = named === undefined ? null : named.n === null ? '?' : String(named.n)
  let node: RawNode
  if (previous?.caughtUp != null) {
    node = {
      id: 'mark',
      lane: 'personal',
      kind: 'done',
      label: `${short(previous.caughtUp.sha)} caught up with main`,
      sha: previous.caughtUp.sha,
      walk: 0,
    }
  } else if (named !== undefined && previous?.frozenSha != null) {
    node = {
      id: 'mark',
      lane: 'personal',
      kind: 'done',
      label: `${short(previous.frozenSha)} frozen for PR ${k}`,
      sha: previous.frozenSha,
      walk: 0,
    }
  } else {
    node = { id: 'mark', lane: 'personal', kind: 'done', label: '', sha: null, hidden: true, walk: 0 }
  }
  const pointer = named === undefined || node.hidden ? null : { from: node.id, text: `PR ${k}` }
  return {
    lanes,
    nodes: [oneLine(node)],
    edges: [],
    brace: null,
    now: node.id,
    words: [],
    prLane: false,
    pointer,
  }
}

/** What is drawn for one PR, or for the draft when `pr` is null. `null` when the draft's tickets could not be read. */
export function prBranches(
  pr: PrState | null,
  events: readonly Envelope[],
  draft: readonly DraftTicket[] | { readonly error: string },
  opts: BranchOptions,
  previous?: PreviousPr,
): BranchModel | null {
  const lanes = {
    main: pr?.main ?? opts.main,
    personal: pr?.branch ?? opts.personal,
    pr: pr?.prBranch ?? null,
    gone: false,
  }
  if (pr === null) {
    if ('error' in draft) return null
    if (draft.length === 0) return emptyDraft(lanes, previous)
    const shown = draft.slice(0, TICKET_DOTS)
    const nodes: RawNode[] = shown.map((t, i) => ({
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
      nodes: nodes.map(oneLine),
      edges: [],
      brace: shown.length === 0 ? null : { text, from: 't0', to: `t${shown.length - 1}` },
      now: 'submit',
      words: ['no PR yet'],
      prLane: true,
      pointer: null,
    }
  }

  const nodes: RawNode[] = []
  const edges: BranchEdge[] = []
  const words: string[] = []
  let counter = 0
  const add = (n: Omit<RawNode, 'id' | 'walk'>, walk: number): RawNode => {
    const node: RawNode = { ...n, id: `n${counter++}`, walk }
    nodes.push(node)
    return node
  }
  const total = events.filter((e) => e.type === 'PrInProgress').length
  if (total === 0)
    return { lanes, nodes: [], edges, brace: null, now: null, words: ['not started'], prLane: true, pointer: null }

  const walks: Walk[] = []
  let walk: Walk | null = null
  let frozen: RawNode | null = null
  // The commit the personal branch was frozen at: only the first `PrInProgress`'s. A later walk's `frozenSha` is the PR
  // branch's own head (a pr-fix lands there), which the personal branch does not hold until it is merged back.
  let personalFrozen: string | null = null
  let backRequested = false
  let closedNode: RawNode | null = null
  let lastMergedBack: { node: RawNode; index: number } | null = null
  let mergedBackCount = 0
  const backHeads = new Set<string>()
  const failedHeads = new Set<string>()
  let nowNode: RawNode | null = null

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

  const syncNode = (w: Walk, kind: RawNode['kind'], label: string, sha: string | null, state: BranchEdge['state']) => {
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
    let last: RawNode | null = w.sync?.node ?? w.tail
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

  /**
   * The main commit a catch-up merged from. When the last thing on main is the merge into it, and either git found that
   * merge (`sha` null) or it names this very commit, the catch-up is the same merge seen from the personal branch: the
   * green dot is the dot, and `mainSha` is never written on it (main may have moved in between).
   */
  const mainOfCatchUp = (mainSha: string, walkN: number): RawNode => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!
      if (n.lane !== 'main') continue
      // One connector per dot: a second catch-up (a retry after a failure) cannot leave the same dot at 45° beside the first.
      if (
        n.kind === 'merged' &&
        (n.sha === null || n.sha === mainSha) &&
        !edges.some((e) => e.from === n.id && e.kind === 'catch-up')
      )
        return n
      break
    }
    return add({ lane: 'main', kind: 'main', label: short(mainSha), sha: mainSha }, walkN)
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
        nowNode = null
        if (d.mergeCommit === null) {
          words.push('already caught up')
          break
        }
        const main = mainOfCatchUp(d.mainSha, w?.n ?? 0)
        const node = add(
          { lane: 'personal', kind: 'done', label: 'caught up with main', sha: d.mergeCommit },
          w?.n ?? 0,
        )
        edges.push({ from: main.id, to: node.id, kind: 'catch-up', state: 'done' })
        break
      }
      case 'PrCatchUpFailed': {
        const d = e.data as PayloadOf<'PrCatchUpFailed'>
        const main = mainOfCatchUp(d.mainSha, w?.n ?? 0)
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
          const m: { node: RawNode; index: number } = lastMergedBack
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

  // One dot per commit: the events that happened at it become its lines. Before the cap, so a dropped walk takes its lines.
  const folded = foldCommits(nodes, edges)

  // Only the last walks are kept: the freeze stays and the gutter says how many earlier ones there were.
  const drop = Math.max(0, walks.length - WALKS_SHOWN)
  if (drop > 0) words.push(`earlier walks: ${drop}`)
  const walkKept = (n: number) => n === 0 || n > drop
  const kept: BranchNode[] = []
  for (const n of folded.nodes) {
    const lines = n.lines.filter((l) => l.walks.some(walkKept))
    if (n.lines.length === 0 ? walkKept(n.walk) : lines.length > 0) kept.push({ ...n, lines })
  }
  const ids = new Set(kept.map((n) => n.id))
  const keptEdges = folded.edges.filter((x) => ids.has(x.from) && ids.has(x.to))

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
  const fallback = [...kept].reverse().find((n) => !n.hidden && n.kind !== 'todo' && n.kind !== 'waiting') ?? null
  const nowId =
    nowNode !== null && ids.has(folded.into(nowNode as RawNode))
      ? folded.into(nowNode as RawNode)
      : (fallback?.id ?? null)
  return {
    lanes: { ...lanes, gone: closedNode !== null },
    nodes: kept,
    edges: keptEdges,
    brace,
    now: nowId,
    words,
    prLane: true,
    pointer: null,
  }
}

/** The kind of a dot two events share: the later one's, but a merge into main stays green and a commit that happened is never hollow. */
const foldedKind = (a: BranchNode['kind'], b: BranchNode['kind']): BranchNode['kind'] =>
  a === 'merged' || b === 'merged' ? 'merged' : b === 'todo' ? a : b

/**
 * A dot is one commit on one lane: nodes with the same lane and sha become the first of them, which keeps its id and its
 * place, and its lines are the members' in log order. It takes the kind, tone and title of the latest — a commit that was
 * built and then waits red at CI is one red dot — except that a merge into main stays green. Anchors (hidden), tickets and
 * nodes no event gave a sha are never folded. An edge that named an absorbed node names the survivor, and one that would
 * join a dot to itself, or repeat another, goes.
 */
export function foldCommits(
  nodes: readonly RawNode[],
  edges: readonly BranchEdge[],
): { nodes: BranchNode[]; edges: BranchEdge[]; into: (n: { id: string }) => string } {
  // Two connectors at 45° that leave one dot for two dots on one lane (or reach one dot from two on one lane) cannot both
  // hold, since the layout keeps a lane's dots apart. Where folding would make that, the members stay separate dots.
  const blocked = new Set<string>()
  for (;;) {
    const r = foldWith(nodes, edges, blocked)
    const lane = new Map(r.nodes.map((n) => [n.id, n.lane]))
    const ends = new Map<string, string>()
    const bad = new Set<string>()
    for (const e of r.edges)
      for (const [dot, other, side] of [
        [e.from, e.to, 'from'],
        [e.to, e.from, 'to'],
      ] as const) {
        const key = `${side}/${dot}/${lane.get(other)}`
        const seen = ends.get(key)
        if (seen === undefined) ends.set(key, other)
        else if (seen !== other) bad.add(dot)
      }
    let grew = false
    for (const n of nodes) {
      const dot = r.into(n)
      if (bad.has(dot) && n.id !== dot && !blocked.has(n.id)) {
        blocked.add(n.id)
        grew = true
      }
    }
    if (!grew) return r
  }
}

function foldWith(
  nodes: readonly RawNode[],
  edges: readonly BranchEdge[],
  blocked: ReadonlySet<string>,
): { nodes: BranchNode[]; edges: BranchEdge[]; into: (n: { id: string }) => string } {
  const out: BranchNode[] = []
  const at = new Map<string, number>()
  const survivor = new Map<string, string>()
  for (const n of nodes) {
    const key = n.sha === null || n.hidden || n.kind === 'ticket' || blocked.has(n.id) ? null : `${n.lane}/${n.sha}`
    const i = key === null ? undefined : at.get(key)
    if (i === undefined) {
      if (key !== null) at.set(key, out.length)
      out.push(oneLine(n))
      continue
    }
    const s = out[i]!
    survivor.set(n.id, s.id)
    const lines = [...s.lines]
    for (const l of lineOf(n)) {
      const last = lines[lines.length - 1]
      if (last?.text === l.text) lines[lines.length - 1] = { ...last, walks: [...new Set([...last.walks, ...l.walks])] }
      else lines.push(l)
    }
    const { tone: _tone, title: _title, ...rest } = s
    out[i] = {
      ...rest,
      kind: foldedKind(s.kind, n.kind),
      ...(n.tone === undefined ? {} : { tone: n.tone }),
      ...(n.title === undefined ? {} : { title: n.title }),
      walk: n.walk,
      lines,
    }
  }
  const into = (n: { id: string }): string => survivor.get(n.id) ?? n.id
  const seen = new Set<string>()
  const kept: BranchEdge[] = []
  for (const e of edges) {
    const from = survivor.get(e.from) ?? e.from
    const to = survivor.get(e.to) ?? e.to
    const key = `${from}-${to}`
    if (from === to || seen.has(key)) continue
    seen.add(key)
    kept.push({ ...e, from, to })
  }
  return { nodes: out, edges: kept, into }
}

const WAIT_WORDS_BACK: Record<'conflict' | 'red' | 'unknown' | 'lost-push' | 'locked', string> = {
  conflict: 'conflicts',
  red: 'build red',
  unknown: 'could not tell',
  'lost-push': 'push lost',
  locked: 'agent locked out',
}

// ── Where it goes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A rectangle the drawing owns: where a dot's words go, and the room they take. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LaidNode extends BranchNode {
  readonly x: number
  readonly y: number
  /** Whether the label sits above the lane. */
  readonly above: boolean
  readonly anchor: 'start' | 'end'
  /** What `lines` occupy, or null where the node says nothing. */
  readonly box: Box | null
  /** The text baseline of each of `lines`, in order. `lines` here already carry the commit where the words do not. */
  readonly baselines: readonly number[]
}

export interface LaidEdge extends BranchEdge {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export interface Drawing extends Omit<BranchModel, 'nodes' | 'edges' | 'brace' | 'now' | 'pointer'> {
  /** The dashed pointer, from a node's position to the PR it names. */
  readonly pointer: {
    readonly x1: number
    readonly y1: number
    readonly x2: number
    readonly y2: number
    readonly text: string
  } | null
  readonly width: number
  readonly height: number
  readonly laneY: Record<BranchLane, number>
  /** Where the lane names end and the events begin. */
  readonly gutter: number
  readonly nodes: readonly LaidNode[]
  readonly edges: readonly LaidEdge[]
  readonly prSpan: readonly [number, number] | null
  readonly brace: { readonly text: string; readonly x1: number; readonly x2: number } | null
  readonly nowX: number | null
}

const needsSha = (n: Pick<BranchNode, 'kind' | 'lane' | 'sha' | 'hidden'>): n is typeof n & { sha: string } =>
  n.sha !== null && !n.hidden && !(n.kind === 'ticket' && n.lane === 'personal')

/** What the drawing writes beside a node: its label, and the commit it carries where the label does not already say so. */
export const shownLabel = (n: Pick<BranchNode, 'label' | 'kind' | 'lane' | 'sha' | 'hidden'>): string =>
  n.label === '' || n.hidden
    ? ''
    : needsSha(n) && !n.label.includes(short(n.sha))
      ? `${n.label} · ${short(n.sha)}`
      : n.label

/** The lines a node writes: its events', and the short commit once, on the first, where no line already names it. */
function shownLines(n: BranchNode): readonly BranchLine[] {
  if (n.hidden || n.lines.length === 0) return []
  if (!needsSha(n) || n.lines.some((l) => l.text.includes(short(n.sha)))) return n.lines
  const [first, ...rest] = n.lines
  return [{ ...first!, text: `${first!.text} · ${short(n.sha)}` }, ...rest]
}

const CHAR = 6.2
const LABEL_GAP = 10
/** The pitch of a node's lines, for `--fs-2xs` at 10px, and how far a line's box reaches over and under its baseline. */
const LINE = 12
const ASCENT = 9
const DESCENT = 3
/** The baselines of a one-line label: above the lane, and below it. */
const ABOVE = 13
const BELOW = 21
const DOT = 7
const TICKET_DOT = 4.5

export const LANE_Y: Record<BranchLane, number> = { main: 56, pr: 156, personal: 256 }
const GUTTER = 190
/** The least between two nodes on a lane: the seed of every node's x, and the chain rule along a lane. */
const STEP = 36
const HEIGHT = 330

/**
 * Each node's x. Every connector runs rightward at 45° (`dx = |dy|`), so a node a connector reaches is placed from the
 * one it leaves, and the order along a lane is the order they were drawn in. Nodes start `STEP` apart in log order and
 * are raised until no mark — a dot, or the box of its lines — touches an earlier node's mark at the same height: a
 * fixed point of lower bounds, which only ever move right. The drawing widens to hold the result, and never shrinks it
 * to fit; `width` is only its least.
 */
export function layoutBranches(model: BranchModel, width: number): Drawing {
  const ns = model.nodes
  const index = new Map(ns.map((n, i) => [n.id, i]))
  const dyOf = (a: number, b: number) => Math.abs(LANE_Y[ns[a]!.lane] - LANE_Y[ns[b]!.lane])
  const shown = ns.map(shownLines)
  const prOrder = ns.filter((n, i) => n.lane === 'pr' && shown[i]!.length > 0).map((n) => n.id)
  const aboveOf = (n: BranchNode): boolean =>
    n.lane === 'pr' ? prOrder.indexOf(n.id) % 2 === 0 : n.lane === 'main' || n.kind === 'ticket'

  // Each node's marks, as offsets from its x and extents on y.
  interface Mark {
    readonly l: number
    readonly r: number
    readonly y0: number
    readonly y1: number
  }
  const box = ns.map((n, i): (Box & { baselines: number[] }) | null => {
    const k = shown[i]!.length
    if (k === 0) return null
    const wide = Math.max(...shown[i]!.map((l) => l.text.length)) * CHAR
    const above = aboveOf(n)
    const y = LANE_Y[n.lane]
    const baselines = shown[i]!.map((_, j) => (above ? y - ABOVE - (k - 1 - j) * LINE : y + BELOW + j * LINE))
    const top = baselines[0]! - ASCENT
    const bottom = baselines[k - 1]! + DESCENT
    return { x: -6, y: top, width: wide, height: bottom - top, baselines }
  })
  const marks = ns.map((n, i): Mark[] => {
    const out: Mark[] = []
    const y = LANE_Y[n.lane]
    if (!n.hidden) {
      const r = n.kind === 'ticket' ? TICKET_DOT : DOT
      out.push({ l: -r, r, y0: y - r, y1: y + r })
    }
    const b = box[i] ?? null
    if (b !== null) out.push({ l: b.x, r: b.x + b.width, y0: b.y, y1: b.y + b.height })
    return out
  })

  const xs = ns.map((_, i) => GUTTER + 24 + i * STEP)
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
    for (const chain of chains) for (let k = 1; k < chain.length; k++) raise(chain[k]!, xs[chain[k - 1]!]! + STEP)
    for (let j = 1; j < ns.length; j++)
      for (let i = 0; i < j; i++)
        for (const a of marks[i]!)
          for (const b of marks[j]!) if (a.y0 < b.y1 && b.y0 < a.y1) raise(j, xs[i]! + a.r + LABEL_GAP - b.l)
    for (const [a, b] of links) {
      const dy = dyOf(a, b)
      raise(b, xs[a]! + dy)
      raise(a, xs[b]! - dy)
    }
    if (!moved) break
  }

  const laid: LaidNode[] = ns.map((n, i) => {
    const b = box[i] ?? null
    return {
      ...n,
      lines: shown[i]!,
      x: xs[i]!,
      y: LANE_Y[n.lane],
      above: aboveOf(n),
      anchor: 'start' as const,
      box: b === null ? null : { x: xs[i]! + b.x, y: b.y, width: b.width, height: b.height },
      baselines: b === null ? [] : b.baselines,
    }
  })
  const at = new Map(laid.map((n) => [n.id, n]))
  const prXs = laid.filter((n) => n.lane === 'pr').map((n) => n.x)
  const brace =
    model.brace === null
      ? null
      : { text: model.brace.text, x1: at.get(model.brace.from)!.x - 8, x2: at.get(model.brace.to)!.x + 8 }
  // Now stands to the right of every dot and every box, clear of both, and the drawing is wide enough to hold its word.
  const right = Math.max(
    GUTTER + 8,
    ...laid.flatMap((n) => [
      ...(n.hidden ? [] : [n.x + (n.kind === 'ticket' ? TICKET_DOT : DOT)]),
      ...(n.box === null ? [] : [n.box.x + n.box.width]),
    ]),
  )
  const nowX = model.now === null ? null : right + 16
  const w = Math.max(width, right + 8, nowX === null ? 0 : nowX + 'now'.length * CHAR + 4 + 8)
  const bottom = Math.max(HEIGHT, ...laid.map((n) => (n.box === null ? 0 : n.box.y + n.box.height + 8)))
  return {
    lanes: model.lanes,
    words: model.words,
    prLane: model.prLane,
    pointer:
      model.pointer === null
        ? null
        : (() => {
            const from = at.get(model.pointer.from)!
            return { x1: from.x, y1: from.y, x2: from.x + 40, y2: from.y - 40, text: model.pointer.text }
          })(),
    width: w,
    height: bottom,
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
    nowX,
  }
}
