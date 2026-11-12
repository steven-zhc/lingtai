/**
 * What the bar carries, and what it stopped carrying.
 *
 * At 1440 it rendered eleven objects, nine of them boxed, and wrapped to a
 * second line. Every one of them had been argued for on its own — #81, #84,
 * #86, `0025 §2`, #64, #98 — and none of those arguments was about the row
 * ([the-bar.md](../../../doc/design/the-bar.md)).
 *
 * Two things are asserted here rather than in the page, because both are reduces
 * and neither is a matter of taste. **The health dot is one indicator over two
 * independent facts**, and the thing a later edit can silently get wrong is the
 * order they are weighed in and whether the one that loses is still reachable.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { bearing, type CodeNews } from '../src/lib/bearing.ts'
import type { Health } from '../src/lib/health.ts'
import { stoppedOnTheWire } from '../src/lib/stopped.ts'

const board = (over: Partial<Health> = {}): Health => ({
  lag: 0,
  daemon: 'up',
  sinceBeatMs: 2_000,
  inFlight: [],
  stoppedProjections: [],
  conductor: null,
  ...over,
})

/** A daemon holding code the repository has moved past — `#98`'s thirty-nine minutes. */
const behind: CodeNews = {
  wrong: 'daemon 4 commits behind',
  command: 'lingtai restart',
  said: 'running d4fbd1a — 4 commit(s) behind origin/main, which has not taken effect in this process: 0c1a2b3 fix(end)',
}

/** Level with the base: something to say only on hover. */
const level: CodeNews = {
  wrong: null,
  command: null,
  said: 'running d4fbd1a — level with origin/main',
}

/**
 * Every branch of the reducer, once — the list the two properties below are
 * quantified over.
 *
 * Written out rather than generated, so adding a branch to `bearing()` without
 * adding it here is a visible omission in a diff. The two at the top are the
 * ones a reducer loses first, because they are about the stream and the reducer is
 * about the board: nothing in them mentions the daemon, and that is exactly why
 * they stopped carrying what it is running.
 */
const EVERY_STATE: [Parameters<typeof bearing>[0], Health | null, number | null][] = [
  ['trouble', board(), null],
  ['connecting', null, null],
  ['open', null, null],
  ['open', board({ error: 'no such relation' }), null],
  ['open', board({ lag: null }), null],
  ['open', board({ lag: 3, daemon: 'never', sinceBeatMs: null }), null],
  ['open', board({ lag: 7 }), null],
  ['open', board(), null],

  ['open', board({ lag: 0, daemon: 'stale', conductor: { held: null } }), 4],
  ['open', board({ lag: 5, daemon: 'never', sinceBeatMs: null, conductor: { held: null } }), 4],
  ['open', board({ lag: 0, daemon: 'stale', conductor: { unread: 'EACCES' } }), 4],
  ['open', board({ lag: 0, daemon: 'stale', conductor: { held: null } }), 0],
  ['open', board({ lag: 0, daemon: 'stale', conductor: { held: 'lingtai run' } }), 4],
]

describe('the health dot', () => {
  /**
   * The quiet version, which is the state the bar is in nearly all the time:
   * one dot, and no sentence at all. A box that is present and quiet in the
   * ordinary case is one nobody reads when it is not.
   */
  it('is green and silent when the board is current and the daemon is level', () => {
    const said = bearing('open', board(), level, null)

    expect(said.tone).toBe('pass')
    expect(said.why).toBeNull()
  })

  /**
   * `#64` and `#98` were two chips and are one dot. Reducing them must not make
   * either unreachable, so whichever is not the headline is in the title —
   * which is the property that is easy to drop and impossible to see.
   */
  it('keeps the fact that is not the headline in the title', () => {
    expect(bearing('open', board(), level, null).title).toContain('level with origin/main')
    expect(bearing('open', board({ lag: 0 }), behind, null).title).toContain('task_view is at the head')
  })

  /**
   * Stale code is a fault: `current` and `not paused` were both true for
   * thirty-nine minutes in which the fix that had landed could not run.
   */
  it('carries the sentence and the action when the daemon holds old code', () => {
    const said = bearing('open', board(), behind, null)

    expect(said.tone).toBe('warn')
    expect(said.why).toBe('daemon 4 commits behind')
    expect(said.command).toBe('lingtai restart')
  })

  /**
   * Worst first. A projection nobody is reducing is the board lying about the
   * very thing the newer code would be doing, so it beats stale code — and it
   * still says how to fix it.
   */
  it('puts a projection nobody is advancing ahead of stale code, with both reachable', () => {
    const said = bearing('open', board({ lag: 12, daemon: 'stale', sinceBeatMs: 400_000 }), behind, null)

    expect(said.tone).toBe('warn')
    expect(said.label).toContain('no daemon')
    expect(said.command).toBe('lingtai daemon --no-conduct')
    expect(said.title).toContain('4 commit(s) behind')
  })

  /**
   * Since 0022 a `lingtai run` holds a projector of its own, so lag with a
   * beating daemon is ordinary. It says so rather than raising an alarm.
   */
  it('does not call catching up a fault', () => {
    const said = bearing('open', board({ lag: 7 }), level, null)

    expect(said.tone).toBe('idle')
    expect(said.why).toBe('catching up')
  })

  /**
   * The stream is the reason the numbers under it are stale, so it is the
   * headline when it is down — nothing below it can be trusted. This is the
   * inversion of the morning `#64` is about: socket open, chip green, board
   * frozen.
   */
  it('lets a dead stream beat everything under it', () => {
    expect(bearing('trouble', board(), level, null).tone).toBe('warn')
    expect(bearing('trouble', board(), level, null).why).toContain('live connection to the log is down')
  })

  /** Not yet an answer is not a green one. */
  it('says nothing green before the first health frame arrives', () => {
    expect(bearing('connecting', null, null, null).tone).toBe('idle')
    expect(bearing('open', null, null, null).tone).toBe('idle')
  })

  /**
   * Every state, including the two that are not about the board at all. A dead
   * stream and a board that has not answered yet are exactly when somebody
   * wants to know what the daemon is running, and they are the two the old
   * separate `Stale` chip still rendered in — a chip does not know what its
   * neighbour is doing, and a reducer does.
   *
   * This is the property the reducer can lose in silence: the title is on hover,
   * so nothing on screen changes when a branch stops carrying it.
   */
  it("keeps the daemon's code reachable in every state, not only the ones about it", () => {
    for (const [socket, health, runnable] of EVERY_STATE) {
      // Level and behind both, because `code.wrong` opens a branch of its own
      // and a branch is where the fact goes missing.
      expect(bearing(socket, health, level, runnable).title).toContain('running d4fbd1a')
      expect(bearing(socket, health, behind, runnable).title).toContain('4 commit(s) behind')
    }
  })

  /**
   * The dot has no branch that says nothing: a health indicator whose title is
   * empty is one that has quietly stopped being a health indicator.
   */
  it('always has something to say on hover', () => {
    for (const [socket, health, runnable] of EVERY_STATE) {
      expect(bearing(socket, health, level, runnable).title.length).toBeGreaterThan(0)
      expect(bearing(socket, health, null, runnable).title.length).toBeGreaterThan(0)
    }
  })
})

/**
 * Amber, and the one thing allowed to wear it.
 *
 * Asserted against the stylesheet rather than against `bearing()`, because
 * `bearing()` cannot break this and never could: its `Tone` union has three
 * members and a test that checks the returned value is one of them is a test of
 * the type checker. **What can break it is a rule** — `.chip.sig` was one, it
 * held `$81.83 repair`, and the file stated the rule 23 lines above it.
 *
 * So the question this asks is the one #134 asked: how many things on the bar
 * are amber? The answer has to be one, and it has to be the headline.
 */
describe("the bar's amber", () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
    // Comments first: this file argues in prose, and `var(--signal)` inside a
    // comment is a sentence about the rule and not a second wearer of it.
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /**
   * Every selector that paints with `--signal`, paired with the block that
   * does. `@media` nests, so the selector is the text between the last two
   * braces rather than the first thing in the piece.
   */
  const wearers = css
    .split('}')
    .map((piece) => piece.split('{'))
    .filter((parts) => parts.length > 1 && parts[parts.length - 1]!.includes('var(--signal'))
    .map((parts) => parts[parts.length - 2]!.trim().replace(/\s+/g, ' '))

  /**
   * Every class that can render inside `.bar`: the bar's own markup in
   * `page.tsx`, and the components it mounts there. Read from the source rather
   * than listed by hand, because the way this went wrong last time was a class
   * nobody thought of as the bar's — `.btn.pri`, a solid amber, on the Resume
   * confirmation `paused.tsx` opens inside the row.
   */
  const barClasses = (() => {
    const read = (f: string) => readFileSync(new URL(`../src/app/${f}`, import.meta.url), 'utf8')
    const page = read('page.tsx')
    const bar = page.slice(page.search(/<Bar\s/), page.indexOf('<div className="cols">'))
    expect(bar.length).toBeGreaterThan(0)
    // The rail's late parts (the paused chip, the drain, the headline) stream in
    // `RailTail`, and the filter's and the actions' slots are parts of their own.
    const late = page.slice(page.indexOf('async function MenuRows'), page.indexOf('async function BannerPart'))
    expect(late.length).toBeGreaterThan(0)
    const sources = [
      bar,
      late,
      read('bar.tsx'),
      read('paused.tsx'),
      read('draining.tsx'),
      read('live.tsx'),
      // The filter and its `+` (#216). It left `page.tsx` for a file of its
      // own, and a component the bar mounts is the bar's whether or not its
      // markup is still in this slice — which is the `.btn.pri` lesson again.
      read('projects.tsx'),
      // The banner's rows and the Pause button (#994): held, never `--signal`.
      read('lock-banner.tsx'),
      read('pause-button.tsx'),
      read('continue-today.tsx'),
      read('recipe/[project]/recipe-bar.tsx'),
    ]
    const names = new Set<string>()
    for (const src of sources) {
      // `className="a b"` and ``className={`a ${x ? " b" : ""}`}`` alike: every
      // bare word inside the attribute's string or template literals.
      for (const attr of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const text = (attr[1] ?? attr[2] ?? '').replace(/\$\{|\}|\?|:|["']/g, ' ')
        for (const word of text.split(/\s+/)) if (/^[a-z][a-z0-9-]*$/.test(word)) names.add(word)
      }
    }
    return names
  })()

  /**
   * `#81` put a total on the bar, `#84` put a repair's share beside it, and the
   * second one arrived wearing the lane's colour. Two ambers is no amber: the
   * whole value of the rule is that one thing has it.
   *
   * A selector counts as the bar's when every class in its last compound is one
   * the bar renders — scoped or not. `.btn.pri` has no `.bar` in it and was
   * still amber on the bar whenever Resume was being confirmed, which is exactly
   * the shape a filter on the selector's text lets through.
   */
  it('is worn by exactly one thing that can render on the bar, and it is the headline', () => {
    const onTheBar = wearers
      .flatMap((sel) => sel.split(',').map((s) => s.trim()))
      .filter((sel) => {
        const last =
          sel
            .replace(/:[a-z-]+(\([^)]*\))?/g, '')
            .split(' ')
            .pop() ?? ''
        const classes = [...last.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!)
        return classes.length > 0 && classes.every((c) => barClasses.has(c))
      })

    expect(onTheBar).toEqual(['.bar .head.sig'])
  })

  /** The guard above is only as good as its reading of the source. */
  it("reads the bar's classes, including the ones its components bring", () => {
    for (const c of [
      'bar',
      'head',
      'sig',
      'dot',
      'chip',
      'held',
      'btn',
      'why',
      'near',
      'filter',
      'menu',
      'tab',
      'prj',
      'phint',
      'addp',
      'pacts',
      'vsep',
    ]) {
      expect(barClasses.has(c)).toBe(true)
    }
  })

  /**
   * The chip variant the money wore. Deleted rather than left unused, because a
   * style with no wearer is the style the next chip is quietly added under —
   * which is how eleven objects got onto a row nobody argued about.
   */
  it('is not still available as a chip for the next one to reach for', () => {
    expect(css).not.toMatch(/\.chip\.sig\b/)
  })

  /**
   * The dot is pass/fail, which have been separate from the accent since the
   * palette was written. Stated here as the class the dot actually wears, so it
   * is the rendered thing being checked and not the union's spelling.
   */
  it('is not what the health dot paints with, in any state', () => {
    const amber = wearers.map((sel) => sel.replace(/\s+/g, ''))
    for (const [socket, health, runnable] of EVERY_STATE) {
      expect(amber).not.toContain(`.bar.dot.${bearing(socket, health, level, runnable).tone}`)
    }
  })
})

describe('the health dot counts attempts in flight (#640)', () => {
  it('says how many in the title when there are two, and nothing for one', () => {
    const two = bearing('open', board({ inFlight: ['lingtai#1', 'lingtai#2'] }), null, null)
    expect(two.title).toContain('2 attempts in flight')
    expect(bearing('open', board({ inFlight: ['lingtai#1'] }), null, null).title).not.toContain('in flight')
  })
})

describe('the health dot names a stopped projection (#840)', () => {
  const spend = { name: 'spend', checkpoint: '12', error: 'boom' }

  it('is warn and names the projection while the beacon is up', () => {
    const b = bearing('open', board({ stoppedProjections: [spend] }), null, null)
    expect(b.tone).toBe('warn')
    expect(b.label).toBe('spend stopped')
    expect(b.why).toContain('rebuild first, then restart')
    expect(b.command).toBe('lingtai projection rebuild spend, then lingtai restart')
    expect(b.title).toContain('spend stopped at seq 12: boom')
  })

  it('says not taking work for a stopped task_view', () => {
    const b = bearing(
      'open',
      board({ stoppedProjections: [{ name: 'task_view', checkpoint: '4', error: 'x' }] }),
      null,
      null,
    )
    expect(b.label).toBe('task_view stopped')
    expect(b.why).toContain('not taking work')
    expect(b.command).toContain('lingtai projection rebuild task_view')
  })

  it('counts several, and keeps the stopped remedy ahead of stale code', () => {
    const b = bearing(
      'open',
      board({ stoppedProjections: [spend, { name: 'ticket_report', checkpoint: null, error: 'x' }] }),
      behind,
      null,
    )
    expect(b.label).toBe('2 projections stopped')
    expect(b.command).toBe(
      'lingtai projection rebuild spend, lingtai projection rebuild ticket_report, then lingtai restart',
    )
    expect(b.title).toContain('at an unread checkpoint')
    expect(b.title).toContain(behind.said)
  })

  it('an empty list is exactly today’s answer', () => {
    const b = bearing('open', board(), null, null)
    expect(b.tone).toBe('pass')
    expect(b.why).toBeNull()
  })

  it('null gives today’s result with the predates title', () => {
    const b = bearing('open', board({ stoppedProjections: null }), null, null)
    expect(b.tone).toBe('pass')
    expect(b.title).toContain('the running daemon predates the stopped-projection report')
  })

  it('null with no board yet still says the daemon predates the report', () => {
    const b = bearing('open', board({ lag: null, stoppedProjections: null }), null, null)
    expect(b.label).toBe('no board yet')
    expect(b.title).toContain('the running daemon predates the stopped-projection report')
  })

  it('a stale beacon says stale, not stopped', () => {
    const stale = { daemon: 'stale', sinceBeatMs: 90_000, lag: 3 } as const
    const withList = bearing('open', board({ ...stale, stoppedProjections: [spend] }), null, null)
    expect(withList).toEqual(bearing('open', board({ ...stale, stoppedProjections: [] }), null, null))
    expect(`${withList.label} ${withList.why} ${withList.title}`).not.toContain('stopped')
  })

  it('crosses the wire: a bigint checkpoint does not break JSON', () => {
    const wire = stoppedOnTheWire([{ name: 'spend', checkpoint: 12n, error: 'boom' }])
    expect(JSON.parse(JSON.stringify(board({ stoppedProjections: wire }))).stoppedProjections[0].checkpoint).toBe('12')
    expect(stoppedOnTheWire(null)).toBeNull()
  })
})

describe('health keeps its command apart from its sentence (#904)', () => {
  const COMMAND = /lingtai (restart|doctor|daemon|projection)/

  it('has no command in any sentence, and the command the table gives', () => {
    const want: (string | null)[] = [
      null, // trouble: the remedy is a reload
      null, // connecting
      null, // asking
      'lingtai doctor', // unreadable
      'lingtai daemon', // never built
      'lingtai daemon --no-conduct', // behind, no daemon
      null, // catching up
      null, // current
      'lingtai daemon', // no daemon, nobody holds the lock, runnable
      'lingtai daemon', // the same, with a lag
      'lingtai doctor', // the lock could not be read
      null, // no daemon, nothing runnable
      null, // a run holds the lock
    ]
    EVERY_STATE.forEach(([socket, health, runnable], i) => {
      const said = bearing(socket, health, null, runnable)
      expect(said.command, `state ${i}`).toBe(want[i])
      if (said.why !== null) expect(said.why, `state ${i}`).not.toMatch(COMMAND)
    })
  })

  it('reads daemon 4 commits behind with lingtai restart for stale code', () => {
    const said = bearing('open', board(), behind, null)
    expect(said.why).toBe('daemon 4 commits behind')
    expect(said.command).toBe('lingtai restart')
  })

  it('is silent when well: no sentence and no command', () => {
    const said = bearing('open', board(), level, null)
    expect(said.why).toBeNull()
    expect(said.command).toBeNull()
  })
})

describe('the home bar in page.tsx (#904)', () => {
  const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
  // The bar's markup and the rail's late parts, which stream in `RailTail`.
  const bar =
    page.slice(page.search(/<Bar\s/), page.indexOf('<div className="cols">')) +
    page.slice(page.indexOf('async function PausedPart'), page.indexOf('async function BannerPart'))
  expect(bar.length).toBeGreaterThan(0)

  it('has no queued segment and no quiet headline', () => {
    expect(bar.length).toBeGreaterThan(0)
    expect(page).not.toContain('QueuedSegment')
    expect(bar).not.toContain('nothing waiting on you')
  })

  it('links the headline to the Waiting column, only while something waits', () => {
    expect(bar).toMatch(/waiting > 0 \? \(\s*<a className="head sig" href="#waiting"/)
    expect(page).toContain("id={col.id === 'waiting' ? 'waiting' : undefined}")
  })
})

describe('the dot warns when nothing conducts and the queue has runnable tickets (#1015)', () => {
  const idle = (over: Partial<Health> = {}) =>
    board({ daemon: 'stale', sinceBeatMs: 88_870_000, conductor: { held: null }, ...over })

  it('is a warning with the count, the command apart from the sentence', () => {
    const said = bearing('open', idle(), null, 4)
    expect(said.tone).toBe('warn')
    expect(said.label).toBe('no daemon · 4 runnable')
    expect(said.command).toBe('lingtai daemon')
    expect(said.why).not.toMatch(/lingtai /)
    expect(said.title).toContain('nobody holds the conductor lock')
  })

  it('is the same warning when the beacon was never written', () => {
    const said = bearing('open', idle({ daemon: 'never', sinceBeatMs: null }), null, 1)
    expect(said.label).toBe('no daemon · 1 runnable')
  })

  it('is quiet for zero runnable, and says so in the title', () => {
    const said = bearing('open', idle(), null, 0)
    expect(said.tone).toBe('pass')
    expect(said.why).toBeNull()
    expect(said.title).toContain('no daemon, and nothing is runnable')
  })

  it('is today’s answer when the count is unknown', () => {
    const was = bearing('open', idle({ conductor: null }), null, null)
    expect(bearing('open', idle(), null, null)).toEqual(was)
  })

  it('is today’s answer while something holds the lock, and names the holder', () => {
    const said = bearing('open', idle({ conductor: { held: 'lingtai run' } }), null, 4)
    expect(said.tone).toBe('pass')
    expect(said.title).toContain('conducted by lingtai run')
  })

  it('warns with lingtai doctor when the lock could not be read, never as nobody', () => {
    const said = bearing('open', idle({ conductor: { unread: 'EACCES' } }), null, 4)
    expect(said.tone).toBe('warn')
    expect(said.label).toBe('no daemon · 4 runnable')
    expect(said.command).toBe('lingtai doctor')
    expect(said.title).toContain('EACCES')
  })

  it('never warns from this branch while the daemon beats', () => {
    expect(bearing('open', board({ conductor: { held: null } }), null, 4).tone).toBe('pass')
  })
})
