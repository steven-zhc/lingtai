import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { yamlLanguage } from '@codemirror/lang-yaml'
import { highlightTree } from '@lezer/highlight'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('../src/app/actions.ts', () => ({ saveRecipe: async () => ({}) }))

const formPath = '../src/app/recipe/[project]/recipe-form.tsx'

it('the highlight style puts a class on a key and on a comment', async () => {
  const { yamlHighlight } = await import('../src/app/recipe/[project]/yaml-editor.tsx')
  const sample = '# a comment\nname: lingtai\nlimits:\n  wall: "1h"\n'
  const hit: string[] = []
  highlightTree(yamlLanguage.parser.parse(sample), yamlHighlight, (from, to, cls) => {
    hit.push(`${sample.slice(from, to)}=${cls}`)
  })
  const classOf = (text: string) => hit.find((h) => h.startsWith(`${text}=`))
  expect(classOf('# a comment')).toBeDefined()
  expect(classOf('name')).toBeDefined()
  expect(classOf('limits')).toBeDefined()
})

it('RecipeForm renders the fallback textarea, posts text once from a hidden input, and imports no CodeMirror', async () => {
  const { RecipeForm } = await import('../src/app/recipe/[project]/recipe-form.tsx')
  const html = renderToStaticMarkup(<RecipeForm project="lingtai" initial={'a: 1\nb: 2'} />)
  expect(html).toMatch(/<textarea[^>]*>a: 1\nb: 2<\/textarea>/)
  expect(html.match(/name="text"/g)).toHaveLength(1)
  expect(html).toMatch(/<input type="hidden" name="text"/)
  const source = readFileSync(fileURLToPath(new URL(formPath, import.meta.url)), 'utf8')
  expect(source).not.toMatch(/from ['"]@codemirror/)
  expect(source).not.toMatch(/from ['"]\.\/yaml-editor/)
})
