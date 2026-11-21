/**
 * Whether git would accept `name` as a branch — a pure copy of `git
 * check-ref-format --branch`'s rules, so that `resolveSource`, which is
 * synchronous and runs no process, refuses the same names every reader does.
 * `packages/recipe/test/branch-names.ts` is the table both this copy and the
 * real `git` are held to.
 *
 * Returns the reason, or null where the name is fine.
 */
export function branchNameRefusal(name: string): string | null {
  if (name === '') return 'is empty'
  if (name === '@') return 'cannot be the single character @'
  if (name === 'HEAD') return 'cannot be HEAD'
  if (name.startsWith('-')) return 'cannot begin with a dash'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(name)) return 'cannot contain a space or a control character'
  if (/[~^:?*[\\]/.test(name)) return 'cannot contain any of ~ ^ : ? * [ \\'
  if (name.includes('..')) return 'cannot contain ..'
  if (name.includes('@{')) return 'cannot contain @{'
  if (name.startsWith('/') || name.endsWith('/')) return 'cannot begin or end with a slash'
  if (name.includes('//')) return 'cannot contain two slashes in a row'
  if (name.endsWith('.')) return 'cannot end with a dot'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'cannot have a part that begins with a dot'
    if (part.endsWith('.lock')) return 'cannot have a part that ends with .lock'
  }
  return null
}
