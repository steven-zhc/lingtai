/**
 * **The tests a vitest run said failed** (0108 §17, #1207) — read from the tail of its output,
 * which is where vitest's default reporter prints its `FAIL` lines and its `Test Files` summary.
 *
 * Each entry is `<file> > <describe> > <test>` exactly as printed, after the optional project label (`|label|`, or a bare token);
 * a `FAIL` line naming only a file (a suite that failed to load) is the file alone.
 *
 * **Null means *cannot be named*, never *none failed*.** It is answered when there is no
 * `Test Files … N failed` summary, or when the `FAIL` lines name fewer distinct files than that `N`
 * (the tail was clipped), and for any other runner's output, `tsc`'s included.
 */
export function failingTestsOf(output: string): string[] | null {
  const summary = /^\s*Test Files\s+(\d+) failed/m.exec(output)
  if (summary === null) return null
  const failedFiles = Number(summary[1])
  const entries: string[] = []
  for (const line of output.split('\n')) {
    const m = /^\s*FAIL\s+(.*)$/.exec(line)
    if (m === null) continue
    let rest = (m[1] as string).trim()
    // A suite that failed to load is printed `<label?> <file> [ <file> ]`: the bracketed file alone is the entry.
    // It is read before any label is stripped, so a bare label cannot eat the start of a path with spaces.
    const suite = /^(.*?)\s*\[ (.+) \]$/.exec(rest)
    if (suite !== null && isLabelOnlyBefore(suite[1] as string, suite[2] as string)) {
      rest = suite[2] as string
    } else {
      // With projects vitest prints a label between FAIL and the file: `|any label|` (any characters but `|`),
      // or, in the older form, one bare token with no `/` and no `.`.
      const label = /^(?:\|[^|]*\||[^\s/.|]+)\s+(\S.*)$/.exec(rest)
      if (label !== null) rest = (label[1] as string).trim()
    }
    if (rest !== '' && !entries.includes(rest)) entries.push(rest)
  }
  const files = new Set(entries.map((e) => e.split(' > ')[0]))
  if (entries.length === 0 || files.size < failedFiles) return null
  return entries
}

/** The text before `[ <file> ]` is the file itself, or the file after one project label and nothing else (a test title ending in the same words is not). */
function isLabelOnlyBefore(prefix: string, file: string): boolean {
  if (prefix === file) return true
  if (!prefix.endsWith(file)) return false
  const head = prefix.slice(0, prefix.length - file.length)
  return /^(?:\|[^|]*\||[^\s/.|]+)\s+$/.test(head)
}
