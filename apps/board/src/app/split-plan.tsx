'use client'

import { Graph, layout } from '@dagrejs/dagre'
import type { SplitProgress } from '@lingtai/domain'

import '@xyflow/react/dist/style.css'
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { useContext, useEffect, useMemo, useState } from 'react'

import { waves, type Link } from '../lib/split-waves.ts'

/** The mockup's measurements (`doc/decisions/0118/Split.dc.html`): cards left to right, one column per wave. */
const CARD_W = 236
const CARD_H = 66
const NODE_SEP = 16
const RANK_SEP = 64
/** Room above the cards for the wave headings, and at the sides for the bands' padding. */
const MARGIN_X = 20
const MARGIN_Y = 48
/** Either recorded plan: an old advice's split, or a cause's plan, which also says what each child covers. */
type SplitProposal = {
  children: readonly Child[]
  blockedBy: readonly Link[]
}

const PARENT = 'parent'
/** Child nodes are prefixed so no child key can collide with the parent or a band. */
const nodeId = (key: string) => `c:${key}`
const FAR_LANE = 20

interface CardData extends Record<string, unknown> {
  label: string
  kind: string
  title: string
  off: boolean
  faded: boolean
  selected: boolean
  /** The number GitHub gave this child once its write was read back; null while it is owed. */
  written: number | null
}

function Card({ data }: NodeProps<Node<CardData>>) {
  const state = `${data.off ? ' split-card--off' : ''}${data.faded ? ' split-card--faded' : ''}${data.selected ? ' split-card--selected' : ''}${data.written !== null ? ' split-card--written' : ''}`
  return (
    <div className={`split-card${state}`}>
      <Handle type="target" position={Position.Left} className="split-handle" />
      <Handle type="source" position={Position.Right} className="split-handle" />
      <div className="split-card-head">
        <span className="split-card-name">{data.label}</span>
        <span className="split-card-kind">{data.written === null ? data.kind : `#${data.written} · ${data.kind}`}</span>
      </div>
      <div className="split-card-title">{data.title}</div>
    </div>
  )
}

function ParentNode({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className="split-card split-card--parent">
      <Handle type="source" position={Position.Right} className="split-handle" />
      <span className="split-card-name">{data.label}</span>
    </div>
  )
}

function Band({ data }: NodeProps<Node<{ label: string }>>) {
  return <div className="split-band">{data.label}</div>
}

const NODE_TYPES = { card: Card, parent: ParentNode, band: Band }

interface Child {
  key: string
  title: string
  body: string
  kind: string
}

const firstLine = (text: string) => text.split('\n')[0]?.trim() ?? ''

/** What the page shows of a split the system is writing, or declined to: the log's progress, and where the tickets live. */
export interface SplitControls {
  progress: SplitProgress
  tickets: 'github' | 'db'
  /** The server's epoch ms at which a *writing* reading lapses; only ever compared with itself, as the timer's key. */
  activeUntil?: number
  /** Ms the server saw remaining at render: a duration, so the browser's clock never enters into it. */
  quietIn?: number
}

/**
 * Triage's split plan, drawn as waves of cards — **to read, never to edit** (0118 §12, #1262). The daemon writes
 * the plan as triage gave it; once `SplitStarted` is on the log the cards draw that frozen plan, with the number
 * GitHub gave each child as it is written. A plan that was not started (a spent split, a project whose tickets are in
 * the database) is shown as advice to the person who reads it.
 */
export function SplitPlan({ plan, controls }: { plan: SplitProposal; controls?: SplitControls }) {
  const progress: SplitProgress = controls?.progress ?? { state: 'idle' }
  const frozen = progress.state === 'idle' ? null : progress.plan
  const children: Child[] = (frozen === null ? plan.children : frozen.children).map(({ key, title, body, kind }) => ({
    key,
    title,
    body,
    kind,
  }))
  const links: Link[] = (frozen === null ? plan.blockedBy : frozen.blockedBy).map((link) => ({ ...link }))
  const written = new Map(progress.state === 'idle' ? [] : progress.children.map((c) => [c.key, c.number] as const))
  const [selected, setSelected] = useState<string | null>(null)
  // *Writing* is read off recent activity and expires with no append to say so: look again once it has.
  const router = useContext(AppRouterContext)
  const writing = progress.state === 'writing'
  const activeUntil = controls?.activeUntil
  const quietIn = controls?.quietIn
  useEffect(() => {
    if (!writing) return
    // Rearmed whenever the server's expiry moves (new activity), so a late append never leaves the old timer standing.
    const wait = quietIn === undefined ? 5 * 60_000 : Math.max(0, quietIn)
    const timer = setTimeout(() => router?.refresh(), wait + 1_000)
    return () => clearTimeout(timer)
  }, [writing, activeUntil, quietIn, router])

  const keys = children.map((child) => child.key)
  const wave = useMemo(() => waves(keys.slice(), links), [keys.join('\u0000'), links])

  const { nodes, edges, width, height } = useMemo(() => {
    const g = new Graph()
    g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN_X, marginy: MARGIN_Y })
    g.setDefaultEdgeLabel(() => ({}))
    g.setNode(PARENT, { width: CARD_W, height: CARD_H })
    for (const child of children) g.setNode(nodeId(child.key), { width: CARD_W, height: CARD_H })
    const real = links.filter((link) => wave.has(link.ticket) && wave.has(link.blockedBy))
    for (const link of real) g.setEdge(nodeId(link.blockedBy), nodeId(link.ticket), { minlen: 1, weight: 1 })
    // Pin every child to its wave with a heavy, invisible tie from the parent as long as the wave, so an arrow that skips a wave gets a lane of its own.
    for (const child of children)
      g.setEdge(PARENT, nodeId(child.key), { minlen: wave.get(child.key) ?? 1, weight: FAR_LANE })
    layout(g)

    const near = new Set<string>(selected === null ? [] : [selected])
    for (const link of real) {
      if (link.ticket === selected) near.add(link.blockedBy)
      if (link.blockedBy === selected) near.add(link.ticket)
    }
    const faded = (key: string) => selected !== null && !near.has(key)

    const place = (key: string) => {
      const at = g.node(key === PARENT ? key : nodeId(key))
      return { x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }
    }
    const cards: Node[] = [
      {
        id: PARENT,
        type: 'parent',
        position: place(PARENT),
        width: CARD_W,
        height: CARD_H,
        data: { label: 'This ticket' },
        draggable: false,
        selectable: false,
      },
      ...children.map((child, index): Node => ({
        id: nodeId(child.key),
        type: 'card',
        position: place(child.key),
        width: CARD_W,
        height: CARD_H,
        data: {
          label: `Child ${index + 1}`,
          kind: child.kind,
          title: firstLine(child.title),
          off: false,
          faded: faded(child.key),
          selected: selected === child.key,
          written: written.get(child.key) ?? null,
        } satisfies CardData,
        draggable: false,
        selectable: false,
        zIndex: 2,
      })),
    ]

    // One band per wave, behind the cards of that wave.
    const top = Math.min(...children.map((child) => place(child.key).y))
    const bottom = Math.max(...children.map((child) => place(child.key).y + CARD_H))
    const lastWave = Math.max(1, ...wave.values())
    const bands: Node[] = Array.from({ length: lastWave }, (_, index): Node => {
      const members = children.filter((child) => wave.get(child.key) === index + 1)
      const x = members.length > 0 ? place(members[0]!.key).x : 0
      return {
        id: `band-${index + 1}`,
        type: 'band',
        position: { x: x - 12, y: top - 34 },
        width: CARD_W + 24,
        height: bottom - top + 48,
        data: { label: index === 0 ? 'wave 1 · starts first' : `wave ${index + 1}` },
        draggable: false,
        selectable: false,
        zIndex: 0,
      }
    })

    const blocked = new Set(real.map((link) => link.ticket))
    const lit = (link: Link) => link.ticket === selected || link.blockedBy === selected
    const arrows: Edge[] = real.map((link) => {
      const color = selected === null || lit(link) ? '#0b6a70' : '#c3cfd1'
      return {
        id: `${nodeId(link.blockedBy)}>${nodeId(link.ticket)}`,
        source: nodeId(link.blockedBy),
        target: nodeId(link.ticket),
        type: 'smoothstep',
        zIndex: 1,
        style: { stroke: color, strokeWidth: lit(link) ? 2.2 : 1.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      }
    })
    // A child nothing blocks starts from the parent: a faint dashed line, so the first wave is not left floating.
    const starts: Edge[] = children
      .filter((child) => !blocked.has(child.key))
      .map((child) => ({
        id: `${PARENT}>${nodeId(child.key)}`,
        source: PARENT,
        target: nodeId(child.key),
        type: 'smoothstep',
        zIndex: 1,
        style: { stroke: '#b9d9da', strokeWidth: 1.5, strokeDasharray: '3 5' },
      }))

    const size = g.graph()
    return {
      nodes: [...bands, ...cards],
      edges: [...starts, ...arrows],
      width: Math.ceil(size.width ?? 0),
      height: Math.ceil(size.height ?? 0),
    }
  }, [children, links, wave, selected, progress])

  const current = children.find((child) => child.key === selected)
  const already = progress.state === 'idle' ? [] : progress.children

  return (
    <div className="split-plan" data-split-state={progress.state}>
      <div className="split-canvas">
        {/* React Flow sizes its own wrapper to 100% of this box, so the box carries the graph's size and the canvas scrolls inside its parent. */}
        <div style={{ width, height }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            width={width}
            height={height}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            onNodeClick={(_, node) => {
              if (node.type === 'band') setSelected(null)
              if (node.type !== 'card') return
              const key = node.id.slice('c:'.length)
              setSelected((now) => (now === key ? null : key))
            }}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={18} size={1} color="#d8e0e1" />
          </ReactFlow>
        </div>
      </div>
      {current === undefined ? null : (
        <div className="split-panel" role="group" aria-label={`Read ${current.key}`}>
          <div className="split-field">
            <span>Title</span>
            <p>{current.title}</p>
          </div>
          <div className="split-field">
            <span>Body</span>
            <pre>{current.body}</pre>
          </div>
          <div className="split-blockers">
            <span>Blocked by</span>
            {links
              .filter((link) => link.ticket === current.key)
              .map((link) => (
                <p key={link.blockedBy}>
                  Child {children.findIndex((c) => c.key === link.blockedBy) + 1} ·{' '}
                  {firstLine(children.find((c) => c.key === link.blockedBy)?.title ?? link.blockedBy)}
                </p>
              ))}
          </div>
        </div>
      )}
      <div className="split-actions">
        {controls?.tickets === 'db' && progress.state === 'idle' ? (
          <p className="split-note">
            Splitting is not available for this project yet — its tickets are in the database. This plan is only for
            reading.
          </p>
        ) : null}
        {progress.state === 'writing' ? (
          <p className="split-note" role="status">
            Writing the split…
          </p>
        ) : null}
        {progress.state === 'failed' || progress.state === 'interrupted' ? (
          <p className="split-note split-note--failed" role="alert">
            {progress.state === 'failed' && progress.failed !== undefined
              ? `Stopped at ${progress.failed.step}: ${progress.failed.detail}`
              : 'The write was interrupted before it finished.'}{' '}
            The daemon writes what is missing again on its next look.
          </p>
        ) : null}
        {already.length > 0 && progress.state !== 'writing' ? (
          <p className="split-note">
            Created so far: {already.map((child) => `#${child.number} (${child.key})`).join(', ')}.
          </p>
        ) : null}
        {controls === undefined ? (
          <p className="split-note">Split is not offered for this decision, so this plan is only for reading.</p>
        ) : null}
      </div>
    </div>
  )
}
