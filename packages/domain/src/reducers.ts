/** The reducers that may be snapshotted (0124 §1, #867). A reducer is registered by adding a line. */
import { controlReducer } from './control.ts'

export const REDUCERS = { control: controlReducer } as const
