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
  triage: null as null | { waitId: WaitId; text: string; note: string },
}))

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = harness.cursor++
      if (!(index in harness.values)) harness.values[index] = initial
      return [harness.values[index], (value: unknown) => (harness.values[index] = value)]
    },
    useContext: () => harness.triage,
    useTransition: () => [false, (work: () => void) => work()],
  }
})

vi.mock('../src/app/actions.ts', () => ({ editBodyAndRequeueCard: harness.submit }))

import { EditBodyAndRequeue } from '../src/app/decide.tsx'

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
    harness.cursor = 0
    return EditBodyAndRequeue({ project: 'lingtai', issue: 112, waitId, reason: null })
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

it('follows triage picks until a manual edit, then resets the draft on the next wait', async () => {
  harness.values = []
  harness.submit.mockClear()
  const first = aWaitId()
  const next = aWaitId()
  harness.triage = { waitId: first, text: 'Which? — A', note: 'Triage answers:\nWhich? — A' }
  const render = (waitId: WaitId) => {
    harness.cursor = 0
    return EditBodyAndRequeue({ project: 'lingtai', issue: 112, waitId, reason: null })
  }

  expect(control(render(first), 'textarea').props.value).toBe('Which? — A')
  harness.triage = { waitId: first, text: 'Which? — B', note: 'Triage answers:\nWhich? — B' }
  expect(control(render(first), 'textarea').props.value).toBe('Which? — B')
  control(render(first), 'textarea').props.onChange?.({ target: { value: 'My own answer' } })
  harness.triage = { waitId: first, text: 'Which? — A', note: 'Triage answers:\nWhich? — A' }
  expect(control(render(first), 'textarea').props.value).toBe('My own answer')
  control(render(first), 'button').props.onClick?.()
  await vi.waitFor(() =>
    expect(harness.submit).toHaveBeenCalledWith({
      project: 'lingtai',
      issue: 112,
      waitId: first,
      text: 'My own answer',
      note: 'Triage answers:\nWhich? — A',
    }),
  )

  harness.triage = { waitId: next, text: 'Where? — Here', note: 'Triage answers:\nWhere? — Here' }
  expect(control(render(next), 'textarea').props.value).toBe('Where? — Here')
  harness.triage = null
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
      harness.cursor = 0
      return EditBodyAndRequeue({ project: 'lingtai', issue: 112, waitId, reason: reason as WaitReason })
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
