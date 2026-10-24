/** The most lines of one hunk kept for a person to read; the rest is cut and said so. */
export const HUNK_TEXT_MAX_LINES = 60

/**
 * The text of every conflict in a merged file, one entry per `<<<<<<<` marker
 * in the order {@link ConflictedPath.hunkLines} lists them: the marker line
 * through its `>>>>>>>`, bounded. Pure, so the extraction is unit-tested
 * without git; a marker with no closing line runs to the end of the file.
 */
export function hunkTextsOf(merged: string, max = HUNK_TEXT_MAX_LINES): string[] {
  const lines = merged.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('<<<<<<< ')) continue
    let end = i
    while (end < lines.length - 1 && !lines[end]!.startsWith('>>>>>>> ')) end++
    const body = lines.slice(i, end + 1)
    out.push(
      body.length > max
        ? [...body.slice(0, max), `[${body.length - max} more lines not shown]`].join('\n')
        : body.join('\n'),
    )
    i = end
  }
  return out
}
