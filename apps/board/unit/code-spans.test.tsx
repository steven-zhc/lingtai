import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { codeSpans } from '../src/app/code-spans.tsx'

const html = (text: string) => renderToStaticMarkup(<p>{codeSpans(text)}</p>)

describe('codeSpans', () => {
  it('sets a matched pair as code and drops its backticks', () => {
    expect(html('the `proposed` step held: x')).toBe('<p>the <code>proposed</code> step held: x</p>')
  })

  it('leaves an unmatched backtick as a character', () => {
    expect(html('a `b` c `d')).toBe('<p>a <code>b</code> c `d</p>')
  })

  it('leaves an empty pair as two characters', () => {
    expect(html('a `` b')).toBe('<p>a `` b</p>')
  })

  it('returns one string when there are no backticks, and interprets nothing else', () => {
    expect(codeSpans('plain _text_ # {x}')).toEqual(['plain _text_ # {x}'])
    expect(html('<b>&')).toBe('<p>&lt;b&gt;&amp;</p>')
  })
})
