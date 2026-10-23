import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Document } from '../src/app/docs/document'

describe('tutorial shell examples', () => {
  it('offers one selectable group on the site while preserving each command', () => {
    const body = `**Bash**

\`\`\`bash
echo bash
\`\`\`

**Zsh**

\`\`\`zsh
echo zsh
\`\`\`

**Fish**

\`\`\`fish
echo fish
\`\`\``
    const html = renderToStaticMarkup(<Document slug="tutorial" source="tutorial.md" body={body} published={[]} />)

    expect(html).toContain('type="radio"')
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="bash"/)
    expect(html).toContain('value="zsh"')
    expect(html).toContain('value="fish"')
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).toContain('echo bash')
    expect(text).toContain('echo zsh')
    expect(text).toContain('echo fish')
    expect(html).not.toContain('<p><strong>Bash</strong></p>')
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
