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

/**
 * What a person reads for a conflict git wrote no markers for (modify/delete,
 * add/add of binary, a rename): each stage's content, or that it is absent —
 * which side deleted the file is the point. `ours` is the base branch's side
 * and `theirs` the preserved branch's, as `git merge-tree base head` names them.
 */
export function stagesText(stages: { base: string | null; ours: string | null; theirs: string | null }): string {
  const side = (label: string, content: string | null) =>
    content === null ? `--- ${label}: absent (deleted or never added)` : `--- ${label}:\n${content}`
  return [
    'No conflict markers: the two sides changed this path in ways git cannot merge.',
    side('base (common ancestor)', stages.base),
    side('ours (the base branch)', stages.ours),
    side('theirs (the preserved branch)', stages.theirs),
  ].join('\n')
}
