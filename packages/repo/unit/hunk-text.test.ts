import { describe, expect, it } from 'vitest'

import { hunkTextsOf } from '../src/hunk-text.ts'

describe('hunkTextsOf', () => {
  const file = [
    'a',
    '<<<<<<< ours',
    'x',
    '=======',
    'y',
    '>>>>>>> theirs',
    'b',
    '<<<<<<< ours',
    'p',
    '>>>>>>> theirs',
  ].join('\n')

  it('returns one marker-to-marker block per conflict, in file order', () => {
    expect(hunkTextsOf(file)).toEqual([
      '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs',
      '<<<<<<< ours\np\n>>>>>>> theirs',
    ])
  })

  it('keeps both sides of a long hunk whole', () => {
    const first = Array.from({ length: 100 }, (_, i) => `l${i}`)
    const long = ['<<<<<<< ours', ...first, '=======', 'other', '>>>>>>> theirs'].join('\n')
    const [text] = hunkTextsOf(long)
    expect(text!.split('\n')).toHaveLength(104)
    expect(text).toContain('=======\nother\n>>>>>>> theirs')
  })

  it('runs an unclosed marker to the end of the file and finds none without markers', () => {
    expect(hunkTextsOf('<<<<<<< ours\nx')).toEqual(['<<<<<<< ours\nx'])
    expect(hunkTextsOf('plain')).toEqual([])
  })
})
