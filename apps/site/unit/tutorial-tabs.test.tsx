import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Document } from '../src/app/docs/document'

describe('tutorial shell examples', () => {
  it('offers one selectable group on the site while preserving each command', () => {
    const body = `**POSIX shell (bash, zsh)**

\`\`\`sh
echo posix
\`\`\`

**Fish**

\`\`\`fish
echo fish
\`\`\``
    const html = renderToStaticMarkup(<Document slug="tutorial" source="tutorial.md" body={body} published={[]} />)

    expect(html).toContain('type="radio"')
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="posix"/)
    expect(html).toContain('value="fish"')
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).toContain('echo posix')
    expect(text).toContain('echo fish')
    expect(html).not.toContain('<p><strong>POSIX shell (bash, zsh)</strong></p>')
  })

  it('groups both shell examples in the published tutorial', () => {
    const body = readFileSync(new URL('../../../doc/tutorial.md', import.meta.url), 'utf8')
    const html = renderToStaticMarkup(<Document slug="tutorial" source="tutorial.md" body={body} published={[]} />)
    expect(html.match(/class="shell-tabs"/g)).toHaveLength(2)
    expect(html).toContain('<details>')
    expect(html).toContain('<summary>What did this command choose?</summary>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('&lt;details&gt;')
  })
})

describe('page subtitle', () => {
  const render = (slug: string, body: string) =>
    renderToStaticMarkup(<Document slug={slug} source={`${slug}.md`} body={body} published={[]} />)

  it('marks an emphasis-only paragraph after the h1, through the sanitizer', () => {
    const html = render('requirements', '# Requirements\n\n*What Lingtai needs — a choice; short*\n\nBody text.')
    expect(html).toContain('<p class="subtitle"><em>What Lingtai needs — a choice; short</em></p>')
  })

  it('marks the subtitle on the tutorial and leaves the intro as the next paragraph', () => {
    const html = render('tutorial', '# Tutorial\n\n*Get one ticket to land*\n\nIntro here.')
    expect(html).toContain('<p class="subtitle">')
    expect(html).toContain('<p>Intro here.</p>')
  })

  it('does not mark bold, mixed or non-adjacent paragraphs', () => {
    expect(render('x', '# T\n\n**bold**\n\nBody')).not.toContain('subtitle')
    expect(render('x', '# T\n\n*em* and more\n\nBody')).not.toContain('subtitle')
    expect(render('x', '# T\n\nBody\n\n*em*')).not.toContain('subtitle')
  })

  it('draws nothing on a plugin page without one', () => {
    const body = readFileSync(new URL('../../../doc/plugins/agent.md', import.meta.url), 'utf8')
    expect(render('plugins/agent', body)).not.toContain('class="subtitle"')
  })
})
