'use client'

import { useRef, useState } from 'react'

import type { SHOTS } from './shots-list'

export type Shot = (typeof SHOTS)[number] & { src: string; full: string }

/**
 * The hero's picture: a browser-window frame holding one wide crop, four tabs
 * that switch it, and a lightbox with the full page.
 *
 * All four panels are server markup and three are `hidden`, so without script
 * the first shows, the tabs do nothing, and each picture is a link to its full
 * image. Script turns that click into a native `<dialog>` (focus trapped, Esc
 * closes); ← → move between the four and a click on the backdrop closes it.
 */
export function Shots({ shots }: { shots: readonly Shot[] }) {
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(0)
  const box = useRef<HTMLDialogElement>(null)

  const full = shots[shown]!
  const step = (by: number) => setShown((i) => (i + by + shots.length) % shots.length)

  return (
    <figure className="shots">
      <div className="shot-window">
        <div className="shot-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {shots.map((s, i) => (
          <div className="shot-panel" key={s.name} id={`shot-${s.name}`} role="tabpanel" hidden={i !== active}>
            <a
              href={s.full}
              onClick={(e) => {
                e.preventDefault()
                setShown(i)
                box.current?.showModal()
              }}
            >
              <img src={s.src} alt={s.caption} width={1440} height={600} loading={i === 0 ? undefined : 'lazy'} />
            </a>
            <p className="shot-cap">{s.caption}</p>
          </div>
        ))}
      </div>
      <div className="shot-tabs" role="tablist" aria-label="Screenshots of the board">
        {shots.map((s, i) => (
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
        <img src={full.full} alt={full.caption} width={1440} height={900} />
        <div className="shot-foot">
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
        </div>
      </dialog>
    </figure>
  )
}
