/**
 * The one table `check-ref-format --branch`'s rules are pinned by: the unit half
 * runs it through `branchNameRefusal`, and the integration half runs the same
 * rows through the real `git` and expects the same answers.
 */
export const BRANCH_NAMES: readonly { readonly name: string; readonly valid: boolean }[] = [
  { name: 'main', valid: true },
  { name: 'steven/macbook', valid: true },
  { name: 'feature/a.b', valid: true },
  { name: 'a-b_c', valid: true },
  { name: 'v1.0', valid: true },
  { name: "Steven's MacBook", valid: false },
  { name: 'has space', valid: false },
  { name: '', valid: false },
  { name: 'HEAD', valid: false },
  { name: '-dash', valid: false },
  { name: 'a..b', valid: false },
  { name: 'a@{b', valid: false },
  { name: 'a~b', valid: false },
  { name: 'a^b', valid: false },
  { name: 'a:b', valid: false },
  { name: 'a?b', valid: false },
  { name: 'a*b', valid: false },
  { name: 'a[b', valid: false },
  { name: 'a\\b', valid: false },
  { name: '/a', valid: false },
  { name: 'a/', valid: false },
  { name: 'a//b', valid: false },
  { name: 'a.', valid: false },
  { name: '.a', valid: false },
  { name: 'a/.b', valid: false },
  { name: 'a.lock', valid: false },
  { name: 'a.lock/b', valid: false },
  { name: 'a\tb', valid: false },
]
