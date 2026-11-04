/**
 * One discussion, reduced: the `chat-<id>` stream's turns and how many of them
 * have an answer (D7, D14).
 *
 * Every reader — the board's panel, the conductor's brief, the CLI's loop —
 * takes its turns and its answered count from here, so there is one answer to
 * "has this question been answered".
 */
import type { Envelope } from './envelope.ts'
import type { PayloadOf } from './events.ts'

export interface ChatTurn {
  readonly question: string
  readonly by: string
  readonly at: Date
  readonly reading: readonly string[]
  readonly answer: PayloadOf<'DiscussionAnswered'> | null
}

export interface ChatState {
  /** The last numeric `attempt` an ask named, or null. */
  readonly attempt: number | null
  readonly turns: readonly ChatTurn[]
  /** How many turns have an answer. An answer with no open ask is not one. */
  readonly answered: number
}

export const emptyChat: ChatState = { attempt: null, turns: [], answered: 0 }

/**
 * One event reduced into the state. Pure, reads no clock, never throws (D14).
 *
 * An answer belongs to the latest unanswered ask before it; with none, it
 * counts for nothing.
 */
export function reduceChatEvent(state: ChatState, e: Envelope): ChatState {
  switch (e.type) {
    case 'DiscussionAsked': {
      const d = e.data as PayloadOf<'DiscussionAsked'>
      const turn: ChatTurn = {
        question: d.question,
        by: d.by,
        at: e.at,
        reading: d.reading,
        answer: null,
      }
      return {
        ...state,
        attempt: typeof d.attempt === 'number' ? d.attempt : state.attempt,
        turns: [...state.turns, turn],
      }
    }
    case 'DiscussionAnswered': {
      let open = -1
      for (let i = state.turns.length - 1; i >= 0; i--) {
        if (state.turns[i]!.answer === null) {
          open = i
          break
        }
      }
      if (open === -1) return state
      const answer = e.data as PayloadOf<'DiscussionAnswered'>
      return {
        ...state,
        turns: state.turns.map((t, i) => (i === open ? { ...t, answer } : t)),
        answered: state.answered + 1,
      }
    }
    default:
      return state
  }
}

export function reduceChat(events: readonly Envelope[]): ChatState {
  return events.reduce(reduceChatEvent, emptyChat)
}
