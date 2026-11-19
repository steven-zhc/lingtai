/** The `## Done when` list is parsed in one place (#1251): the decision and the check read the same items. */
import { describe, expect, it } from 'vitest'

import { doneWhenItems } from '../src/done-when.ts'

describe('doneWhenItems', () => {
  it('reads each top-level list line between the heading and the next section, checkbox removed', () => {
    const body = [
      '| a | b |',
      '',
      '## Done when',
      '',
      '- [ ] `pnpm typecheck` is green',
      '- [x] A refused check routes straight to `fixRefusal`.',
      '* a bullet with a star',
      '1. a numbered line',
      '',
      '## Related',
      '',
      '- #1250 is not an item',
    ].join('\n')
    expect(doneWhenItems(body)).toEqual([
      '`pnpm typecheck` is green',
      'A refused check routes straight to `fixRefusal`.',
      'a bullet with a star',
      'a numbered line',
    ])
  })

  it('folds a nested line into the item it belongs to, and collapses whitespace', () => {
    const body = '## Done when\n- [ ] one   item\n  - nested\n  continued here\n- [ ] two\n'
    expect(doneWhenItems(body)).toEqual(['one item nested continued here', 'two'])
  })

  it('is null where there is no list to check against: no heading, or a heading with no item', () => {
    expect(doneWhenItems('just prose')).toBeNull()
    expect(doneWhenItems('## Done when\n\nnothing listed\n')).toBeNull()
    expect(doneWhenItems('## Related\n- [ ] not under the heading\n')).toBeNull()
  })
})
