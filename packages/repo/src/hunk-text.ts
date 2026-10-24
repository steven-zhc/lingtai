/**
 * The text of every conflict in a merged file, one entry per `<<<<<<<` marker
 * in the order {@link ConflictedPath.hunkLines} lists them: the marker line
 * through its `>>>>>>>`, whole — a person confirming behavior must be able to
 * read both sides, and the board's box scrolls. Pure, so the extraction is
 * unit-tested without git; a marker with no closing line runs to the end of
 * the file.
 */
export function hunkTextsOf(merged: string): string[] {
  const lines = merged.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('<<<<<<< ')) continue
    let end = i
    while (end < lines.length - 1 && !lines[end]!.startsWith('>>>>>>> ')) end++
    out.push(lines.slice(i, end + 1).join('\n'))
    i = end
  }
  return out
}
