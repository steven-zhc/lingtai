import type { TaskCard } from '@lingtai/projector/task-view'
import { describe, expect, it } from 'vitest'

import { waitingNeighbours } from '../src/lib/board.ts'

const card = (project: string, issue: string, state: string, updatedAt: number): TaskCard =>
  ({
    taskId: `ticket-${project}-${issue}`,
    project,
    issue,
    title: `title ${issue}`,
    state,
    updatedAt,
  }) as unknown as TaskCard

// The order `readTasks` returns: project first, then longest-waiting first.
// `updatedAt` deliberately disagrees with it, so a re-sort would fail here.
const CARDS = [
  card('a', '1', 'waiting', 90),
  card('a', '2', 'running', 5),
  card('a', '3', 'waiting', 10),
  card('b', '4', 'approved', 1),
  card('b', '5', 'waiting', 50),
  card('b', '6', 'landed', 2),
  card('b', '7', 'waiting', 20),
]
const n = (issue: string) => expect.objectContaining({ issue })

describe('waitingNeighbours', () => {
  it('first has no previous', () => {
    expect(waitingNeighbours(CARDS, 'ticket-a-1')).toEqual({ previous: null, next: n('3') })
  })
  it('crosses a project boundary in the board order', () => {
    expect(waitingNeighbours(CARDS, 'ticket-a-3')).toEqual({ previous: n('1'), next: n('5') })
  })
  it('last has no next, and approved is not in the lane', () => {
    expect(waitingNeighbours(CARDS, 'ticket-b-7')).toEqual({ previous: n('5'), next: null })
  })
  it('a ticket that left the lane has no previous and the first wait as next', () => {
    expect(waitingNeighbours(CARDS, 'ticket-b-6')).toEqual({ previous: null, next: n('1') })
  })
  it('an empty lane has nothing', () => {
    expect(waitingNeighbours([CARDS[1]!], 'ticket-a-2')).toEqual({ previous: null, next: null })
  })
})
