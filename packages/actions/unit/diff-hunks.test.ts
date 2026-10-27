import { describe, expect, it } from 'vitest'

import { demoteOutsideDiff, hunksOf, isInsideHunks } from '../src/diff-hunks.ts'

const lines = (diff: string, path: string) => [...(hunksOf(diff)?.lines.get(path) ?? [])].sort((a, b) => a - b)

describe('hunksOf', () => {
  it('covers the new-side range of a modified file, context included', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,4 +10,5 @@\n a\n+b\n c\n d\n e\n'
    expect(lines(diff, 'a.ts')).toEqual([10, 11, 12, 13, 14])
  })

  it('covers an added file from line 1', () => {
    const diff = 'diff --git a/n.ts b/n.ts\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n'
    expect(lines(diff, 'n.ts')).toEqual([1, 2, 3])
  })

  it('keys a renamed file by its new path', () => {
    const diff = 'diff --git a/o.ts b/p.ts\n--- a/o.ts\n+++ b/p.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n'
    expect(lines(diff, 'p.ts')).toEqual([1, 2])
    expect(hunksOf(diff)?.lines.has('o.ts')).toBe(false)
  })

  it('marks a deleted file by its old path, with no lines', () => {
    const diff = 'diff --git a/d.ts b/d.ts\n--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n--a\n-b\n'
    const hunks = hunksOf(diff)
    expect(hunks?.deleted.has('d.ts')).toBe(true)
    expect(isInsideHunks({ file: 'd.ts', line: 1 }, hunks!)).toBe(true)
  })

  it('unions two hunks in one file', () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -50,2 +50,2 @@\n x\n-y\n+z\n'
    expect(lines(diff, 'a.ts')).toEqual([1, 2, 50, 51])
  })

  it('reads a header with an omitted count as one line', () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -3 +3 @@\n-a\n+b\n'
    expect(lines(diff, 'a.ts')).toEqual([3])
  })

  it('does not take a body line that looks like a file header for one', () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n--- x\n+++ y\n'
    expect([...hunksOf(diff)!.lines.keys()]).toEqual(['a.ts'])
  })

  it('is null on a hunk header it cannot read', () => {
    expect(hunksOf('--- a/a\n+++ b/a\n@@ garbage @@\n')).toBeNull()
  })
})

describe('isInsideHunks', () => {
  const hunks = hunksOf('--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n')!

  it('classifies a null line by file only', () => {
    expect(isInsideHunks({ file: 'a.ts', line: null }, hunks)).toBe(true)
    expect(isInsideHunks({ file: 'other.ts', line: null }, hunks)).toBe(false)
  })

  it('treats a file with no hunks as outside', () => {
    const binary = hunksOf('diff --git a/b.png b/b.png\nBinary files differ\n')!
    expect(isInsideHunks({ file: 'b.png', line: 1 }, binary)).toBe(false)
  })
})

describe('demoteOutsideDiff', () => {
  const hunks = hunksOf('--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n')!
  const f = { file: 'a.ts', line: 99, claim: 'c', failureScenario: 's', severity: 'major' as const }

  it('does not prefix twice', () => {
    const [once] = demoteOutsideDiff([f], hunks)
    expect(demoteOutsideDiff([once!], hunks)[0]).toEqual(once)
  })
})
