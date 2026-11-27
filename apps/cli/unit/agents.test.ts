import { recipePath, resolveLocalRecipeEffect } from '@lingtai/project'
import { draftOver, seedRecipe } from '@lingtai/project/test/seed-recipe'
/**
 * `askAgents` (#398): which agent writes the change, and which cold-reviews
 * it, as per-project recipe questions. A fake `QuestionWorld` with scripted
 * answers, and a `Map`-backed `RecipeFiles` — no filesystem, no terminal.
 */
import { type RecipeFiles } from '@lingtai/recipe'
import { skipSandboxHost } from '@lingtai/recipe/test/sandbox-host'
import type { RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ANOTHER, askAgents as askAgentsEffect, RUNTIME_DEFAULT } from '../src/agents.ts'
import type { QuestionWorld } from '../src/question.ts'

const askAgents = (...args: Parameters<typeof askAgentsEffect>) => Effect.runPromise(askAgentsEffect(...args))

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)

const FIXTURE = `version: 2
branch:
  main: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`

function runtime(
  id: 'claude-code' | 'codex',
  opts: { state?: RuntimeFound['state']; detail?: string } = {},
): RuntimeFound {
  const state = opts.state ?? 'signed-in'
  return {
    id,
    state,
    signedIn: state === 'signed-in',
    detail: opts.detail ?? (state === 'signed-in' ? 'signed in via claude.ai' : 'not signed in'),
  }
}

function fakeWorld(answers: (string | null)[] = []): { world: QuestionWorld; lines: string[]; asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    lines,
    asked,
    world: {
      ask: async (prompt) => {
        asked.push(prompt)
        return queue.length > 0 ? queue.shift()! : null
      },
      log: (line) => lines.push(line),
    },
  }
}

interface RecordingFiles extends RecipeFiles {
  replaced: { path: string; text: string }[]
}

function mapFiles(initial: Record<string, string> = {}): RecordingFiles {
  const store = new Map(Object.entries(initial))
  const replaced: { path: string; text: string }[] = []
  return {
    replaced,
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => {
      replaced.push({ path, text })
      store.set(path, text)
    },
  }
}

describe('askAgents at a terminal that draws selects', () => {
  const WITH_MODEL = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      model: opus\n      prompt: ''\n`
  const both = [runtime('claude-code'), runtime('codex')]

  it('offers a list at the writer, reviewer and both model questions', async () => {
    const shapes: (readonly string[] | undefined)[] = []
    const { world } = fakeWorld(['', '', '', ''])
    const ask = world.ask
    world.ask = async (prompt, shape) => {
      shapes.push(shape?.choices)
      return ask(prompt, shape)
    }
    const result = await askAgents(world, {
      project: 'app',
      runtimes: both,
      flags: {},
      home: HOME,
      draft: await draftOver('app', { home: HOME, files: mapFiles({ [PATH]: FIXTURE }) }),
    })
    expect('refused' in result).toBe(false)
    expect(shapes).toEqual([
      ['claude-code', 'codex'],
      [RUNTIME_DEFAULT, ANOTHER],
      ['claude-code', 'codex', 'none'],
      [RUNTIME_DEFAULT, ANOTHER],
    ])
  })

  it("the runtime's own default writes no model, though the recipe names one", async () => {
    const { world } = fakeWorld(['', RUNTIME_DEFAULT, '', ''])
    const result = await askAgents(world, {
      project: 'app',
      runtimes: both,
      flags: {},
      home: HOME,
      draft: await draftOver('app', { home: HOME, files: mapFiles({ [PATH]: WITH_MODEL }) }),
    })
    if ('refused' in result) throw new Error(result.refused)
    expect(result.modelChanges).toContainEqual({ path: ['steps', 'implement', 0, 'model'], value: undefined })
  })

  it('a model named like the runtime-default row is kept as a model', async () => {
    const named = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      model: the runtime's own default\n      prompt: ''\n`
    const { world } = fakeWorld(['', '', '', ''])
    const result = await askAgents(world, {
      project: 'app',
      runtimes: both,
      flags: {},
      home: HOME,
      draft: await draftOver('app', { home: HOME, files: mapFiles({ [PATH]: named }) }),
    })
    if ('refused' in result) throw new Error(result.refused)
    expect(result.modelChanges).not.toContainEqual({ path: ['steps', 'implement', 0, 'model'], value: undefined })
  })

  it('another asks for a name and writes it', async () => {
    const { world, asked } = fakeWorld(['', ANOTHER, 'haiku', '', ''])
    const result = await askAgents(world, {
      project: 'app',
      runtimes: both,
      flags: {},
      home: HOME,
      draft: await draftOver('app', { home: HOME, files: mapFiles({ [PATH]: WITH_MODEL }) }),
    })
    if ('refused' in result) throw new Error(result.refused)
    expect(asked.some((p) => p.includes('which model — its name'))).toBe(true)
    expect(result.modelChanges).toContainEqual({ path: ['steps', 'implement', 0, 'model'], value: 'haiku' })
  })
})

describe('askAgents', () => {
  describe('only signed-in runtimes are offered', () => {
    it('logs why a runtime installed and signed out is missing', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, lines } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect('refused' in result).toBe(false)
      expect(lines.some((l) => l.includes('codex is installed and signed out'))).toBe(true)
    })

    it('a flag naming a runtime not signed in is refused, and ask is never called', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked } = fakeWorld(['should not be reached'])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: { agent: 'codex' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      expect((result as { refused: string }).refused).toContain('codex is installed and signed out')
      expect(asked).toEqual([])
    })

    it('a typed name that is not signed in re-asks', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked, lines } = fakeWorld(['codex', 'claude-code', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect('refused' in result).toBe(false)
      expect(asked.length).toBeGreaterThan(1)
      expect(lines.some((l) => l.includes('sign in to it'))).toBe(true)
    })

    it('a codex that does not start is said to, with the first line it printed, and not told to sign in', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, lines } = fakeWorld(['', '', '', ''])
      await askAgents(world, {
        project: 'app',
        runtimes: [
          runtime('claude-code'),
          runtime('codex', { state: 'did-not-start', detail: 'dyld[1]: Library not loaded\nReferenced from: node' }),
        ],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      const line = lines.find((l) => l.includes('codex'))
      expect(line).toContain('codex is installed but does not start: dyld[1]: Library not loaded')
      expect(line).not.toContain('Referenced from')
      expect(line).not.toContain('sign in')
    })

    it('a typed answer that is no runtime names the choices and does not say sign in', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, lines } = fakeWorld(['pnpm install', 'claude-code', '', '', ''])
      await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      const line = lines.find((l) => l.includes('pnpm install is not a runtime'))
      expect(line).toContain('choose one of claude-code, codex')
      expect(line).not.toContain('sign in')
    })

    it('an empty answer is refused with a sentence that names no runtime and lists the choices (#727)', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world } = fakeWorld()
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: { agent: '' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      const refused = (result as { refused: string }).refused
      expect(refused).toMatch(/^no agent is chosen yet — choose one of claude-code, codex/)
      expect(refused).not.toMatch(/^\s/)
    })

    it('refuses before any question when nothing is signed in', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked } = fakeWorld(['should not be reached'])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [
          runtime('claude-code', { state: 'signed-out' }),
          runtime('codex', { state: 'not-installed', detail: 'spawn codex ENOENT' }),
        ],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      expect(asked).toEqual([])
    })

    it("a reviewer this machine is signed out of is still the recipe's default, and taking it changes nothing", async () => {
      const WITH_SIGNED_OUT_REVIEWER = `${FIXTURE}steps:\n  review:\n    - name: review\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: WITH_SIGNED_OUT_REVIEWER })
      const { world, asked } = fakeWorld(['', '', '', ''])
      const draft = await draftOver('app', { home: HOME, files })
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft,
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(asked.find((p) => p.includes('cold reviewer'))!).toContain('[codex]')
      // Applied to the draft, the reviewer's own answers write nothing to the review step.
      await Effect.runPromise(draft.set(result.changes.filter((c) => c.path[1] === 'review')))
      await Effect.runPromise(draft.set(result.modelChanges.filter((c) => c.path[1] === 'review')))
      expect(draft.text()).toBe(WITH_SIGNED_OUT_REVIEWER)
    })
  })

  describe('an empty model is an answer a flag can give (#736)', () => {
    const codexOnly = [
      runtime('claude-code', { state: 'not-installed', detail: 'spawn claude ENOENT' }),
      runtime('codex'),
    ]
    const headless = (): QuestionWorld => ({ ask: async () => null, log: () => {} })

    it("--model '' with no terminal is not refused, and writes no model:", async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const result = await askAgents(headless(), {
        project: 'app',
        runtimes: codexOnly,
        flags: { agent: 'codex', model: '', reviewer: 'none' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(JSON.stringify(result.changes)).not.toContain('"model"')
      for (const c of result.modelChanges) {
        if (c.path.includes('implement')) expect(c.value).toBeUndefined()
      }
    })

    it("no --model with no terminal is refused naming --model ''", async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const result = await askAgents(headless(), {
        project: 'app',
        runtimes: codexOnly,
        flags: { agent: 'codex', reviewer: 'none' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect((result as { refused: string }).refused).toContain("--model ''")
    })

    it("no --reviewer-model with no terminal is refused naming --reviewer-model ''", async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const result = await askAgents(headless(), {
        project: 'app',
        runtimes: codexOnly,
        flags: { agent: 'codex', model: '', reviewer: 'codex' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect((result as { refused: string }).refused).toContain("--reviewer-model ''")
    })
  })

  describe('a second agent: entry at steps.review is left as written', () => {
    it('refuses rather than write a recipe that fails the next pass, when the leftover entry is not signed in', async () => {
      // Only the first `agent:` entry is ever asked about (`findAgentAction`)
      // — the question on attempt 1 that left a second one, on a signed-out
      // runtime, silently in place. The written recipe then fails
      // `agentRefusal` (`conduct.ts:282`), which reads every `agent:` in the
      // file, before the first pass even claims — so this must never write.
      const TWO_REVIEWERS = `${FIXTURE}steps:\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n    - name: second review\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: TWO_REVIEWERS })
      const { world } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      const refusal = (result as { refused: string }).refused
      expect(refusal).toContain('second review')
      expect(refusal).toContain('codex')
      expect(refusal).toContain('not signed in')
      expect(files.replaced).toEqual([])
    })

    it('answering none removes the leftover entry too, so it is never checked against sign-in', async () => {
      // The leftover entry's runtime is not signed in — which would refuse
      // above — but `none` replaces the whole list, taking it with it, so
      // there is nothing left to warn about or refuse.
      const TWO_REVIEWERS = `${FIXTURE}steps:\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n    - name: second review\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: TWO_REVIEWERS })
      const { world, lines } = fakeWorld(['', '', 'none'])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(lines.some((l) => l.includes('second review'))).toBe(false)
      expect(result.changes).toContainEqual({ path: ['steps', 'review'], value: [] })
    })

    it('logs that a leftover entry is left as written when its own runtime is signed in', async () => {
      const TWO_REVIEWERS = `${FIXTURE}steps:\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n    - name: second review\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: TWO_REVIEWERS })
      const { world, lines } = fakeWorld(['claude-code', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(lines.some((l) => l.includes('second review') && l.includes('left as written'))).toBe(true)
      // The second entry is left exactly as written — never rewritten to the
      // answer the first entry got.
      expect(result.changes.some((c) => c.path.includes(1) && c.path[0] === 'steps' && c.path[1] === 'review')).toBe(
        false,
      )
    })
  })

  describe('a leftover agent: entry anywhere else in the recipe is checked too', () => {
    it('refuses a second steps.implement entry on a signed-out runtime, not just a second steps.review one', async () => {
      // The guard above walked `steps.review` only, but `agentRefusal`
      // (`conduct.ts:282`) reads every step's every action — a second
      // `agent:` left in `steps.implement` fails the very next pass exactly
      // as an untouched second `steps.review` entry would.
      const TWO_IMPLEMENTERS = `${FIXTURE}steps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      prompt: ''\n    - name: second pass\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: TWO_IMPLEMENTERS })
      const { world } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      const refusal = (result as { refused: string }).refused
      expect(refusal).toContain('second pass')
      expect(refusal).toContain('codex')
      expect(refusal).toContain('not signed in')
      expect(files.replaced).toEqual([])
    })

    it('refuses a runtime judge: at a step this write never touches, such as steps.proposed', async () => {
      const JUDGE_AT_PROPOSED = `${FIXTURE}steps:\n  proposed:\n    - name: findings\n      judge: codex\n      when: red\n`
      const files = mapFiles({ [PATH]: JUDGE_AT_PROPOSED })
      const { world } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      const refusal = (result as { refused: string }).refused
      expect(refusal).toContain('findings')
      expect(refusal).toContain('judge codex')
      expect(refusal).toContain('not signed in')
      expect(files.replaced).toEqual([])
    })
  })

  describe('the findings judge init wrote follows the writer (#1519)', () => {
    const INIT_JUDGE = { name: 'send findings back to the writer', judge: 'codex', when: 'findings' }
    const recipeWith = (proposed: Record<string, unknown>[]) =>
      `${FIXTURE}runtime:\n  agent: codex\nsteps:\n  implement:\n    - name: write the change\n      agent: codex\n      prompt: ''\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n  proposed:\n${proposed
        .map(
          (e) =>
            `    - ${Object.entries(e)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n      ')}`,
        )
        .join('\n')}\n`
    const run = async (proposed: Record<string, unknown>[], answers: string[], codexIn = true) => {
      const files = mapFiles({ [PATH]: recipeWith(proposed) })
      const { world, lines } = fakeWorld(answers)
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: codexIn ? 'signed-in' : 'signed-out' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      return { result, lines }
    }

    it('says nothing and changes nothing under steps.proposed when every default is taken', async () => {
      const { result, lines } = await run([INIT_JUDGE], ['', '', '', ''])
      if ('refused' in result) throw new Error(result.refused)
      expect(lines.some((l) => l.includes('also names'))).toBe(false)
      expect(result.changes.some((c) => c.path[1] === 'proposed')).toBe(false)
    })

    it('rewrites judge to the new writer, and is not refused when codex is signed out', async () => {
      const { result } = await run([INIT_JUDGE], ['claude-code', '', '', ''], false)
      if ('refused' in result) throw new Error(result.refused)
      expect(result.changes).toContainEqual({ path: ['steps', 'proposed', 0, 'judge'], value: 'claude-code' })
    })

    it('treats the entry as init’s when only name: was changed', async () => {
      const { result, lines } = await run([{ ...INIT_JUDGE, name: 'mine now' }], ['claude-code', '', '', ''])
      if ('refused' in result) throw new Error(result.refused)
      expect(lines.some((l) => l.includes('mine now'))).toBe(false)
      expect(result.changes).toContainEqual({ path: ['steps', 'proposed', 0, 'judge'], value: 'claude-code' })
    })

    it('still logs a findings judge naming another runtime when signed in', async () => {
      const { result, lines } = await run([{ ...INIT_JUDGE, judge: 'claude-code' }], ['', '', '', ''])
      if ('refused' in result) throw new Error(result.refused)
      expect(lines.some((l) => l.includes('also names judge claude-code'))).toBe(true)
    })

    it('still refuses a findings judge naming another runtime when it is signed out', async () => {
      const files = mapFiles({
        [PATH]: recipeWith([{ ...INIT_JUDGE, judge: 'claude-code' }]).replace('agent: claude-code', 'agent: codex'),
      })
      const { world } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code', { state: 'signed-out' }), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      expect((result as { refused: string }).refused).toContain('judge claude-code')
    })

    it('only the first findings judge is init’s: a second naming the writer is logged', async () => {
      const { result, lines } = await run(
        [
          { ...INIT_JUDGE, name: 'first', judge: 'claude-code' },
          { ...INIT_JUDGE, name: 'second' },
        ],
        ['claude-code', '', '', ''],
      )
      if ('refused' in result) throw new Error(result.refused)
      expect(result.changes.some((c) => c.path[1] === 'proposed')).toBe(false)
      expect(lines.some((l) => l.includes('"second"') && l.includes('also names judge codex'))).toBe(true)
    })
  })

  describe('the reviewer defaults to a different model', () => {
    it('with two signed in, the reviewer default is the other runtime', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked } = fakeWorld(['claude-code', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(asked.some((p) => p.includes('[codex]'))).toBe(true)
      expect(result.changes).toContainEqual({
        path: ['steps', 'review'],
        value: [{ name: 'review', agent: 'codex', prompt: '' }],
      })
    })

    it('with one signed in, the reviewer default is the same runtime, and the same-model line is logged', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked, lines } = fakeWorld(['claude-code', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'not-installed', detail: 'spawn codex ENOENT' })],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(asked.some((p) => p.includes('cold reviewer') && p.includes('[claude-code]'))).toBe(true)
      expect(lines.some((l) => l.includes("the reviewer runs the writer's runtime, on its own default model"))).toBe(
        true,
      )
    })

    it('--model X on the writer does not default the reviewer model to X', async () => {
      // An existing review action with no `model:` of its own, so the
      // reviewer-model question's default is exercised through
      // `path: [...,'model']` rather than through a whole-list `steps.review`
      // write. Every reviewer-model write goes into `modelChanges`
      // (`agents.ts`'s `modelChanges.push` for `steps.review`), never
      // `changes` — reading `result.changes` here made the assertion
      // vacuously true regardless of what the reviewer's model defaulted to.
      const WITH_REVIEWER = `${FIXTURE}steps:\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: WITH_REVIEWER })
      const { world } = fakeWorld(['', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'not-installed', detail: 'spawn codex ENOENT' })],
        flags: { model: 'X' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(result.modelChanges).toContainEqual({ path: ['steps', 'review', 0, 'model'], value: undefined })
    })
  })

  describe("the writer question's default is who actually writes, and runtime.agent is always written", () => {
    it("a step's own agent, not runtime.agent, is offered and kept on enter — and runtime.agent is left as written", async () => {
      // `runtime.agent` names claude-code, but the implement step's own
      // `agent:` overrides it with codex. Pressing enter keeps the answer the
      // question asked about; `runtime.agent` is a separate setting that a
      // rerun taking every default does not overwrite (#1473).
      const STEP_OVERRIDES_RUNTIME = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: STEP_OVERRIDES_RUNTIME })
      const { world, asked } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(asked[0]).toContain('[codex]')
      expect(result.changes).toContainEqual({ path: ['steps', 'implement', 0, 'agent'], value: 'codex' })
      expect(result.changes.some((c) => c.path[0] === 'runtime')).toBe(false)
    })

    it("an explicit switch away from the step's own agent moves runtime.agent", async () => {
      const STEP_OVERRIDES_RUNTIME = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: STEP_OVERRIDES_RUNTIME })
      const { world } = fakeWorld(['claude-code', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(result.changes).toContainEqual({ path: ['runtime', 'agent'], value: 'claude-code' })
      expect(result.changes).toContainEqual({ path: ['steps', 'implement', 0, 'agent'], value: 'claude-code' })
    })

    it("switching the writer does not carry the old writer's model onto the new one", async () => {
      const WRITER_WITH_MODEL = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      model: claude-opus-5\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: WRITER_WITH_MODEL })
      const { world, asked } = fakeWorld(['codex', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      const modelPrompt = asked.find((p) => p.includes('which model'))!
      expect(modelPrompt).not.toContain('[claude-opus-5]')
      expect(result.modelChanges).toContainEqual({ path: ['steps', 'implement', 0, 'model'], value: undefined })
    })

    it('a writer switch removes the model, and the comment on it goes with it (0104 §14)', async () => {
      // The recipe is machine-managed: a key a change removes takes its own
      // comment with it, and nothing refuses to write for that.
      const COMMENTED_MODEL = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      # opus, because the review prompt below is a hundred lines and sonnet skims it\n      model: opus\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: COMMENTED_MODEL })
      const { world } = fakeWorld(['codex', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)

      await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const written = await Effect.runPromise(seedRecipe('app', result.modelChanges, { home: HOME, files }))
      expect(written.text).not.toContain('model: opus')
      expect(written.text).not.toContain('opus, because the review prompt')
    })

    it("switching the writer on a commented action keeps the action's own comment", async () => {
      // A comment above the implement action is about the action, which a
      // writer switch edits in place rather than removes, so it stays.
      const COMMENTED_IMPLEMENT = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    # the writer: this is the action that opens the branch\n    - name: write the change\n      agent: claude-code\n      model: opus\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: COMMENTED_IMPLEMENT })
      const { world } = fakeWorld(['codex', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)

      await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const written = await Effect.runPromise(seedRecipe('app', result.modelChanges, { home: HOME, files }))

      expect(written.text).toContain('the writer: this is the action that opens the branch')
      const resolved = await Effect.runPromise(
        resolveLocalRecipeEffect('app', {
          home: HOME,
          read: files.read,
          ...skipSandboxHost,
          signedIn: async () => ['claude-code', 'codex'],
        }),
      )
      expect((resolved.recipe.steps.implement[0] as { agent?: string }).agent).toBe('codex')
      expect((resolved.recipe.steps.implement[0] as { model?: string }).model).toBeUndefined()
    })

    it('a rerun that changes the writer from codex to claude-code changes the agent keys alone, and a hand-edited key stays', async () => {
      const CODEX = `${FIXTURE}runtime:\n  agent: codex\n  limits:\n    run:\n      turns: 77\nsteps:\n  implement:\n    - name: write the change\n      agent: codex\n      prompt: ''\n  review:\n    - name: review\n      agent: claude-code\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: CODEX })
      const { world } = fakeWorld(['claude-code', '', 'claude-code', ''])
      const draft = await draftOver('app', { home: HOME, files })
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft,
      })
      if ('refused' in result) throw new Error(result.refused)
      await Effect.runPromise(draft.set([...result.changes, ...result.modelChanges]))
      // The two agent keys moved and no other byte of the file did.
      expect(draft.text()).toBe(
        CODEX.replace('runtime:\n  agent: codex', 'runtime:\n  agent: claude-code').replace(
          '      agent: codex',
          '      agent: claude-code',
        ),
      )
      expect(draft.get(['runtime', 'limits', 'run', 'turns'])).toBe(77)
      expect(draft.get(['runtime', 'agent'])).toBe('claude-code')
    })

    it('a runtime.agent that is installed but signed out is still the default, and a rerun on it changes nothing', async () => {
      const RUNTIME_SIGNED_OUT = `${FIXTURE}runtime:\n  agent: codex\nsteps:\n  implement:\n    - name: write the change\n      agent: codex\n      prompt: ''\n  review: []\n`
      const files = mapFiles({ [PATH]: RUNTIME_SIGNED_OUT })
      const { world, asked } = fakeWorld(['', '', '', ''])
      const draft = await draftOver('app', { home: HOME, files })
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex', { state: 'signed-out', detail: 'not signed in' })],
        flags: {},
        home: HOME,
        draft,
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(asked[0]).toContain('[codex]')
      await Effect.runPromise(draft.set([...result.changes, ...result.modelChanges]))
      expect(draft.text()).toBe(RUNTIME_SIGNED_OUT)
      expect(draft.changes()).toEqual([])
    })

    it('a hand-edited runtime.agent beside an unchanged steps.implement writer is not overwritten by taking every default', async () => {
      const HAND_EDITED = `${FIXTURE}runtime:\n  agent: codex\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      prompt: ''\n  review: []\n`
      const files = mapFiles({ [PATH]: HAND_EDITED })
      const { world } = fakeWorld(['', '', '', ''])
      const draft = await draftOver('app', { home: HOME, files })
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft,
      })
      if ('refused' in result) throw new Error(result.refused)
      await Effect.runPromise(draft.set([...result.changes, ...result.modelChanges]))
      expect(draft.text()).toBe(HAND_EDITED)
      expect(draft.get(['runtime', 'agent'])).toBe('codex')
    })

    it('a signed-out writer taken as the default does not fail on the judge init generated for it', async () => {
      const JUDGED = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      prompt: ''\n  review: []\n  proposed:\n    - name: findings\n      judge: claude-code\n      when: red\n`
      const files = mapFiles({ [PATH]: JUDGED })
      const { world } = fakeWorld(['', '', '', ''])
      const draft = await draftOver('app', { home: HOME, files })
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code', { state: 'signed-out' }), runtime('codex')],
        flags: {},
        home: HOME,
        draft,
      })
      if ('refused' in result) throw new Error(result.refused)
      await Effect.runPromise(draft.set([...result.changes, ...result.modelChanges]))
      expect(draft.text()).toBe(JUDGED)
    })

    it('runtime.agent absent and steps.implement already naming a signed-in writer still writes runtime.agent on enter', async () => {
      // No `runtime:` key at all — the exact shape of attempt 1's finding 1:
      // two runtimes signed in, the step already carries a writer, and the
      // operator presses enter on every question.
      const NO_RUNTIME_KEY = `${FIXTURE}steps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: NO_RUNTIME_KEY })
      const { world } = fakeWorld(['', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(result.changes).toContainEqual({ path: ['runtime', 'agent'], value: 'claude-code' })

      const written = await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const resolved = await Effect.runPromise(
        resolveLocalRecipeEffect('app', {
          home: HOME,
          read: files.read,
          ...skipSandboxHost,
          signedIn: async () => ['claude-code', 'codex'],
        }),
      )
      expect(written.written).toBe(true)
      expect(resolved.recipe.runtime.agent).toBe('claude-code')
    })
  })

  describe('--reviewer none writes no review agent', () => {
    it('on a fixture with no reviewer, writes steps.review: []', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world } = fakeWorld(['claude-code', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: { reviewer: 'none' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      expect(result.changes).toContainEqual({ path: ['steps', 'review'], value: [] })
      expect(result.changes.some((c) => c.path[0] === 'steps' && c.path[1] === 'review' && c.path.length > 2)).toBe(
        false,
      )
    })

    it('--reviewer-model beside --reviewer none is refused, asking no third question', async () => {
      const files = mapFiles({ [PATH]: FIXTURE })
      const { world, asked } = fakeWorld(['claude-code', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: { reviewer: 'none', reviewerModel: 'opus' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      expect(result).toHaveProperty('refused')
      // Writer, then its model: two questions asked before the reviewer flag
      // is even read. A third — the reviewer's own model — would mean the
      // flag beside `none` was silently ignored rather than refused.
      expect(asked).toHaveLength(2)
    })

    it('over a fixture that already has a reviewer, the resolved steps.review contains no agent action', async () => {
      const WITH_REVIEWER = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  review:\n    - name: review\n      agent: codex\n      prompt: ''\n`
      const files = mapFiles({ [PATH]: WITH_REVIEWER })
      const { world } = fakeWorld(['', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: { reviewer: 'none' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      const { text } = await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const resolved = await Effect.runPromise(
        resolveLocalRecipeEffect('app', {
          home: HOME,
          read: files.read,
          ...skipSandboxHost,
          signedIn: async () => ['claude-code', 'codex'],
        }),
      )
      expect(text).toBeDefined()
      expect(resolved.recipe.steps.review.some((a) => 'agent' in a)).toBe(false)
    })
  })

  it('the written recipe resolves, with runtime.agent set and no AgentUnresolvedError', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world } = fakeWorld(['claude-code', 'opus', '', ''])
    const result = await askAgents(world, {
      project: 'app',
      runtimes: [runtime('claude-code'), runtime('codex')],
      flags: {},
      home: HOME,
      draft: await draftOver('app', { home: HOME, files }),
    })
    if ('refused' in result) throw new Error(result.refused)

    await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
    await Effect.runPromise(seedRecipe('app', result.modelChanges, { home: HOME, files }))
    const resolved = await Effect.runPromise(
      resolveLocalRecipeEffect('app', {
        home: HOME,
        read: files.read,
        ...skipSandboxHost,
        signedIn: async () => ['claude-code', 'codex'],
      }),
    )

    expect(resolved.recipe.runtime.agent).toBe('claude-code')
    expect(resolved.provenance?.['runtime.agent']).toContain(PATH)
    expect(resolved.provenance?.['runtime.agent']).not.toContain('detected')
    expect((resolved.recipe.steps.implement[0] as { model?: string; agent?: string } | undefined)?.model).toBe('opus')
    expect((resolved.recipe.steps.implement[0] as { agent?: string } | undefined)?.agent).toBe('claude-code')
  })

  describe('a re-run keeps the prompt', () => {
    const RERUN_FIXTURE = `${FIXTURE}runtime:\n  agent: claude-code\nsteps:\n  implement:\n    - name: write the change\n      agent: claude-code\n      model: opus\n      prompt: |\n        Read the ticket.\n        Write the change.\n  review: []\n`

    it('every default taken writes nothing', async () => {
      const files = mapFiles({ [PATH]: RERUN_FIXTURE })
      const { world } = fakeWorld(['', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      const written = await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      expect(written.written).toBe(false)
    })

    it('--model x changes only the model: line', async () => {
      const files = mapFiles({ [PATH]: RERUN_FIXTURE })
      const { world } = fakeWorld(['', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code')],
        flags: { model: 'x' },
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const written = await Effect.runPromise(seedRecipe('app', result.modelChanges, { home: HOME, files }))
      expect(written.written).toBe(true)
      expect(written.text).toContain('model: x')
      expect(written.text).toContain('Read the ticket.')
    })

    it('switching the writer keeps the prompt, compared as an exact string', async () => {
      const files = mapFiles({ [PATH]: RERUN_FIXTURE })
      const { world } = fakeWorld(['codex', '', '', ''])
      const result = await askAgents(world, {
        project: 'app',
        runtimes: [runtime('claude-code'), runtime('codex')],
        flags: {},
        home: HOME,
        draft: await draftOver('app', { home: HOME, files }),
      })
      if ('refused' in result) throw new Error(result.refused)
      const written = await Effect.runPromise(seedRecipe('app', result.changes, { home: HOME, files }))
      const resolved = await Effect.runPromise(
        resolveLocalRecipeEffect('app', {
          home: HOME,
          read: files.read,
          ...skipSandboxHost,
          signedIn: async () => ['claude-code', 'codex'],
        }),
      )
      expect((resolved.recipe.steps.implement[0] as { prompt?: string } | undefined)?.prompt).toBe(
        'Read the ticket.\nWrite the change.\n',
      )
      expect(written.text).toContain('Read the ticket.')
    })
  })
})

describe('a runtime that cannot hold a turn count (#547)', () => {
  const ask = async (fixture: string, agent: 'claude-code' | 'codex') => {
    const { world } = fakeWorld([])
    const result = await askAgents(world, {
      project: 'app',
      runtimes: [runtime('claude-code'), runtime('codex')],
      flags: { agent, reviewer: 'none', model: '' },
      home: HOME,
      draft: await draftOver('app', { home: HOME, files: mapFiles({ [PATH]: fixture }) }),
    })
    if ('refused' in result) throw new Error(result.refused)
    return result.changes.filter((c) => c.path.join('.') === 'runtime.limits.run.turns')
  }

  it('writes turns: unbounded once for codex', async () => {
    expect(await ask(FIXTURE, 'codex')).toEqual([{ path: ['runtime', 'limits', 'run', 'turns'], value: 'unbounded' }])
  })

  it('writes nothing where the file already declares turns', async () => {
    expect(await ask(`${FIXTURE}runtime:\n  limits:\n    run:\n      turns: 150\n`, 'codex')).toEqual([])
  })

  it('writes nothing for a runtime that enforces turns', async () => {
    expect(await ask(FIXTURE, 'claude-code')).toEqual([])
  })
})
