'use client'

import { useRef, useState } from 'react'

/** The four pictures of the board; the caption is also each picture's `alt`. */
export const SHOTS = [
  { name: 'board', tab: 'Board', caption: 'The board — queued, running, waiting on you, landed' },
  { name: 'task', tab: 'Task', caption: 'One ticket — every step, the review, what it cost' },
  { name: 'landed', tab: 'Landed', caption: "Landed — what changed, with the reviewer's summary" },
  { name: 'report', tab: 'Report', caption: 'Report — how the work converges and what it cost' },
] as const

const src = (name: string, full: boolean) => `/img/docs/shot-${name}${full ? '-full' : ''}.png`

/**
 * The hero's picture: a browser-window frame holding one wide crop, four tabs
 * that switch it, and a lightbox with the full page.
 *
 * All four panels are server markup and three are `hidden`, so without script
 * the first shows, the tabs do nothing, and each picture is a link to its full
 * image. Script turns that click into a native `<dialog>` (focus trapped, Esc
 * closes); ← → move between the four and a click on the backdrop closes it.
 */
export function Shots() {
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(0)
  const box = useRef<HTMLDialogElement>(null)

  const full = SHOTS[shown]!
  const step = (by: number) => setShown((i) => (i + by + SHOTS.length) % SHOTS.length)

  return (
    <figure className="shots">
      <div className="shot-window">
        <div className="shot-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {SHOTS.map((s, i) => (
          <div className="shot-panel" key={s.name} id={`shot-${s.name}`} role="tabpanel" hidden={i !== active}>
            <a
              href={src(s.name, true)}
              onClick={(e) => {
                e.preventDefault()
                setShown(i)
                box.current?.showModal()
              }}
            >
              <img
                src={src(s.name, false)}
                alt={s.caption}
                width={1440}
                height={600}
                loading={i === 0 ? undefined : 'lazy'}
              />
            </a>
            <p className="shot-cap">{s.caption}</p>
          </div>
        ))}
      </div>
      <div className="shot-tabs" role="tablist" aria-label="Screenshots of the board">
        {SHOTS.map((s, i) => (
          <button
            type="button"
            className="shot-tab"
            role="tab"
            key={s.name}
            aria-selected={i === active}
            aria-controls={`shot-${s.name}`}
            onClick={() => setActive(i)}
          >
            {s.tab}
          </button>
        ))}
      </div>
      <dialog
        className="shot-box"
        ref={box}
        aria-label="Full page screenshot"
        onClick={(e) => {
          if (e.target === box.current) box.current?.close()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') step(1)
          else if (e.key === 'ArrowLeft') step(-1)
          else return
          e.preventDefault()
        }}
      >
        <img src={src(full.name, true)} alt={full.caption} width={1440} height={900} />
        <p>{full.caption}</p>
        <div className="shot-nav">
          <button type="button" className="shot-step" aria-label="Previous screenshot" onClick={() => step(-1)}>
            ←
          </button>
          <button type="button" className="shot-step" aria-label="Next screenshot" onClick={() => step(1)}>
            →
          </button>
          <button type="button" className="shot-step" aria-label="Close" onClick={() => box.current?.close()}>
            ✕
          </button>
        </div>
      </dialog>
    </figure>
  )
}
