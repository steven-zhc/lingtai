import type { WaitId } from '@lingtai/domain'
import { aWaitId } from '@lingtai/domain/test/events'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  submit: vi.fn(async () => ({ ok: true, detail: 'back in the queue' })),
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
    useTransition: () => [false, (work: () => void) => work()],
  }
})

vi.mock('../src/app/actions.ts', () => ({ editBodyAndRequeueCard: harness.submit }))

import { EditBodyAndRequeue } from '../src/app/decide.tsx'

type ControlProps = {
  children?: ReactNode
  disabled?: boolean
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
    return EditBodyAndRequeue({ project: 'lingtai', issue: 112, waitId })
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
