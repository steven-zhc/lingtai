import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { BOUNDS, TRIAGE_ANSWERS_MAX, TRIAGE_QUESTIONS_MAX, TRIAGE_SPLIT_CHILDREN_MAX } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Recipe } from '../../../packages/recipe/src/recipe.ts'
import { HomePage } from '../src/app/page'

/**
 * #1265: the home page's "When it fails" section. The copy is the agreed mock's, and every number it
 * states is held here to the constant or recipe default that decides it, so a bound that changes makes
 * this go red naming the chip and the constant, and the site must then say the new number.
 */

const html = renderToStaticMarkup(<HomePage books={null} />)
const text = (s: string) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

const KEYS = ['api', 'flaky', 'review', 'unclear', 'big', 'main', 'limit']
const LANES: Record<string, string> = {
  api: 'Rule',
  flaky: 'Rule',
  review: 'One look',
  unclear: 'You',
  big: 'One look',
  main: 'Rule',
  limit: 'Rule',
}

/** The text of one chip's item. */
function item(key: string): string {
  const start = html.indexOf(`data-key="${key}"`)
  expect(start, `item ${key}`).toBeGreaterThan(-1)
  const end = html.indexOf('</details>', start)
  return text(html.slice(start, end))
}

const words: Record<number, string> = { 1: 'once', 2: 'twice' }
const word = (n: number) => words[n] ?? String(n)

// The recipe's defaults, read off the parsed schema: `runtime.limits.attempt.refusalFixes` and `ticket.newAttempts`.
const limits = (
  Recipe.shape.runtime.parse({}) as {
    limits: { attempt: { refusalFixes: number }; ticket: { newAttempts: number } }
  }
).limits

describe('the home page says where each failure goes', () => {
  it('sits after the replay and before the sandbox band', () => {
    const replay = html.indexOf('class="replay"')
    const section = html.indexOf('id="when-it-fails"')
    const sandbox = html.indexOf('class="sandbox-pitch"')
    expect(replay).toBeGreaterThan(-1)
    expect(section).toBeGreaterThan(replay)
    expect(sandbox).toBeGreaterThan(section)
  })

  it('has seven items with their lane tags, and no monthly counts', () => {
    expect(html.match(/class="fp-item"/g)).toHaveLength(7)
    for (const key of KEYS) expect(item(key), key).toContain(LANES[key])
    expect(html).not.toContain('fp-count')
    expect(text(html)).toContain('Pick a failure. See where it goes.')
    expect(text(html)).toContain('If the quick look itself fails, it asks once more, then hands it to you and says so.')
  })

  it('links the FAQ answer to the section without changing its words', () => {
    expect(html).toContain('<a href="#when-it-fails">fix attempts</a>')
    const answer = text(html.replace(/<\/?a[^>]*>/g, ''))
    expect(answer).toContain(
      'No. Each ticket gets a fixed number of fix attempts. When they run out, it stops and asks you what to do, with a suggested answer.',
    )
  })

  it('hides the drawing and opens the list until script runs', () => {
    expect(html).toMatch(/class="fp-live"[^>]*hidden/)
    expect(html).toMatch(/<details class="fp-all" open/)
  })
})

describe('the numbers the copy states', () => {
  it('api: 3 tries after 1, 5, then 15 minutes — BOUNDS.stepRedos and BOUNDS.stepRedoWaits', () => {
    const [a, b, c] = BOUNDS.stepRedoWaits.map((w) => w.replace(' minutes', '').replace(' minute', ''))
    expect(item('api')).toContain(`At most ${BOUNDS.stepRedos} tries, after ${a}, ${b}, then ${c} minutes`)
  })

  it('flaky: one rerun — process-action.ts reruns a non-zero exit exactly once (0108 §17, #1222); no constant', () => {
    const COMMAND_RERUNS = 1 // 0108 §17: a literal, there is no constant on main
    expect(item('flaky')).toContain(
      `${word(COMMAND_RERUNS)[0]!.toUpperCase()}${word(COMMAND_RERUNS).slice(1)} rerun only`.replace(
        'Once rerun',
        'One rerun',
      ),
    )
  })

  it('flaky and review: 6 fixes — recipe runtime.limits.attempt.refusalFixes', () => {
    expect(item('flaky')).toContain(`up to ${limits.attempt.refusalFixes} times`)
    expect(item('review')).toContain(`Up to ${limits.attempt.refusalFixes} fixes`)
  })

  it('flaky and review: a fresh start at most twice — recipe runtime.limits.ticket.newAttempts', () => {
    expect(item('flaky')).toContain(`at most ${word(limits.ticket.newAttempts)}`)
    expect(item('review')).toContain(`at most ${word(limits.ticket.newAttempts)}`)
  })

  it('unclear: 5 stops — BOUNDS.personAsks', () => {
    expect(item('unclear')).toContain(`Up to ${BOUNDS.personAsks} stops per ticket`)
    expect(item('unclear')).toContain(`After ${BOUNDS.personAsks} stops on one ticket`)
  })

  it('unclear: the question card — TRIAGE_QUESTIONS_MAX and TRIAGE_ANSWERS_MAX, with the 2 a literal', () => {
    const CHOICES_MIN = 2 // triage.ts: the answers array is `.min(2)`
    expect(item('unclear')).toContain(
      `Up to ${TRIAGE_QUESTIONS_MAX} questions at a time, ${CHOICES_MIN} to ${TRIAGE_ANSWERS_MAX} choices each`,
    )
  })

  it('big: split once, into at most 8 — BOUNDS.ticketSplits and TRIAGE_SPLIT_CHILDREN_MAX', () => {
    expect(item('big')).toContain(
      `Split ${word(BOUNDS.ticketSplits)} per ticket, into at most ${TRIAGE_SPLIT_CHILDREN_MAX}`,
    )
  })

  it('main: 10 merges — BOUNDS.baseBranchMerges', () => {
    expect(item('main')).toContain(`Up to ${BOUNDS.baseBranchMerges} merges per try`)
    expect(item('main')).toContain(`Main moved ${BOUNDS.baseBranchMerges} times`)
  })

  it('the edge line asks once more — BOUNDS.triageRetries', () => {
    expect(BOUNDS.triageRetries).toBe(1)
    expect(text(html)).toContain(`it asks ${word(BOUNDS.triageRetries)} more`)
  })
})

describe('the drawing component', () => {
  it('imports only react, and nothing server-only reaches it', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '../src/app/failure-paths-stage.tsx'), 'utf8')
    expect(source.startsWith("'use client'")).toBe(true)
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['react'])
  })
})
