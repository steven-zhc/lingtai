import { fromPromiseStore } from '../src/store-face.ts'
/** `Events` over the in-memory store, held to the Effect contract (#1020). */
import { describeEventsContract } from '../test/events-contract.ts'
import { createMemoryEventStore } from '../test/memory.ts'

let n = 0
describeEventsContract(
  'in memory',
  () => fromPromiseStore(createMemoryEventStore()),
  () => `ticket-evmem-${n++}`,
)
