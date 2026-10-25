'use client'

import { Graph, layout } from '@dagrejs/dagre'
import type { RootCause } from '@lingtai/domain/wait'

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
import { useMemo, useState } from 'react'

import { waves, wouldCycle, type Link } from '../lib/split-waves.ts'

/** The mockup's measurements (`doc/decisions/0118/Split.dc.html`): cards left to right, one column per wave. */
const CARD_W = 236
const CARD_H = 66
const NODE_SEP = 16
const RANK_SEP = 64
const MARGIN = 8
type SplitProposal = NonNullable<Extract<RootCause, { _tag: 'TicketTooBig' }>['split']>

const PARENT = 'parent'
const FAR_LANE = 20

interface CardData extends Record<string, unknown> {
  label: string
  kind: string
  title: string
  off: boolean
  faded: boolean
  selected: boolean
}

function Card({ data }: NodeProps<Node<CardData>>) {
  const state = `${data.off ? ' split-card--off' : ''}${data.faded ? ' split-card--faded' : ''}${data.selected ? ' split-card--selected' : ''}`
  return (
    <div className={`split-card${state}`}>
      <Handle type="target" position={Position.Left} className="split-handle" />
      <Handle type="source" position={Position.Right} className="split-handle" />
      <div className="split-card-head">
        <span className="split-card-name">{data.label}</span>
        <span className="split-card-kind">{data.kind}</span>
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

/** Triage's split plan, drawn as waves of cards; every edit is local state until Create all (a separate ticket). */
export function SplitPlan({ plan }: { plan: SplitProposal }) {
  const [children, setChildren] = useState<Child[]>(() => plan.children.map((child) => ({ ...child })))
  const [links, setLinks] = useState<Link[]>(() => plan.blockedBy.map((link) => ({ ...link })))
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)

  const keys = children.map((child) => child.key)
  const wave = useMemo(() => waves(keys.slice(), links), [keys.join('\u0000'), links])

  const { nodes, edges, width, height } = useMemo(() => {
    const g = new Graph()
    g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN })
    g.setDefaultEdgeLabel(() => ({}))
    g.setNode(PARENT, { width: CARD_W, height: CARD_H })
    for (const child of children) g.setNode(child.key, { width: CARD_W, height: CARD_H })
    const real = links.filter((link) => wave.has(link.ticket) && wave.has(link.blockedBy))
    for (const link of real) g.setEdge(link.blockedBy, link.ticket, { minlen: 1, weight: 1 })
    // Pin every child to its wave with a heavy, invisible tie from the parent as long as the wave, so an arrow that skips a wave gets a lane of its own.
    for (const child of children) g.setEdge(PARENT, child.key, { minlen: wave.get(child.key) ?? 1, weight: FAR_LANE })
    layout(g)

    const near = new Set<string>(selected === null ? [] : [selected, PARENT])
    for (const link of real) {
      if (link.ticket === selected) near.add(link.blockedBy)
      if (link.blockedBy === selected) near.add(link.ticket)
    }
    const faded = (key: string) => selected !== null && !near.has(key)

    const place = (key: string) => {
      const at = g.node(key)
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
        id: child.key,
        type: 'card',
        position: place(child.key),
        width: CARD_W,
        height: CARD_H,
        data: {
          label: `Child ${index + 1}`,
          kind: child.kind,
          title: firstLine(child.title),
          off: off.has(child.key),
          faded: faded(child.key),
          selected: selected === child.key,
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
        id: `${link.blockedBy}>${link.ticket}`,
        source: link.blockedBy,
        target: link.ticket,
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
        id: `${PARENT}>${child.key}`,
        source: PARENT,
        target: child.key,
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
  }, [children, links, wave, off, selected])

  const current = children.find((child) => child.key === selected)
  const edit = (key: string, patch: Partial<Child>) =>
    setChildren((all) => all.map((child) => (child.key === key ? { ...child, ...patch } : child)))

  return (
    <div className="split-plan">
      <div className="split-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          width={width}
          height={height}
          style={{ width, height }}
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
            if (node.type !== 'card') return
            setSelected((now) => (now === node.id ? null : node.id))
          }}
          onPaneClick={() => setSelected(null)}
        >
          <Background gap={18} size={1} color="#d8e0e1" />
        </ReactFlow>
      </div>
      {current === undefined ? null : (
        <div className="split-panel" role="group" aria-label={`Edit ${current.key}`}>
          <label className="split-field">
            <span>Title</span>
            <input value={current.title} onChange={(event) => edit(current.key, { title: event.target.value })} />
          </label>
          <label className="split-field">
            <span>Body</span>
            <textarea
              rows={8}
              value={current.body}
              onChange={(event) => edit(current.key, { body: event.target.value })}
            />
          </label>
          <label className="split-check">
            <input
              type="checkbox"
              checked={!off.has(current.key)}
              onChange={(event) =>
                setOff((now) => {
                  const next = new Set(now)
                  if (event.target.checked) next.delete(current.key)
                  else next.add(current.key)
                  return next
                })
              }
            />
            <span>Include this ticket</span>
          </label>
          <fieldset className="split-blockers">
            <legend>Blocked by</legend>
            {children
              .filter((other) => other.key !== current.key)
              .map((other) => {
                const has = links.some((link) => link.ticket === current.key && link.blockedBy === other.key)
                const closes = !has && wouldCycle(links, current.key, other.key)
                return (
                  <label key={other.key} className="split-check">
                    <input
                      type="checkbox"
                      checked={has}
                      disabled={closes}
                      onChange={(event) =>
                        setLinks((now) =>
                          event.target.checked
                            ? [...now, { ticket: current.key, blockedBy: other.key }]
                            : now.filter((link) => !(link.ticket === current.key && link.blockedBy === other.key)),
                        )
                      }
                    />
                    <span>
                      Child {children.indexOf(other) + 1} · {firstLine(other.title)}
                    </span>
                  </label>
                )
              })}
          </fieldset>
        </div>
      )}
    </div>
  )
}
