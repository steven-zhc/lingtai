import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SandboxSection, sourceOfRow } from '@/app/p/[project]/recipe/sandbox-section'

const roots = { home: '/home/me', lingtaiHome: '/home/me/.lingtai', project: 'my-app' }
const builtIn = {
  domains: ['github.com', 'api.anthropic.com'],
  paths: {
    writable: ['<worktree>', '/home/me/.lingtai/cache/my-app/x'],
    denyRead: ['/home/me/.ssh'],
    denyWrite: ['/home/me/.lingtai/repos/my-app.git/hooks'],
  },
  pathsWhy: null,
}
const own = {
  enabled: true,
  required: false,
  network: { allow: ['example.org'] },
  write: ['~/data'],
  deny: ['~/secrets'],
}
const render = (o: Partial<Parameters<typeof SandboxSection>[0]> = {}) =>
  renderToStaticMarkup(
    <SandboxSection
      project="my-app"
      at="~/.lingtai/my-app/recipe.yml"
      roots={roots}
      own={own}
      recipeError={false}
      builtIn={builtIn}
      {...o}
    />,
  )

describe('the recipe page’s sandbox card', () => {
  it('is one card of five rows, with no refused connections', () => {
    const html = render()
    expect(html).toContain('id="sandbox"')
    for (const k of ['state', 'reachable', 'writable', 'cannot be read', 'cannot be written'])
      expect(html).toContain(`>${k}<`)
    expect(html).not.toContain('Recently blocked')
  })

  it('on, not required, and required', () => {
    expect(render()).toContain('not required')
    expect(render({ own: { ...own, required: true } })).toContain('required — this project is refused')
  })

  it('off with no block, and off with enabled: false', () => {
    const none = render({ own: undefined })
    expect(none).toContain('off — no sandbox block')
    expect(none).toContain('Add the block in the editor')
    expect(render({ own: { ...own, enabled: false } })).toContain('off — enabled: false')
  })

  it('an unreadable recipe says so and draws no this-recipe rows', () => {
    const html = render({ own: undefined, recipeError: true })
    expect(html).toContain('the recipe could not be read, so what it configures is unknown')
    expect(html).not.toContain('this recipe')
  })

  it('unreadable built-in paths say why, and reachable is still drawn', () => {
    const html = render({ builtIn: { ...builtIn, paths: null, pathsWhy: 'no host facts' } })
    expect(html).toContain('the built-in paths could not be read (no host facts)')
    expect(html).toContain('github.com')
  })

  it('draws the recipe’s own entries before the built-ins, with short names and the full path in title', () => {
    const html = render()
    expect(html.indexOf('~/data')).toBeLessThan(html.indexOf('&lt;worktree&gt;'))
    expect(html).toContain('title="/home/me/.lingtai/cache/my-app/x"')
    expect(html).toContain('&lt;cache&gt;/x')
    expect(html).toContain('each attempt&#x27;s own')
  })

  it('names the source of a row by whether the recipe has entries for it', () => {
    expect(sourceOfRow(['a'])).toBe('← recipe.yml')
    expect(sourceOfRow([])).toBe('← built in')
  })
})

describe('the agents block (#1329)', () => {
  it('sits above state, and Copilot rows appear only when the recipe names Copilot', () => {
    const html = render({ runtimes: ['claude-code', 'copilot', 'antigravity'] })
    expect(html.indexOf('which agents run inside it')).toBeGreaterThan(0)
    expect(html.indexOf('which agents run inside it')).toBeLessThan(html.indexOf('>state<'))
    expect(html).toContain('*.githubcopilot.com')
    expect(html).toContain('~/.copilot')
    expect(html).toContain('runs outside, with your keys')
    const plain = render({ runtimes: ['codex'] })
    expect(plain).not.toContain('githubcopilot')
    expect(plain).not.toContain('.copilot')
  })
  it('draws no block with the sandbox off', () => {
    expect(render({ own: undefined, runtimes: ['codex'] })).not.toContain('which agents run inside it')
  })
})
