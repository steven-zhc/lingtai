/**
 * `upsertSection` (`#446`): pure, so every case here is a plain call and an
 * assertion on the string that comes back.
 */
import { describe, expect, it } from 'vitest'

import { ANSWER_CLOSE_MARKER, answerOpenMarker, upsertSection } from '../src/body-section.ts'

describe('upsertSection', () => {
  it('appends a section when the key is absent, to a body that already has text', () => {
    const body = 'the ticket as a person wrote it.'
    const result = upsertSection(body, 'w-1@review', 'the answer')

    expect(result).toBe(
      `the ticket as a person wrote it.\n\n${answerOpenMarker('w-1@review')}\n\nthe answer\n\n${ANSWER_CLOSE_MARKER}\n`,
    )
  })

  it('appends with no leading blank body when the body is empty', () => {
    const result = upsertSection('', 'chat-1', 'the answer')

    expect(result).toBe(`${answerOpenMarker('chat-1')}\n\nthe answer\n\n${ANSWER_CLOSE_MARKER}\n`)
  })

  /**
   * The empty-body branch above starts the section's open marker at index 0.
   * `lastIndexOf(prefix, -1)` clamps to `0` and finds that same open marker as
   * its own "preceding" one, so without the `openIdx === 0` guard the section
   * is reported nested in itself, skipped, and a second write appends a
   * duplicate instead of replacing — stranding the first pair forever (#446).
   */
  it('replaces a section that starts the body instead of appending a second', () => {
    const once = upsertSection('', 'chat-1', 'the first answer')
    const twice = upsertSection(once, 'chat-1', 'the second answer')

    expect(twice.split(answerOpenMarker('chat-1'))).toHaveLength(2)
    expect(twice).toContain('the second answer')
    expect(twice).not.toContain('the first answer')
  })

  it('replaces a section that is the whole trimmed body, as a tracker returns after trimming', () => {
    const once = upsertSection('', 'chat-1', 'the first answer').trim()
    const twice = upsertSection(once, 'chat-1', 'the second answer')

    expect(twice.split(answerOpenMarker('chat-1'))).toHaveLength(2)
    expect(twice).toContain('the second answer')
    expect(twice).not.toContain('the first answer')
  })

  it('returns the input string unchanged when the same text is already there', () => {
    const once = upsertSection('the ticket.', 'w-1@review', 'the answer')
    const twice = upsertSection(once, 'w-1@review', 'the answer')

    expect(twice).toBe(once)
  })

  it('treats surrounding whitespace as insignificant when deciding "same text"', () => {
    const once = upsertSection('the ticket.', 'w-1@review', '  the answer  ')
    const twice = upsertSection(once, 'w-1@review', 'the answer')

    expect(twice).toBe(once)
  })

  it('replaces the section in place with different text, never doubling it', () => {
    const once = upsertSection('the ticket.', 'w-1@review', 'the first answer')
    const twice = upsertSection(once, 'w-1@review', 'the second answer')

    expect(twice).toBe(
      `the ticket.\n\n${answerOpenMarker('w-1@review')}\n\nthe second answer\n\n${ANSWER_CLOSE_MARKER}\n`,
    )
    expect(twice.split(answerOpenMarker('w-1@review'))).toHaveLength(2)
  })

  it('keeps text before and after the section byte for byte when replacing', () => {
    const before = `the ticket.\n\n${answerOpenMarker('w-1@review')}\n\nold answer\n\n${ANSWER_CLOSE_MARKER}\n\na person's own note below.`
    const after = upsertSection(before, 'w-1@review', 'new answer')

    expect(after).toBe(
      `the ticket.\n\n${answerOpenMarker('w-1@review')}\n\nnew answer\n\n${ANSWER_CLOSE_MARKER}\n\na person's own note below.`,
    )
  })

  it('keeps two keys as two sections', () => {
    const withFirst = upsertSection('the ticket.', 'w-1@review', 'review answer')
    const withBoth = upsertSection(withFirst, 'chat-9', 'chat answer')

    expect(withBoth).toContain(answerOpenMarker('w-1@review'))
    expect(withBoth).toContain('review answer')
    expect(withBoth).toContain(answerOpenMarker('chat-9'))
    expect(withBoth).toContain('chat answer')
    expect(withBoth.split(ANSWER_CLOSE_MARKER)).toHaveLength(3)
  })

  it('a key that is another key’s prefix does not match the longer one’s marker', () => {
    const withLonger = upsertSection('the ticket.', 'w-1@reviewer', 'the long one')
    const withBoth = upsertSection(withLonger, 'w-1@review', 'the short one')

    expect(withBoth).toContain(answerOpenMarker('w-1@reviewer'))
    expect(withBoth).toContain('the long one')
    expect(withBoth).toContain(answerOpenMarker('w-1@review'))
    expect(withBoth).toContain('the short one')
  })

  it('refuses a key containing "-->", which would close its own marker early', () => {
    expect(() => upsertSection('the ticket.', 'w-1@review-->', 'x')).toThrow(/-->/)
  })

  it('refuses a key containing a newline', () => {
    expect(() => upsertSection('the ticket.', 'w-1\n@review', 'x')).toThrow(/newline/)
  })

  /**
   * Without this, a retry with identical arguments reads the embedded close
   * as *the* section end, decides the text differs from what it finds before
   * that embedded marker, and splices — growing the body on every retry
   * rather than returning it unchanged.
   */
  it('refuses text containing the close marker, rather than growing the body on every retry', () => {
    const text = 'the close marker is `<!-- /lingtai:answer -->` and it ends the section'
    expect(() => upsertSection('Problem.', 'w-1@review', text)).toThrow(/lingtai:answer/)
  })

  /**
   * Without this, writing `w-1@build` after `w-1@review`'s section embeds an
   * open marker places `w-1@build`'s section *inside* `w-1@review`'s span, so
   * a later rewrite of `w-1@review` deletes `w-1@build`'s answer along with
   * it.
   */
  it('refuses text containing another key’s open marker, rather than letting it nest inside this section', () => {
    const text = 'quoting the build answer: <!-- lingtai:answer w-1@build -->'
    expect(() => upsertSection('Problem.', 'w-1@review', text)).toThrow(/lingtai:answer/)
  })

  it('refuses an open marker with no close marker, rather than appending a second copy or eating the rest of the body', () => {
    const body = `the ticket.\n\n${answerOpenMarker('w-1@review')}\n\nan answer with no close marker after it`
    expect(() => upsertSection(body, 'w-1@review', 'x')).toThrow(/no matching close marker/)
  })

  it('allows text with a bare "-->" that is not a lingtai:answer marker', () => {
    const result = upsertSection('Problem.', 'w-1@review', 'rename A --> B, then requeue')
    expect(result).toContain('rename A --> B, then requeue')
  })

  /**
   * A person quoting or hand-pasting an open marker above a real, well-formed
   * pair leaves the key's own open unpaired: the first close `indexOf` finds
   * after it is actually some *other* section's close, because that other
   * section's own open sits in between. Treating that close as this key's own
   * would delete everything from the stray open through that other section —
   * here, `Problem.` and the whole `w-1@build` answer (#446's finding 1).
   */
  it('refuses a stray open marker for the key that precedes another section entirely, rather than splicing across it', () => {
    const wellFormed = upsertSection(
      upsertSection('Problem.', 'w-1@build', 'the build answer, which must survive'),
      'w-1@review',
      'the review answer',
    )
    const mangled = `quoting the marker: ${answerOpenMarker('w-1@review')}\n\n${wellFormed}`

    expect(() => upsertSection(mangled, 'w-1@review', 'a new review answer')).toThrow(/no matching close marker/)
  })

  /**
   * A stray open marker for `K` pasted *inside* `J`'s own well-formed
   * section is not `J`'s open marker, but the close that follows it still
   * belongs to `J`'s section, not to `K`'s. Treating that close as `K`'s own
   * would delete the rest of `J`'s text, consume `J`'s close marker (so a
   * later rewrite of `J` throws), and leave `K`'s real section behind as a
   * stale duplicate (#446's finding 1).
   */
  it('skips a stray open marker for the key nested inside another section, and finds the real one', () => {
    const wellFormed = upsertSection(
      upsertSection('Problem.', 'w-1@build', 'the build answer'),
      'w-1@review',
      'the review answer',
    )
    const mangled = wellFormed.replace('the build answer', `the build answer ${answerOpenMarker('w-1@review')} oops`)

    const result = upsertSection(mangled, 'w-1@review', 'a new review answer')

    expect(result).toContain(`the build answer ${answerOpenMarker('w-1@review')} oops`)
    expect(result).toContain('a new review answer')
    expect(result).not.toContain('the review answer\n')
    expect(result.split(ANSWER_CLOSE_MARKER)).toHaveLength(3)
  })

  it('replaces only the first of two hand-pasted open markers for one key, leaving the second alone', () => {
    const body =
      `the ticket.\n\n${answerOpenMarker('w-1@review')}\n\nfirst\n\n${ANSWER_CLOSE_MARKER}\n\n` +
      `${answerOpenMarker('w-1@review')}\n\nsecond\n\n${ANSWER_CLOSE_MARKER}\n`
    const result = upsertSection(body, 'w-1@review', 'replaced')

    expect(result).toContain('replaced')
    expect(result).not.toContain('first')
    expect(result).toContain('second')
    expect(result.split(answerOpenMarker('w-1@review'))).toHaveLength(3)
  })
})
