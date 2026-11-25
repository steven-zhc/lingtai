// Walks every block of a stylesheet at any depth, comments stripped. A block's own
// declarations are its text outside child blocks; `chain` is its selector and every
// enclosing one, so nested CSS and `@media` wrappers are both visible to a caller.
export interface CssRule {
  selector: string
  body: string
  chain: string
}

export const rulesOf = (source: string): CssRule[] => {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  const stack: { selector: string; own: string }[] = []
  let text = ''
  for (const ch of bare) {
    if (ch === '{') {
      stack.push({ selector: text.slice(text.lastIndexOf(';') + 1).trim(), own: '' })
      text = ''
    } else if (ch === '}') {
      const top = stack.pop()
      if (top) {
        const chain = [...stack.map((f) => f.selector), top.selector]
        rules.push({ selector: top.selector, body: top.own + text, chain: chain.join(' ') })
      }
      text = ''
    } else {
      text += ch
    }
    if (ch === ';' && stack.length > 0) {
      stack[stack.length - 1]!.own += text
      text = ''
    }
  }
  return rules
}

export const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '')
