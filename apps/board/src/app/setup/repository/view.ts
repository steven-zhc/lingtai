/**
 * The list `listRepositories` returned, reduced to plain rows and sentences a
 * client component can take (#970). Types only from `@lingtai/setup`.
 */
import type { ListedRepository, RepositoryList } from '@lingtai/setup'

import type { Group, ListView, Row } from './pick-model.ts'

const rowOf = (r: ListedRepository): Row => ({
  slug: r.slug,
  private: r.private,
  disabled:
    r.onboarded === null
      ? null
      : r.onboarded === 'taken'
        ? `taken by ${r.takenBy ?? 'another owner'}`
        : 'already added',
})

/** The list reduced to rows and sentences — plain data a client component can take. */ export function viewOf(
  list: RepositoryList,
): ListView {
  if (list.kind === 'gh') {
    const notes = list.more ? ['The list stopped early — type owner/repo for the rest.'] : []
    if (list.repositories.length === 0 && !list.more) notes.push(`${list.login} can push to no repository.`)
    return {
      groups: [{ label: list.login, sentences: [], rows: list.repositories.map(rowOf) }],
      notes,
      installUrl: null,
    }
  }
  const groups: Group[] = list.picker.installations.map((l) => ({
    label: l.installation.account,
    sentences: [
      ...(l.unanswered === null ? [] : [`GitHub would not list this account's repositories: ${l.unanswered}`]),
      ...l.gaps.map((g) => `missing permission ${g.name}: have ${g.have}, need ${g.need} — ${g.why}`),
    ],
    rows: l.repositories.map(rowOf),
  }))
  const empty = list.picker.installations.length === 0
  return {
    groups,
    notes: empty ? ['The App is not installed anywhere yet.'] : [],
    installUrl: list.picker.installUrl,
  }
}
