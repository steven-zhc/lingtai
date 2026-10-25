import type { WaitId } from '@lingtai/domain'
import { aWaitId } from '@lingtai/domain/test/events'
import type { WaitReason } from '@lingtai/domain/wait'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  submit: vi.fn(async () => ({ ok: true, detail: 'back in the queue' })),
  answer: vi.fn(async () => ({ ok: true, detail: 'answered' })),
  conclude: vi.fn(async () => ({ ok: true, detail: 'concluded' })),
  /** What `useContext` answers: the provider's value, as the last `mount` rendered it. */
  triage: null as unknown,
}))

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = harness.cursor++
      if (!(index in harness.values)) harness.values[index] = initial
      return [
        harness.values[index],
        (value: unknown) =>
          (harness.values[index] =
            typeof value === 'function' ? (value as (current: unknown) => unknown)(harness.values[index]) : value),
      ]
    },
    useContext: () => harness.triage,
    useTransition: () => [false, (work: () => void) => work()],
  }
})

vi.mock('../src/app/actions.ts', () => ({
  editBodyAndRequeueCard: harness.submit,
  answerCard: harness.answer,
  concludeChat: harness.conclude,
}))

import { EditBodyAndRequeue, Requeue } from '../src/app/decide.tsx'
import { TriagePicks, appendTo, draftTarget } from '../src/app/triage-picks.tsx'

type Tag = string | null
type By = { none: Tag; judge: Tag; triage: Tag }
const question = (text: string, picked: string) => ({
  id: text,
  text,
  recommended: picked,
  answers: [
    { id: 'A', text: 'A' },
    { id: 'B', text: 'B' },
  ],
})

/**
 * Renders the provider and then a component under it, the way a page does: the
 * provider's own state is the harness's too, so what an add writes is what the
 * component reads next time. The provider is called as a function and its
 * context value taken from the element it returns.
 */
function mount<T>(
  waitId: WaitId | null,
  component: () => T,
  { by = { none: null, judge: null, triage: null } as By, questions = [] as ReturnType<typeof question>[] } = {},
): T {
  harness.cursor = 0
  const provider = TriagePicks({ waitId, questions, recommendedBy: by, children: null }) as ReactElement<{
    value: unknown
  }>
  harness.triage = provider.props.value
  return component()
}

const editor = (waitId: WaitId | null, reason: WaitReason | null = null) =>
  EditBodyAndRequeue({ project: 'lingtai', issue: 112, waitId, reason })

type ControlProps = {
  children?: ReactNode
  disabled?: boolean
  placeholder?: string
  value?: string
  onClick?: () => void
  onChange?: (event: { target: { value: string } }) => void
}

function findControl(node: ReactNode, type: string): ReactElement<ControlProps> | null {
  let found: ReactElement<ControlProps> | null = null
  Children.forEach(node, (child) => {
    if (!isValidElement(child) || found) return
    if (child.type === type) found = child as ReactElement<ControlProps>
    else found = findControl((child.props as { children?: ReactNode }).children, type)
  })
  return found
}

function control(node: ReactNode, type: string): ReactElement<ControlProps> {
  const found = findControl(node, type)
  if (!found) throw new Error(`no ${type} rendered`)
  return found
}

it('can submit a new answer after a successful wait while the editor stays mounted', async () => {
  harness.values = []
  harness.submit.mockClear()
  const first = aWaitId()
  const next = aWaitId()
  const render = (waitId: WaitId | null) => {
    return mount(waitId, () => editor(waitId))
  }

  control(render(first), 'textarea').props.onChange?.({ target: { value: 'First answer' } })
  control(render(first), 'button').props.onClick?.()
  await vi.waitFor(() => expect(harness.values[4]).toBe(first))
  expect(harness.submit).toHaveBeenCalledTimes(1)
  expect(control(render(first), 'button').props.disabled).toBe(true)

  render(null)
  control(render(next), 'textarea').props.onChange?.({ target: { value: 'Second answer' } })
  expect(control(render(next), 'button').props.disabled).toBe(false)
  control(render(next), 'button').props.onClick?.()
  await vi.waitFor(() => expect(harness.values[4]).toBe(next))
  expect(harness.submit).toHaveBeenCalledTimes(2)
  expect(harness.submit).toHaveBeenLastCalledWith({
    project: 'lingtai',
    issue: 112,
    waitId: next,
    text: 'Second answer',
  })
})

it('keeps an unsent answer visible but unsendable after another person ends the wait', () => {
  harness.values = []
  const waitId = aWaitId()
  const render = (currentWaitId: WaitId | null) => {
    return mount(currentWaitId, () => editor(currentWaitId))
  }

  control(render(waitId), 'textarea').props.onChange?.({ target: { value: 'My unsent answer' } })
  const afterMove = render(null)
  expect(control(afterMove, 'textarea').props.value).toBe('My unsent answer')
  expect(() => control(afterMove, 'button')).toThrow()
  expect(renderToStaticMarkup(afterMove)).toContain('Your unsent draft is below; copy it before leaving.')
})

it('does not call a submitted answer an unsent draft after Follow ends the wait', async () => {
  harness.values = []
  harness.submit.mockClear()
  const waitId = aWaitId()
  const render = (currentWaitId: WaitId | null) => {
    return mount(currentWaitId, () => editor(currentWaitId))
  }

  control(render(waitId), 'textarea').props.onChange?.({ target: { value: 'My submitted answer' } })
  control(render(waitId), 'button').props.onClick?.()
  await vi.waitFor(() => expect(harness.values[4]).toBe(waitId))

  const afterFollow = render(null)
  expect(control(afterFollow, 'textarea').props.value).toBe('My submitted answer')
  expect(renderToStaticMarkup(afterFollow)).toContain('back in the queue')
  expect(renderToStaticMarkup(afterFollow)).not.toContain('Your unsent draft is below')
})

it('follows triage picks until a manual edit, then resets the draft on the next wait', async () => {
  harness.values = []
  harness.submit.mockClear()
  const first = aWaitId()
  const next = aWaitId()
  const render = (waitId: WaitId, picked: string, text = 'Which?') =>
    mount(waitId, () => editor(waitId), { questions: [question(text, picked)] })
  const pick = (answerId: string) =>
    (harness.triage as { pick: (index: number, answerId: string) => void }).pick(0, answerId)

  expect(control(render(first, 'A'), 'textarea').props.value).toBe('Which? — A')
  pick('B')
  expect(control(render(first, 'A'), 'textarea').props.value).toBe('Which? — B')
  control(render(first, 'A'), 'textarea').props.onChange?.({ target: { value: 'My own answer' } })
  pick('A')
  expect(control(render(first, 'A'), 'textarea').props.value).toBe('My own answer')
  control(render(first, 'A'), 'button').props.onClick?.()
  await vi.waitFor(() =>
    expect(harness.submit).toHaveBeenCalledWith({
      project: 'lingtai',
      issue: 112,
      waitId: first,
      text: 'My own answer',
    }),
  )

  expect(control(render(next, 'A', 'Where?'), 'textarea').props.value).toBe('Where? — A')
})

const writesNothing = () => {
  expect(harness.submit).not.toHaveBeenCalled()
  expect(harness.answer).not.toHaveBeenCalled()
  expect(harness.conclude).not.toHaveBeenCalled()
}
const resetAdd = () => {
  harness.values = []
  harness.submit.mockClear()
  harness.answer.mockClear()
  harness.conclude.mockClear()
}
const addToDraft = (text: string) => (harness.triage as { add: (text: string) => void }).add(text)
const body: By = { none: 'EditBodyAndRequeue', judge: null, triage: null }
const asked: By = { none: 'AnswerQuestion', judge: null, triage: null }

it('adds a discussion answer under the picks, writes nothing, and stops following the picks', () => {
  resetAdd()
  const waitId = aWaitId()
  const render = (picked: string) =>
    mount(waitId, () => editor(waitId), { by: body, questions: [question('Which?', picked)] })
  const pick = (answerId: string) =>
    (harness.triage as { pick: (index: number, answerId: string) => void }).pick(0, answerId)

  expect(control(render('A'), 'textarea').props.value).toBe('Which? — A')
  addToDraft('Because the lock is held.')
  expect(control(render('A'), 'textarea').props.value).toBe('Which? — A\n\nBecause the lock is held.')
  pick('B')
  expect(control(render('A'), 'textarea').props.value).toBe('Which? — A\n\nBecause the lock is held.')
  addToDraft('And a second thing.')
  expect(control(render('A'), 'textarea').props.value).toBe(
    'Which? — A\n\nBecause the lock is held.\n\nAnd a second thing.',
  )
  writesNothing()
})

it('adds a discussion answer into an empty body draft as the draft itself', () => {
  resetAdd()
  const waitId = aWaitId()
  const render = () => mount(waitId, () => editor(waitId), { by: body })
  expect(control(render(), 'textarea').props.value).toBe('')
  addToDraft('Reasoned in Discussion.')
  expect(control(render(), 'textarea').props.value).toBe('Reasoned in Discussion.')
  writesNothing()
})

it('adds a discussion answer to the answer box, opening it, and the person still sends it', async () => {
  resetAdd()
  const waitId = aWaitId()
  const render = () =>
    mount(waitId, () => Requeue({ project: 'lingtai', issue: 112, waitId, asked: true, question: 'Which helper?' }), {
      by: asked,
    })
  expect(findControl(render(), 'textarea')).toBeNull()
  addToDraft('Use the first helper.')
  const open = render()
  expect(control(open, 'textarea').props.value).toBe('Use the first helper.')
  expect(findControl(open, 'input')).toBeNull()
  writesNothing()

  addToDraft('It is already tested.')
  expect(control(render(), 'textarea').props.value).toBe('Use the first helper.\n\nIt is already tested.')
  writesNothing()

  control(render(), 'button').props.onClick?.()
  await vi.waitFor(() =>
    expect(harness.answer).toHaveBeenCalledWith({
      project: 'lingtai',
      issue: 112,
      answer: 'Use the first helper.\n\nIt is already tested.',
      question: 'Which helper?',
      waitId,
    }),
  )
})

it('does not add when no text-writing resolution is the one drawn first', () => {
  resetAdd()
  const waitId = aWaitId()
  const none: By = { none: 'Close', judge: 'EditBodyAndRequeue', triage: null }
  const render = () => mount(waitId, () => editor(waitId), { by: none })
  render()
  expect((harness.triage as { target: unknown }).target).toBeNull()
  addToDraft('Ignored.')
  expect(control(render(), 'textarea').props.value).toBe('')
  writesNothing()
})

it('appends under what is there, after a blank line, and names the target by reading', () => {
  expect(appendTo('', 'a')).toBe('a')
  expect(appendTo('  \n', 'a')).toBe('a')
  expect(appendTo('x', 'a')).toBe('x\n\na')
  const by = { none: null, judge: 'AnswerQuestion', triage: 'EditBodyAndRequeue' }
  expect(draftTarget(by, null)).toBeNull()
  expect(draftTarget(by, 'judge')).toBe('AnswerQuestion')
  expect(draftTarget(by, 'triage')).toBe('EditBodyAndRequeue')
  expect(draftTarget({ none: 'Close', judge: 'Approve', triage: 'Split' }, 'judge')).toBeNull()
})

it.each([
  [
    'AgentQuestion',
    { _tag: 'AgentQuestion', run: { runId: 'pass-1' }, step: 'implement', question: 'which helper?' },
    'which helper?',
  ],
  [
    'ProposedEscalated{InputNeeded}',
    {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-2' },
      proposal: { _tag: 'InputNeeded', from: 'design', question: 'which design?' },
      because: { _tag: 'NotAsked' },
    },
    'which design?',
  ],
] as const)(
  '%s presents the step question and sends its answer with the page wait ID',
  async (_name, reason, question) => {
    harness.values = []
    harness.submit.mockClear()
    const waitId = aWaitId()
    const render = () => {
      return mount(waitId, () => editor(waitId, reason as WaitReason))
    }

    const html = renderToStaticMarkup(render())
    expect(html).toContain(`<p>${question}</p>`)
    expect(html).toContain('Your answer')
    expect(html).toContain('>Answer</button>')
    expect(control(render(), 'textarea').props.placeholder).toBe('every attempt at this ticket is told this')

    control(render(), 'textarea').props.onChange?.({ target: { value: 'Use the first option' } })
    control(render(), 'button').props.onClick?.()
    await vi.waitFor(() =>
      expect(harness.submit).toHaveBeenCalledWith({
        project: 'lingtai',
        issue: 112,
        waitId,
        text: 'Use the first option',
      }),
    )
  },
)

it('keeps the body-writing label for FixerDisagrees', () => {
  harness.values = []
  harness.cursor = 0
  harness.triage = null
  const html = renderToStaticMarkup(
    EditBodyAndRequeue({
      project: 'lingtai',
      issue: 112,
      waitId: aWaitId(),
      reason: { _tag: 'FixerDisagrees', run: { runId: 'pass-3' }, said: 'no change needed' },
    }),
  )
  expect(html).toContain('Text to add to the ticket body')
  expect(html).toContain('Write it into the body &amp; requeue')
  expect(html).not.toContain('Your answer')
})
