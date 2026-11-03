/**
 * `nextRequest` is the CLI's stop rule (D14): requests are counted against
 * answered turns, never "some turn has no answer".
 */
import { reduceChat, type DiscussionRequest } from '@lingtai/domain'
import { histories, lateHistories } from '@lingtai/domain/test/histories'
import { describe, expect, it } from 'vitest'

import { nextRequest } from '../src/discuss.ts'

const ask = (n: number): DiscussionRequest => ({
  chatId: '9001-1',
  ticketId: 't',
  attempt: 1,
  question: `q${n}`,
  by: 'steven',
})

describe('nextRequest', () => {
  it('gives the request when the only answer on the stream has no open ask', () => {
    const asks = [ask(1)]
    expect(nextRequest(asks, reduceChat(histories.chat.orphanAnswer!))).toBe(asks[0])
  })

  it('gives null once the request is answered', () => {
    expect(nextRequest([ask(1)], reduceChat(histories.chat.askedThenAnswered!))).toBeNull()
  })

  it('gives null for a retried request: two asks, one answer, one request', () => {
    expect(nextRequest([ask(1)], reduceChat(lateHistories.chat.retriedRequest))).toBeNull()
  })

  it('counts requests against answered turns: a second request is still owed', () => {
    const asks = [ask(1), ask(2)]
    expect(nextRequest(asks, reduceChat(lateHistories.chat.retriedRequest))).toBe(asks[1])
  })
})
