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

it('the view shares the editor extensions, defines no highlight of its own, and replaces its document', async () => {
  const { EditorState } = await import('@codemirror/state')
  const { yamlExtensions } = await import('../src/app/recipe/[project]/yaml-editor.tsx')
  const { viewExtensions, replaceDoc } = await import('../src/app/recipe/[project]/yaml-view.tsx')
  for (const e of yamlExtensions) expect(viewExtensions).toContain(e)
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/recipe/[project]/yaml-view.tsx', import.meta.url)),
    'utf8',
  )
  expect(source).not.toMatch(/HighlightStyle/)
  const state = EditorState.create({ doc: 'a: 1', extensions: [EditorState.readOnly.of(true)] })
  expect(replaceDoc(state, 'a: 1')).toBeNull()
  const spec = replaceDoc(state, 'b: 2')
  expect(spec).not.toBeNull()
  expect(state.update(spec!).state.doc.toString()).toBe('b: 2')
})

it.each(['recipe-text.tsx', 'file-view.tsx'])('%s imports neither the view nor the editor statically', (file) => {
  const source = readFileSync(fileURLToPath(new URL(`../src/app/recipe/[project]/${file}`, import.meta.url)), 'utf8')
  expect(source).not.toMatch(/from ['"]@codemirror/)
  expect(source).not.toMatch(/from ['"]\.\/yaml-(view|editor)/)
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
