import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Document } from '../src/app/docs/document'
import { docImageSrc } from '../src/lib/docs'

describe('a document image', () => {
  it('takes its src from docImageSrc, whether or not the file is on disk (#1470)', () => {
    const body = '![site](img/tutorial-site.png)\n\n![diagram](img/recipe.svg)'
    const html = renderToStaticMarkup(<Document slug="tutorial" source="tutorial.md" body={body} published={[]} />)
    expect(html).toContain(`src="${docImageSrc('img/tutorial-site.png')}"`)
    expect(html).toContain('src="/img/docs/recipe.svg"')
    const ext = renderToStaticMarkup(
      <Document slug="tutorial" source="tutorial.md" body="![e](//cdn.example.com/picture.png)" published={[]} />,
    )
    expect(ext).toContain('src="//cdn.example.com/picture.png"')
  })
})
