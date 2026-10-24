import { describe, expect, it } from 'vitest'

import { hunkTextsOf } from '../src/hunk-text.ts'

describe('hunkTextsOf', () => {
  const file = ['a', '<<<<<<< ours', 'x', '=======', 'y', '>>>>>>> theirs', 'b', '<<<<<<< ours', 'p', '>>>>>>> theirs'].join('\n')

  it('returns one marker-to-marker block per conflict, in file order', () => {
    expect(hunkTextsOf(file)).toEqual([
      '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs',
      '<<<<<<< ours\np\n>>>>>>> theirs',
    ])
  })

  it('bounds a long hunk and says how much was cut', () => {
    const long = ['<<<<<<< ours', ...Array.from({ length: 10 }, (_, i) => `l${i}`), '>>>>>>> theirs'].join('\n')
    const [text] = hunkTextsOf(long, 4)
    expect(text!.split('\n')).toHaveLength(5)
    expect(text).toMatch(/\[9 more lines not shown\]$/)
  })

  it('runs an unclosed marker to the end of the file and finds none without markers', () => {
    expect(hunkTextsOf('<<<<<<< ours\nx')).toEqual(['<<<<<<< ours\nx'])
    expect(hunkTextsOf('plain')).toEqual([])
  })
})
