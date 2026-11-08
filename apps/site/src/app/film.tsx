'use client'

import { useEffect, useRef, useState } from 'react'

const VIDEO_ID = 's27esf-NQlc'
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`
const EMBED_URL = `https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&mute=1&cc_load_policy=1&rel=0`

/**
 * The film's frame: a local poster that, on a click, becomes the player.
 *
 * Nothing contacts YouTube before that click. Without script the poster is a
 * plain link to the watch page; script turns the click into the in-place swap.
 *
 * **It starts muted, with subtitles on.** A browser refuses sound to a
 * cross-origin iframe created after the click — the click was ours, not the
 * player's — so unmuted it would show YouTube's own Play button and ask for a
 * second click. Muted autoplay is allowed everywhere; the subtitles carry the
 * narration until the visitor unmutes.
 */
export function Film() {
  const [playing, setPlaying] = useState(false)
  const player = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (playing) player.current?.focus()
  }, [playing])

  return (
    <div className="film-frame">
      {playing ? (
        <iframe
          ref={player}
          src={EMBED_URL}
          title="Lingtai — the film"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <a
          href={WATCH_URL}
          aria-label="Play the film (2:11, starts muted with subtitles)"
          onClick={(e) => {
            e.preventDefault()
            setPlaying(true)
          }}
        >
          <img src="/img/film-poster.jpg" alt="" width={1920} height={1080} loading="lazy" />
          <span className="film-play" aria-hidden="true">
            Play <span>2:11</span>
          </span>
        </a>
      )}
    </div>
  )
}
