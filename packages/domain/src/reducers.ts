/** The reducers that may be snapshotted (0124 §1, #867). A reducer is registered by adding a line. */
import { controlReducer } from './control.ts'
import { attemptReducer } from './run-codec.ts'
import { ticketReducer } from './ticket-codec.ts'

export const REDUCERS = { control: controlReducer, ticket: ticketReducer, attempt: attemptReducer } as const
