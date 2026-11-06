import { describe, expect, it } from 'vitest'

import { SHOTS } from '@/app/shots'
import { imageType } from '@/lib/doc-images'

describe('imageType', () => {
  it('accepts a diagram and a screenshot', () => {
    expect(imageType('a.svg')).toBe('image/svg+xml; charset=utf-8')
    expect(imageType('shot-board-full.png')).toBe('image/png')
  })

  it('refuses anything else', () => {
    for (const name of ['a.gif', '../a.png', 'a/b.png', 'A.png', 'a.png.svg/', 'a.png.gif', '.png']) {
      expect(imageType(name), name).toBeNull()
    }
  })

  it('serves every file name the shots component asks for', () => {
    for (const s of SHOTS) {
      expect(imageType(`shot-${s.name}.png`)).toBe('image/png')
      expect(imageType(`shot-${s.name}-full.png`)).toBe('image/png')
    }
  })
})
