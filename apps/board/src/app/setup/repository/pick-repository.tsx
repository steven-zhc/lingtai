'use client'
/**
 * Step 1 of adding a repository (#970): the tab, the filter, the radio and the
 * path box. Its props are plain rows and sentences; it imports nothing that
 * reaches `@lingtai/setup` (`pick-model.ts` is value-free of it).
 */
import { useEffect, useState } from 'react'

import { checkLocalPath } from './actions.ts'
import { type Choice, filterRows, type LocalView, nextHref, type Source, typedSlug } from './pick-model.ts'

type Checked = { input: string; view: LocalView } | { input: string; view: 'failed' }

export function PickRepository({ source }: { source: Source }) {
  const [tab, setTab] = useState<'github' | 'local'>(source === null ? 'local' : 'github')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [checked, setChecked] = useState<Checked | null>(null)

  const groups = source !== null && 'list' in source ? source.list.groups : []
  const typed = typedSlug(query, groups)
  const slug = picked ?? typed

  useEffect(() => {
    if (path.trim() === '') return
    const input = path
    const timer = setTimeout(() => {
      checkLocalPath(input).then(
        (view) => setChecked({ input, view }),
        () => setChecked({ input, view: 'failed' }),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [path])

  // A result counts only for the input it was asked about.
  const current = checked !== null && checked.input === path ? checked.view : null
  const local = current !== null && current !== 'failed' && current.ok ? current : null

  const choice: Choice | null =
    tab === 'github'
      ? slug === null
        ? null
        : { kind: 'repo', slug }
      : local === null
        ? null
        : { kind: 'path', path: local.path }

  return (
    <div className="wiz">
      <div className="wiz-tabs" role="tablist">
        {source !== null ? (
          <button type="button" role="tab" aria-selected={tab === 'github'} onClick={() => setTab('github')}>
            GitHub
          </button>
        ) : null}
        <button type="button" role="tab" aria-selected={tab === 'local'} onClick={() => setTab('local')}>
          Local
        </button>
      </div>

      {tab === 'github' && source !== null ? (
        <div>
          {'error' in source ? <p className="note wiz-fail">{source.error}</p> : null}
          {'list' in source ? (
            <>
              {source.list.notes.map((n) => (
                <p className="note" key={n}>
                  {n}
                </p>
              ))}
              {source.list.installUrl !== null ? (
                <p className="note">
                  <a href={source.list.installUrl}>Install the App</a>
                </p>
              ) : null}
            </>
          ) : null}
          <input
            className="wiz-input"
            type="text"
            value={query}
            placeholder={'filter, or type owner/repo'}
            onChange={(e) => {
              setQuery(e.target.value)
              setPicked(null)
            }}
          />
          {groups.map((g) => (
            <fieldset className="wiz-group" key={g.label}>
              <legend>{g.label}</legend>
              {g.sentences.map((s) => (
                <p className="note" key={s}>
                  {s}
                </p>
              ))}
              {filterRows(g.rows, query).map((r) => (
                <label className={r.disabled === null ? 'wiz-row' : 'wiz-row off'} key={r.slug}>
                  <input
                    type="radio"
                    name="repo"
                    disabled={r.disabled !== null}
                    checked={picked === r.slug}
                    onChange={() => setPicked(r.slug)}
                  />
                  <span className="mono">{r.slug}</span>
                  {r.private ? <span className="wiz-tag">private</span> : null}
                  {r.disabled !== null ? <span className="wiz-tag">{r.disabled}</span> : null}
                </label>
              ))}
            </fieldset>
          ))}
          {typed !== null && picked === null ? (
            <p className="note">
              Using <code>{typed}</code>
            </p>
          ) : null}
        </div>
      ) : (
        <div>
          <input
            className="wiz-input mono"
            type="text"
            value={path}
            placeholder="/absolute/path/to/a/git/repository"
            onChange={(e) => setPath(e.target.value)}
          />
          {path.trim() === '' ? null : current === null ? (
            <p className="note">checking…</p>
          ) : current === 'failed' ? (
            <p className="note wiz-fail">could not be checked</p>
          ) : (
            <p className={current.ok ? 'note' : 'note wiz-fail'}>
              {current.ok ? (
                <>
                  <code>{current.path}</code>
                  {current.branch !== null ? (
                    <>
                      {' '}
                      on <code>{current.branch}</code>
                    </>
                  ) : (
                    ' on a detached HEAD'
                  )}
                  <br />
                </>
              ) : null}
              {current.say}
            </p>
          )}
        </div>
      )}

      <p className="btnrow">
        {choice === null ? (
          <button type="button" className="btn go" disabled>
            Next
          </button>
        ) : (
          <a className="btn go" href={nextHref(choice)}>
            Next
          </a>
        )}
      </p>
    </div>
  )
}
