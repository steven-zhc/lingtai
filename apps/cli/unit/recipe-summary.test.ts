/**
 * What `askRecipe` shows before anything is registered (#542, #620): the checks
 * that will run, whether anyone reads the change, and whether a person approves
 * the first merge — and that taking every default cannot slip past it.
 */
import type { RateRow } from '@lingtai/domain/rate-card'
import { type RecipeFiles } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { EMPTY_SETUP_READER } from '../src/detect-setup.ts'
import { stripColour } from '../src/output.ts'
import type { QuestionWorld } from '../src/question.ts'
import { askRecipe, ENV_PLANT_AT, priceHints, type RecipeAt, renderSummary, type Summary } from '../src/recipe-flow.ts'
import type { RuntimeFound } from '../src/runtimes.ts'

const HOME = '/home/me/.lingtai'
const CONFIRM = /register with the checks and landing above/
const RUNTIMES: readonly RuntimeFound[] = [{ id: 'claude-code', installed: true, signedIn: true, detail: 'signed in' }]

function mapFiles(): RecipeFiles {
  const store = new Map<string, string>()
  return {
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => void store.set(path, text),
  }
}

/** A terminal that answers every question with its default, and writes down what happened in order. */
function terminal(answer: (prompt: string) => string | null = () => ''): QuestionWorld & { events: string[] } {
  const events: string[] = []
  return {
    events,
    ask: async (prompt) => {
      events.push(`ask:${stripColour(prompt)}`)
      return answer(prompt)
    },
    log: (line) => events.push(`log:${stripColour(line)}`),
  }
}

const at = (over: Partial<RecipeAt>): RecipeAt => ({
  project: 'widget',
  local: true,
  runtimes: RUNTIMES,
  reader: EMPTY_SETUP_READER,
  flags: {},
  buildFlags: [],
  defaultBranch: async () => 'main',
  history: async () => [],
  seeds: [
    { path: ['repo', 'base'], value: 'main' },
    { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
    { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
  ],
  again: 'lingtai add --local /repo',
  kept: 'the recipe is kept',
  keptBeforeWrite: 'Nothing was written',
  home: HOME,
  files: mapFiles(),
  ...over,
})

const index = (events: string[], pattern: RegExp): number => events.findIndex((e) => pattern.test(e))

describe('the summary before registering (#542)', () => {
  it('taking every default at a terminal shows the empty build and the unattended landing, then stops to ask', async () => {
    const world = terminal()
    const result = await askRecipe(world, at({ flags: { install: 'none' } }))

    expect(result).toEqual({ ok: true })
    const shown = index(world.events, /Before registering widget/)
    const asked = index(world.events, CONFIRM)
    expect(shown).toBeGreaterThan(-1)
    expect(asked).toBeGreaterThan(shown)
    const text = world.events.join('\n')
    expect(text).toContain('steps.build is empty, so nothing checks a diff before review')
    expect(text).toContain('unattended — a pass that clears review lands on main with no person')
    expect(text).toContain('lingtai add --local /repo')
  })

  it('a no at that question registers nothing and says what is kept', async () => {
    const world = terminal((prompt) => (CONFIRM.test(prompt) ? 'no' : ''))
    const result = await askRecipe(world, at({ flags: { install: 'none' } }))
    expect(result).toMatchObject({ refused: expect.stringContaining('the recipe is kept') })
  })

  it('--build none and --land main are a person choosing, so the confirm is never asked', async () => {
    const world = terminal()
    const result = await askRecipe(world, at({ flags: { install: 'none', land: 'main' }, buildFlags: ['none'] }))
    expect(result).toEqual({ ok: true })
    expect(index(world.events, /Before registering widget/)).toBeGreaterThan(-1)
    expect(index(world.events, CONFIRM)).toBe(-1)
  })

  it('--land hold with a build given has nothing risky left to confirm', async () => {
    const world = terminal()
    await askRecipe(world, at({ flags: { install: 'none', land: 'hold' }, buildFlags: ['npm test'] }))
    const text = world.events.join('\n')
    expect(text).toContain('npm test')
    expect(text).toContain('held — every pass stops at proposed for a person')
    expect(index(world.events, CONFIRM)).toBe(-1)
  })

  it('--defaults prints the summary and asks nothing, so a headless run still works', async () => {
    const world = terminal(() => {
      throw new Error('a headless run was asked something')
    })
    const result = await askRecipe(world, at({ flags: { defaults: '', install: 'none' } }))
    expect(result).toEqual({ ok: true })
    expect(world.events.filter((e) => e.startsWith('ask:'))).toEqual([])
    expect(index(world.events, /Before registering widget/)).toBeGreaterThan(-1)
  })

  it('no terminal and no --defaults is refused with the flag, as before', async () => {
    const world = terminal(() => null)
    const result = await askRecipe(world, at({}))
    expect(result).toMatchObject({ refused: expect.stringMatching(/needs an answer: pass /) })
  })
})

describe('renderSummary', () => {
  it('says plainly when the build is empty, and what lands without a person', () => {
    const text = stripColour(
      renderSummary(
        'widget',
        { checks: [], review: null, landsUnattended: true, base: 'main', models: [] },
        'lingtai add owner/widget',
      ),
    )
    expect(text).toContain('Before registering widget')
    expect(text).toMatch(/checks\s+none — steps\.build is empty/)
    expect(text).toMatch(/review\s+none/)
    expect(text).toMatch(/change\s+lingtai add owner\/widget/)
  })
})

describe('the price hint after the summary (#693)', () => {
  const row = (model: string): RateRow => ({ model }) as unknown as RateRow
  const hints = (models: Summary['models'], snapshot: RateRow[] = []) => priceHints(models, snapshot)

  it('a shipped model prints nothing extra', () => {
    expect(hints([{ role: 'writer', model: 'claude-sonnet-5' }])).toEqual([])
  })

  it('a model in neither the card nor the snapshot names itself and lingtai doctor, once for both roles', () => {
    const lines = hints([
      { role: 'writer', model: 'mystery-1' },
      { role: 'reviewer', model: 'mystery-1' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('mystery-1 is not priced yet')
    expect(lines[0]).toContain('lingtai doctor')
    expect(lines[0]).not.toMatch(/cannot/)
  })

  it('a model only in the snapshot prints nothing extra', () => {
    expect(hints([{ role: 'writer', model: 'mystery-1' }], [row('mystery-1')])).toEqual([])
  })

  it('a null row in the snapshot is skipped, and an unreadable snapshot is said so', () => {
    const m: Summary['models'] = [{ role: 'writer', model: 'mystery-1' }]
    expect(hints(m, [null as unknown as RateRow, row('mystery-1')])).toEqual([])
    expect(hints(m, [null as unknown as RateRow])[0]).toContain('mystery-1 is not priced yet')
    expect(priceHints(m, null)[0]).toContain('could not be read')
  })

  it('roles with no model print the runtime-reports line once', () => {
    const lines = hints([
      { role: 'writer', model: null },
      { role: 'reviewer', model: null },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('its runtime reports')
  })

  it('askRecipe prints the hint after the summary and before the confirm', async () => {
    const world = terminal()
    await askRecipe(world, at({ flags: { install: 'none', model: 'mystery-1' }, rates: () => [] }))
    const shown = index(world.events, /Before registering widget/)
    const hint = index(world.events, /mystery-1 is not priced yet/)
    expect(hint).toBeGreaterThan(shown)
    expect(hint).toBeLessThan(index(world.events, CONFIRM))
  })
})
