'use client'
/**
 * Step 2's form (#971): one line per thing the recipe decides, each with its
 * *change*, the two decisions, and the recipe beside them. **It holds answers
 * and nothing else** — the preview and the write are server actions that build
 * the changes from them, so what is shown beside the form is the writer's own
 * output and never a template. Types only from `@lingtai/setup`.
 */
import type { SetupForm as Answers } from '@lingtai/setup'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { addRepository, previewAdd } from './actions.ts'
import { KIND_DEFAULTS_NOTE, type CheckView, type Preview, type ReadView } from './read-model.ts'

const kindsOf = (text: string): string[] =>
  text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')

function Line(props: {
  label: string
  note: string
  known?: boolean
  changing: boolean
  onChange: () => void
  disabled?: string | null
  shown: ReactNode
  editor: ReactNode
}) {
  return (
    <div className="s2-line">
      <span className="s2-k">{props.label}</span>
      <span className="s2-v">{props.changing ? props.editor : props.shown}</span>
      <span className={props.known === false ? 's2-note wiz-fail' : 's2-note'}>{props.disabled ?? props.note}</span>
      {props.disabled == null ? (
        <button type="button" className="s2-change" onClick={props.onChange}>
          {props.changing ? 'done' : 'change'}
        </button>
      ) : null}
    </div>
  )
}

export function SetupForm({ view }: { view: ReadView }) {
  const [base, setBase] = useState(view.base.value)
  const [install, setInstall] = useState(view.install.value)
  const [checks, setChecks] = useState<CheckView[]>(view.checks.value)
  const [writer, setWriter] = useState(view.writer.value)
  const [reviewer, setReviewer] = useState(view.reviewer.value)
  const [tickets, setTickets] = useState(view.tickets.value)
  const [kinds, setKinds] = useState(view.kinds.value.join(', '))
  const [heldBy, setHeldBy] = useState(view.heldBy.value)
  const [closeOnEnd, setCloseOnEnd] = useState(view.end.value)
  const [approves, setApproves] = useState(false)
  const [limits, setLimits] = useState(view.limits)
  const [open, setOpen] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [adding, setAdding] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const asked = useRef(0)
  const [typedCheck, setTypedCheck] = useState('')
  const addCheck = () => {
    const run = typedCheck.trim()
    if (run === '') return
    setChecks(
      checks.some((c) => c.run === run)
        ? checks.map((c) => (c.run === run ? { ...c, ticked: true } : c))
        : [...checks, { name: run, run, ticked: true, why: 'typed in' }],
    )
    setTypedCheck('')
  }

  const runtime = view.runtimes.find((r) => r.id === writer)
  const unbounded = runtime?.noTurnCeiling === true
  const answers: Answers = {
    project: view.project,
    target: view.target,
    base,
    remote: view.remote,
    install,
    checks: checks.filter((c) => c.ticked).map((c) => ({ name: c.name, run: c.run })),
    writer,
    reviewer,
    tickets,
    kinds: kindsOf(kinds),
    heldBy,
    closeOnEnd,
    personApprovesMerge: approves,
    limits: unbounded ? { ...limits, turns: 'unbounded' } : limits,
    turnsUnbounded: unbounded,
  }
  const key = JSON.stringify(answers)

  // Debounced, and a response older than the latest request is dropped.
  useEffect(() => {
    const mine = ++asked.current
    const timer = setTimeout(() => {
      previewAdd(JSON.parse(key) as Answers).then(
        (p) => {
          if (asked.current === mine) setPreview(p)
        },
        (e: unknown) => {
          if (asked.current === mine) setPreview({ refused: (e as Error).message })
        },
      )
    }, 200)
    return () => clearTimeout(timer)
  }, [key])

  const toggle = (name: string) => () => setOpen(open === name ? null : name)
  const text = (value: string, set: (v: string) => void, mono = true) => (
    <input className={mono ? 'wiz-input mono' : 'wiz-input'} value={value} onChange={(e) => set(e.target.value)} />
  )
  const choose = (value: string, set: (v: string) => void, options: string[]) => (
    <select className="wiz-input" value={value} onChange={(e) => set(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
  const signedIn = view.runtimes.filter((r) => r.signedIn).map((r) => r.id)
  const num = (value: number, set: (n: number) => void, min = 0) => (
    <input
      className="wiz-input s2-num"
      type="number"
      min={min}
      value={value}
      onChange={(e) => set(Number(e.target.value))}
    />
  )

  const add = () => {
    setAdding(true)
    setSay(null)
    addRepository(answers).then(
      (r) => {
        if (r.ok) window.location.assign(`/setup/repository/added?project=${encodeURIComponent(r.project)}`)
        else {
          setSay(r.say)
          setAdding(false)
        }
      },
      (e: unknown) => {
        setSay((e as Error).message)
        setAdding(false)
      },
    )
  }

  return (
    <div className="s2">
      <div className="s2-left">
        <Line
          label="base"
          note={view.base.note}
          known={view.base.known}
          changing={open === 'base'}
          onChange={toggle('base')}
          shown={<span className="mono">{base === '' ? '—' : base}</span>}
          editor={text(base, setBase)}
          disabled={
            view.target.kind === 'local' ? 'made from the branch checked out, and lands there last (0104 §15)' : null
          }
        />
        <Line
          label="stack"
          note={view.stack.value.join(' · ') || view.stack.note}
          known={view.stack.known}
          changing={false}
          onChange={() => setOpen('install')}
          shown={<span>{view.stack.value.length === 0 ? 'nothing recognised' : 'detected'}</span>}
          editor={null}
        />
        <Line
          label="install"
          note={view.install.note}
          known={view.install.known}
          changing={open === 'install'}
          onChange={toggle('install')}
          shown={<span className="mono">{install === '' ? 'none' : install}</span>}
          editor={text(install, setInstall)}
        />
        <Line
          label="checks"
          note={view.checks.note}
          known={view.checks.known}
          changing={open === 'checks'}
          onChange={toggle('checks')}
          shown={
            <span className="mono">
              {checks
                .filter((c) => c.ticked)
                .map((c) => c.run)
                .join(' · ') || 'none — nothing checks a diff before review'}
            </span>
          }
          editor={
            <span className="s2-checks">
              {checks.map((c, i) => (
                <label key={`${c.name}:${c.run}`} className="wiz-row">
                  <input
                    type="checkbox"
                    checked={c.ticked}
                    onChange={() => setChecks(checks.map((x, j) => (j === i ? { ...x, ticked: !x.ticked } : x)))}
                  />
                  <span className="mono">{c.run}</span>
                  <span className="wiz-tag">{c.why}</span>
                </label>
              ))}
              {checks.length === 0 ? <span className="note">no scripts found</span> : null}
              <span className="wiz-row">
                <input
                  className="wiz-input mono"
                  placeholder="a command to run as a check"
                  value={typedCheck}
                  onChange={(e) => setTypedCheck(e.target.value)}
                />
                <button type="button" className="s2-change" onClick={addCheck}>
                  add
                </button>
              </span>
            </span>
          }
        />
        <Line
          label="agent"
          note={view.writer.note}
          known={view.writer.known}
          changing={open === 'agent'}
          onChange={toggle('agent')}
          shown={<span className="mono">{writer === '' ? 'none signed in' : writer}</span>}
          editor={signedIn.length > 0 ? choose(writer, setWriter, signedIn) : text(writer, setWriter)}
        />
        <Line
          label="reviewer"
          note={view.reviewer.note}
          known={view.reviewer.known}
          changing={open === 'reviewer'}
          onChange={toggle('reviewer')}
          shown={<span className="mono">{reviewer}</span>}
          editor={
            view.runtimes.length > 0
              ? choose(reviewer, setReviewer, [...signedIn, 'none'])
              : text(reviewer, setReviewer)
          }
        />
        <Line
          label="tickets"
          note={view.tickets.note}
          known={view.tickets.known}
          changing={open === 'tickets'}
          onChange={toggle('tickets')}
          disabled={view.ticketsLocked ? view.tickets.note : null}
          shown={<span className="mono">{tickets}</span>}
          editor={
            <span>
              <label className="wiz-row">
                <input
                  type="radio"
                  checked={tickets === 'github'}
                  disabled={view.githubOff !== null}
                  onChange={() => setTickets('github')}
                />
                github
                {view.githubOff !== null ? <span className="wiz-tag">{view.githubOff}</span> : null}
              </label>
              <label className="wiz-row">
                <input type="radio" checked={tickets === 'db'} onChange={() => setTickets('db')} />
                db — Lingtai keeps its own
              </label>
            </span>
          }
        />
        <Line
          label="kinds"
          note={KIND_DEFAULTS_NOTE}
          changing={open === 'kinds'}
          onChange={toggle('kinds')}
          shown={<span className="mono">{kinds}</span>}
          editor={text(kinds, setKinds)}
        />
        <Line
          label="held by"
          note="a label that keeps a ticket from being taken"
          known={view.heldBy.known}
          changing={open === 'held'}
          onChange={toggle('held')}
          shown={<span className="mono">{heldBy === '' ? 'nothing' : heldBy}</span>}
          editor={text(heldBy, setHeldBy)}
        />
        {view.target.kind === 'github' ? (
          <Line
            label="end"
            note={view.end.note}
            changing={open === 'end'}
            onChange={toggle('end')}
            shown={
              <span>
                {closeOnEnd ? 'close the ticket when it lands, or a person ends it' : 'leave the ticket open'}
              </span>
            }
            editor={
              <label className="wiz-row">
                <input type="checkbox" checked={closeOnEnd} onChange={() => setCloseOnEnd(!closeOnEnd)} />
                close the ticket when it ends
              </label>
            }
          />
        ) : null}

        <h3 className="s2-h">A person approves the merge?</h3>
        <fieldset className="wiz-group">
          <label className="wiz-row">
            <input type="radio" checked={!approves} onChange={() => setApproves(false)} />
            <span>
              <b>No</b> — an attempt that passes its checks lands on <span className="mono">{base || 'the base'}</span>{' '}
              by itself
            </span>
          </label>
          <label className="wiz-row">
            <input type="radio" checked={approves} onChange={() => setApproves(true)} />
            <span>
              <b>Yes</b> — every attempt is held for a person
            </span>
          </label>
        </fieldset>

        <h3 className="s2-h">What an attempt may spend</h3>
        <div className="s2-limits">
          <label>rounds {num(limits.rounds, (rounds) => setLimits({ ...limits, rounds }))}</label>
          <label>restarts {num(limits.restarts, (restarts) => setLimits({ ...limits, restarts }))}</label>
          <label>
            wall{' '}
            <input
              className="wiz-input s2-num"
              value={limits.wall}
              onChange={(e) => setLimits({ ...limits, wall: e.target.value })}
            />
          </label>
          <label>
            turns{' '}
            {unbounded ? (
              <span className="mono">unbounded</span>
            ) : (
              num(limits.turns === 'unbounded' ? 300 : limits.turns, (turns) => setLimits({ ...limits, turns }), 1)
            )}
          </label>
        </div>
        <p className="note">{preview !== null && 'ceiling' in preview ? preview.ceiling : '…'}</p>

        {say !== null ? <p className="note wiz-fail">{say}</p> : null}
        <p className="btnrow">
          <a className="btn" href="/setup/repository">
            Back
          </a>
          <button type="button" className="btn go" disabled={adding} onClick={add}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </p>
      </div>

      <div className="s2-right">
        <h3 className="s2-h">recipe.yml</h3>
        {preview === null ? (
          <p className="note">writing the preview…</p>
        ) : 'refused' in preview ? (
          <p className="note wiz-fail">{preview.refused}</p>
        ) : (
          <pre className="s2-yaml">{preview.text}</pre>
        )}
      </div>
    </div>
  )
}
