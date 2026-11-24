import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'

import { MarkdownField, type MarkdownFieldProps } from '../src/app/markdown-field.tsx'

/**
 * The board's unit tests have no DOM, so they walk the element tree they rendered. A test that types into a Markdown
 * field goes through here (#1372): it finds the `MarkdownField` element and hands its `onChange` the text, as the
 * editor does, so a test does not depend on whether the field is a textarea or CodeMirror.
 */
export function findMarkdownField(node: ReactNode): ReactElement<MarkdownFieldProps> | null {
  let found: ReactElement<MarkdownFieldProps> | null = null
  Children.forEach(node, (child) => {
    if (!isValidElement(child) || found) return
    if (child.type === MarkdownField) found = child as ReactElement<MarkdownFieldProps>
    else found = findMarkdownField((child.props as { children?: ReactNode }).children)
  })
  return found
}

export function markdownField(node: ReactNode): ReactElement<MarkdownFieldProps> {
  const found = findMarkdownField(node)
  if (!found) throw new Error('no MarkdownField rendered')
  return found
}

/** Types `text` into the field, the way the editor reports it: the whole text, not an event. */
export function typeInto(node: ReactNode, text: string): void {
  markdownField(node).props.onChange?.(text)
}
