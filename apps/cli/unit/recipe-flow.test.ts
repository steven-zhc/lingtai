/** Recipe behavior is exercised through the project list, with no questionnaire beside it. */
import { editRecipe, resolveSource } from '@lingtai/recipe'
import { PROJECT_QUESTION_IDS } from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { QuestionWorld } from '../src/question.ts'
import { walkProject } from '../test/project-list.ts'

const terminal = (answer: (prompt: string) => string | null = () => ''): QuestionWorld => ({
  ask: (prompt) => Promise.resolve(answer(prompt)),
  log: () => {},
})
const flags = { mode: 'solo', defaults: '', install: 'none' }
const run = (at: Parameters<typeof walkProject>[1] = {}, world = terminal()) =>
  Effect.runPromise(walkProject(world, at))
const textOf = (ctx: Awaited<ReturnType<typeof run>>['ctx']) =>
  editRecipe(ctx.start.text() ?? 'version: 2\n', ctx.pending)

const noDefaults = (prompt: string) => (/use this setup/.test(prompt) ? 'no' : '')

describe('the recipe at the end of the list', () => {
  it('walks every entry, derives the findings judge and never sets a draft', () =>
    run({ flags }).then(({ result, ctx }) => {
      expect(result.refused).toBeUndefined()
      expect(result.entries.map((e) => e.id)).toEqual(PROJECT_QUESTION_IDS)
      expect(result.entries.every((e) => !e.asked)).toBe(true)
      const recipe = resolveSource(textOf(ctx), 'widget', 'widget').recipe
      expect(recipe.steps.implement[0]).toMatchObject({ agent: 'claude-code' })
      expect(recipe.steps.proposed).toContainEqual(expect.objectContaining({ judge: 'claude-code', when: 'findings' }))
      expect(recipe.source).toMatchObject({
        tickets: 'github',
        kinds: ['bug', 'feature', 'tech-debt', 'documentation'],
      })
    }))

  it('every default on a rerun leaves no pending changes', () =>
    run({ flags })
      .then(({ ctx }) => run({ flags, start: textOf(ctx) }))
      .then(({ result, ctx }) => {
        expect(result.refused).toBeUndefined()
        expect(ctx.pending).toEqual([])
      }))

  it('flags win over --defaults, including repeated build commands containing commas', () =>
    run({
      flags: { ...flags, agent: 'codex', model: 'gpt-5.4', land: 'hold', budget: '12' },
      buildFlags: ['node -e "a,b"', 'pnpm test'],
    }).then(({ result, ctx }) => {
      expect(result.refused).toBeUndefined()
      const recipe = resolveSource(textOf(ctx), 'widget', 'widget').recipe
      expect(recipe.steps.build).toEqual([
        expect.objectContaining({ run: 'node -e "a,b"' }),
        expect.objectContaining({ run: 'pnpm test' }),
      ])
      expect(recipe.steps.proposed[0]).toHaveProperty('human')
      expect(recipe.steps.proposed[1]).toMatchObject({ judge: 'codex' })
    }))

  it('a typed yes to every default still asks the branch first', () =>
    run({ flags: { mode: 'solo', install: 'none' } }).then(({ result }) => {
      expect(result.entries.filter((e) => e.asked).map((e) => e.id)).toEqual(['branch', 'defaults', 'register'])
    }))

  it('a no at the last confirmation refuses the entire pending list', () =>
    run(
      { flags: { mode: 'solo', install: 'none' } },
      terminal((prompt) => (/register anyway/.test(prompt) ? 'no' : '')),
    ).then(({ result }) => expect(result.refused).toContain('nothing was written and nothing was registered')))

  it('no terminal takes defaults and never invokes an asker when the confirmations are explicitly answered', () =>
    run(
      {
        interactive: false,
        flags: { mode: 'solo', land: 'main' },
        buildFlags: ['none'],
      },
      terminal(() => {
        throw new Error('headless prompt')
      }),
    ).then(({ result }) => {
      expect(result.refused).toBeUndefined()
      expect(result.entries.every((e) => !e.asked)).toBe(true)
    }))

  it('registering unseen defaults without a terminal refuses by --defaults', () =>
    run({
      interactive: false,
      flags: { mode: 'solo' },
    }).then(({ result }) => expect(result.refused).toContain('--defaults')))

  it('a removed judge stays removed when the writer stays', () =>
    run({ flags })
      .then(({ ctx }) => {
        const start = editRecipe(textOf(ctx), [{ path: ['steps', 'proposed'], value: [] }])
        return run({ start, flags })
      })
      .then(({ ctx, result }) => {
        expect(result.refused).toBeUndefined()
        expect(ctx.pending).toEqual([])
      }))

  it('a changed writer updates its derived judge before the list ends', () =>
    run({ flags })
      .then(({ ctx }) => run({ flags: { ...flags, agent: 'codex' }, start: textOf(ctx) }))
      .then(({ ctx, result }) => {
        expect(result.refused).toBeUndefined()
        expect(resolveSource(textOf(ctx), 'widget', 'widget').recipe.steps.proposed).toContainEqual(
          expect.objectContaining({ judge: 'codex', when: 'findings' }),
        )
      }))

  it('asks the same recipe questions on a first run and rerun with the values in force as defaults', () =>
    run({ flags })
      .then(({ ctx }) =>
        Promise.all([
          run({ flags: { mode: 'solo' } }, terminal(noDefaults)),
          run({ start: textOf(ctx), flags: { mode: 'solo' } }, terminal(noDefaults)),
        ]),
      )
      .then(([first, again]) => {
        expect(first.result.entries.map((e) => [e.id, e.asked])).toEqual(
          again.result.entries.map((e) => [e.id, e.asked]),
        )
        expect(again.ctx.pending).toEqual([])
      }))
})
