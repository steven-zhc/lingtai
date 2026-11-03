/**
 * `reduceChat` (D7, D14): one fold of a `chat-` stream, read by the board, the
 * conductor's brief and the CLI's loop.
 */
import { describe, expect, it } from 'vitest'

import { reduceChat } from '../src/index.ts'
import { histories, lateHistories } from '../test/histories.ts'

describe('reduceChat', () => {
  it('pairs each ask with the answer that followed it', () => {
    const chat = reduceChat(histories.chat.askedThenAnswered!)
    expect(chat.turns).toHaveLength(1)
    expect(chat.turns[0]!.answer?.text).toBe('because the other leaks')
    expect(chat.answered).toBe(1)
    expect(chat.attempt).toBe(1)
  })

  it('keeps an ask with nothing after it, unanswered', () => {
    const events = histories.chat.askedThenAnswered!.slice(0, 1)
    const chat = reduceChat(events)
    expect(chat.turns.map((t) => t.answer)).toEqual([null])
    expect(chat.answered).toBe(0)
  })

  it('D14: an answer with no open ask counts for nothing', () => {
    const chat = reduceChat(histories.chat.orphanAnswer!)
    expect(chat.turns).toEqual([])
    expect(chat.answered).toBe(0)
  })

  it('D14: a retried request leaves the first ask unanswered and counts one answer', () => {
    const chat = reduceChat(lateHistories.chat.retriedRequest)
    expect(chat.turns).toHaveLength(2)
    expect(chat.turns[0]!.answer).toBeNull()
    expect(chat.turns[1]!.answer).not.toBeNull()
    expect(chat.answered).toBe(1)
  })

  it('D14: an answer belongs to the latest unanswered ask before it', () => {
    const chat = reduceChat(lateHistories.chat.twoAsksTwoAnswers)
    expect(chat.turns.map((t) => t.answer?.text)).toEqual(['because the other leaks', 'second answer'].reverse())
    expect(chat.answered).toBe(2)
  })

  it('a RunSpent on the stream changes nothing', () => {
    const events = histories.chat.askedThenAnswered!
    const spent = { ...events[0]!, type: 'RunSpent', data: { costUsd: 1 } }
    expect(reduceChat([events[0]!, spent, events[1]!])).toEqual(reduceChat(events))
  })
})
