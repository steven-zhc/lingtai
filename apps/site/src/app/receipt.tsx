import type { ReactNode } from 'react'

/**
 * One engineering receipt, drawn from props.
 *
 * No `'use client'` and nothing server-only: the replay on the home page
 * renders it from a client component, and the books render it from server code.
 * The torn bottom edge is CSS (`.rcpt::after`).
 */

export type ReceiptStatus = 'queued' | 'running' | 'waiting' | 'landed' | 'closed'
export type ReceiptStamp = 'LANDED' | 'NOT LANDED' | 'TYPICAL'

export interface ReceiptRow {
  key: string
  /** Plain text; a `✗`, `✓` or `→` in it is coloured. */
  value: string
  href?: string
  /** The replay step this row belongs to, which `.now` and `.pending` are decided against. */
  step?: number
  /** The value is a placeholder rather than a fact (`—`, `waiting…`). */
  muted?: boolean
}

export interface ReceiptProps {
  label?: string
  issue: string
  title: string
  status: { kind: ReceiptStatus; text: string }
  rows: readonly ReceiptRow[]
  costLabel: string
  cost: string
  /** Shown or not; absent means no stamp is rendered at all. */
  stamp?: { text: ReceiptStamp; shown: boolean }
  footnote?: ReactNode
  /** The step in view, for a live receipt: its row is highlighted, rows after it are muted. */
  current?: number
  live?: boolean
  /** Makes the status and cost announce themselves as they change. */
  announce?: boolean
}

const MARKS: Record<string, string> = { '✗': 'no', '✓': 'yes', '→': 'dim' }

/** `✗ → ✓ after 1 round`, with each mark in its own span: the mock's markup without `innerHTML`. */
function Value({ text }: { text: string }) {
  const parts = text.split(/([✗✓→])/)
  return (
    <>
      {parts.map((p, i) =>
        MARKS[p] ? (
          <span key={i} className={MARKS[p]}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  )
}

export function Receipt(props: ReceiptProps) {
  const { stamp, current, live } = props
  const landed = stamp?.shown === true && stamp.text === 'LANDED'
  const announce = props.announce ? ({ 'aria-live': 'polite' } as const) : {}
  return (
    <div className={`rcpt${live ? ' live' : ''}${landed ? ' landed' : ''}`}>
      <div className="r-top">
        <span>{props.label ?? 'LINGTAI / ENGINEERING RECEIPT'}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      </div>
      <div className="r-issue">
        <div>
          <small>{props.issue}</small>
          <b>{props.title}</b>
        </div>
        <span className={`r-status ${props.status.kind}`} {...announce}>
          {props.status.text}
        </span>
      </div>
      <div className="r-rows">
        {props.rows.map((row) => {
          const cls = [
            'r-row',
            row.step !== undefined && current !== undefined && row.step === current ? 'now' : '',
            row.step !== undefined && current !== undefined && row.step > Math.min(current, 5) ? 'pending' : '',
          ]
            .filter(Boolean)
            .join(' ')
          const inner = (
            <>
              <span className="r-k">{row.key}</span>
              <span className="r-v">
                {row.muted ? <span className="dim">{row.value}</span> : <Value text={row.value} />}
              </span>
            </>
          )
          return row.href ? (
            <a key={row.key} className={cls} href={row.href}>
              {inner}
            </a>
          ) : (
            <div key={row.key} className={cls}>
              {inner}
            </div>
          )
        })}
      </div>
      <div className="r-total">
        <div>
          <small>{props.costLabel}</small>
          <b {...announce}>{props.cost}</b>
        </div>
        {stamp ? (
          <span
            className={`r-stamp${stamp.text === 'LANDED' ? '' : ' closed'}${stamp.shown ? ' on' : ''}`}
            aria-hidden={stamp.shown ? undefined : true}
          >
            {stamp.text}
          </span>
        ) : null}
      </div>
      {props.footnote ? <p className="r-foot">{props.footnote}</p> : null}
    </div>
  )
}
