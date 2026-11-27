import { describe, expect, it } from 'vitest'

import { formFiles, issueFormsOf } from '../src/issue-forms.ts'

const FORM = 'name: New joke\ntitle: "Draw: "\nlabels: [feature]\n'

describe('issueFormsOf (#1518)', () => {
  it('only config.yml is not a form', () => {
    expect(issueFormsOf(['config.yml'], null)).toEqual({ kind: 'none' })
    expect(formFiles(['config.yaml', 'config.yml'])).toEqual([])
  })
  it('markdown templates are not forms', () => {
    expect(issueFormsOf(['bug.md'], null)).toEqual({ kind: 'none' })
  })
  it('one .yaml beside config.yml is the form, named by its name:', () => {
    expect(issueFormsOf(['config.yml', 'new-joke.yaml'], FORM)).toEqual({
      kind: 'one',
      file: 'new-joke.yaml',
      name: 'New joke',
    })
  })
  it('two forms are several, and need no text', () => {
    expect(issueFormsOf(['a.yml', 'b.yml'], null)).toEqual({ kind: 'several' })
  })
  it('a form with no name, bad YAML or no text is none, never the filename', () => {
    expect(issueFormsOf(['a.yml'], 'title: x\n')).toEqual({ kind: 'none' })
    expect(issueFormsOf(['a.yml'], 'name: [unclosed')).toEqual({ kind: 'none' })
    expect(issueFormsOf(['a.yml'], 'name: 3\n')).toEqual({ kind: 'none' })
    expect(issueFormsOf(['a.yml'], null)).toEqual({ kind: 'none' })
  })
})
