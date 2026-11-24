'use client'
/**
 * Step 2's form (#971): one line per thing the recipe decides, each with its
 * *change*, the two decisions, and the recipe beside them. **It holds answers
 * and nothing else** — the preview and the write are server actions that build
 * the changes from them, so what is shown beside the form is the writer's own
 * output and never a template. Types only from `@lingtai/setup`.
 */
import { STEPS, type Step } from '@lingtai/domain'
import type { SetupForm as Answers } from '@lingtai/setup'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { STEP_SAYS } from '../../../../lib/step-says.ts'
import { ModeGraph } from '../../../mode-graph.tsx'
import { FileView } from '../../../recipe/[project]/file-view.tsx'
import { StepRow } from '../../../step-row.tsx'
import { addRepository, checkPersonal, previewAdd } from './actions.ts'
import { KIND_DEFAULTS_NOTE, type CheckView, type Preview, type ReadView } from './read-model.ts'

const kindsOf = (text: string): string[] =>
  text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')

/** One host per line (or comma-separated), trimmed, none empty. The server checks each by the block's own rule. */
const hostsOf = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((h) => h.trim())
    .filter((h) => h !== '')

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

/** The answer to the check as typed, as the message line shows it. */
type Checked =
  | { state: 'checking' }
  | { state: 'done'; asked: string; check: Awaited<ReturnType<typeof checkPersonal>> }

export function SetupForm({ view }: { view: ReadView }) {
  const [mode, setMode] = useState<'team' | 'solo'>('team')
  const [personal, setPersonal] = useState(view.team.personal)
  const [personalTouched, setPersonalTouched] = useState(false)
  const [typedLogin, setTypedLogin] = useState('')
  const [checked, setChecked] = useState<Checked>({ state: 'checking' })
  const checkedFor = useRef(0)
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
  const [sandboxOn, setSandboxOn] = useState(true)
  const [allowText, setAllowText] = useState('')
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

  const local = view.target.kind === 'local'
  // A directory's team project governs the branch it is on; its solo one lands on `lingtai-base` (0130 §2).
  const mainBranch = mode === 'team' && local ? (view.team.checkedOut ?? '') : base
  const login = view.team.login ?? (typedLogin.trim() === '' ? null : typedLogin.trim())
  const runtime = view.runtimes.find((r) => r.id === writer)
  const unbounded = runtime?.noTurnCeiling === true
  const answers: Answers = {
    project: view.project,
    target: view.target,
    base: mainBranch,
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
    sandbox: view.sandbox === null ? null : { enabled: sandboxOn, allow: hostsOf(allowText) },
    mode,
    personal: mode === 'team' ? personal : '',
    login: mode === 'team' && !local ? login : null,
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

  // The check as typed: debounced, and only the latest request's answer is kept (a server action cannot be aborted).
  useEffect(() => {
    if (mode !== 'team') return
    const mine = ++checkedFor.current
    const asked = `${personal}\n${mainBranch}`
    setChecked({ state: 'checking' })
    const timer = setTimeout(() => {
      checkPersonal(view.target, personal, mainBranch).then(
        (check) => {
          if (checkedFor.current === mine) setChecked({ state: 'done', asked, check })
        },
        (e: unknown) => {
          if (checkedFor.current === mine) {
            setChecked({ state: 'done', asked, check: { ok: true, exists: 'unreadable' } })
            void e
          }
        },
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [mode, personal, mainBranch, view.target])

  const onLogin = (value: string) => {
    setTypedLogin(value)
    if (!personalTouched && value.trim() !== '') setPersonal(`${value.trim()}/${view.team.host}`)
  }

  // Add waits for the message that explains the remote write: it is enabled only once the answer is for the name now in the field.
  const confirming = mode === 'team' && (checked.state !== 'done' || checked.asked !== `${personal}\n${mainBranch}`)

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

  const under: Record<Step, ReactNode> = {
    claim: (
      <>
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
                <input type="radio" checked={tickets === 'github'} onChange={() => setTickets('github')} />
                github
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
      </>
    ),
    admit: (
      <>
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
      </>
    ),
    prepared: (
      <>
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
      </>
    ),
    design: null,
    implement: (
      <>
        <Line
          label="agent"
          note={view.writer.note}
          known={view.writer.known}
          changing={open === 'agent'}
          onChange={toggle('agent')}
          shown={<span className="mono">{writer === '' ? 'none signed in' : writer}</span>}
          editor={signedIn.length > 0 ? choose(writer, setWriter, signedIn) : text(writer, setWriter)}
        />
      </>
    ),
    build: (
      <>
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
      </>
    ),
    review: (
      <>
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
      </>
    ),
    proposed: (
      <>
        <h3 className="s2-h">A person approves the merge?</h3>
        <fieldset className="wiz-group">
          <label className="wiz-row">
            <input type="radio" checked={!approves} onChange={() => setApproves(false)} />
            <span>
              <b>No</b> — an attempt that passes its checks lands on{' '}
              <span className="mono">{(mode === 'team' ? personal : base) || 'the base'}</span> by itself
            </span>
          </label>
          <label className="wiz-row">
            <input type="radio" checked={approves} onChange={() => setApproves(true)} />
            <span>
              <b>Yes</b> — every attempt is held for a person
            </span>
          </label>
        </fieldset>
      </>
    ),
    merge: null,
    end:
      view.target.kind === 'github' ? (
        <>
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
        </>
      ) : null,
  }

  const messageOf = (c: Checked) => {
    if (c.state === 'checking') return <span className="note">checking…</span>
    const r = c.check
    if (!r.ok) {
      return (
        <span className="note wiz-fail">
          ✕ {r.say}
          {r.fix !== null ? (
            <>
              {' '}
              — use{' '}
              <button
                type="button"
                className="s2-change mono"
                onClick={() => {
                  setPersonalTouched(true)
                  setPersonal(r.fix ?? '')
                }}
              >
                {r.fix}
              </button>
            </>
          ) : null}
        </span>
      )
    }
    if (r.exists === 'unreadable') {
      return <span className="note wiz-fail">could not check whether {personal} exists — Add is still possible</span>
    }
    return r.exists ? (
      <span className="note">
        exists already — Lingtai will use it as it is; main is brought in at your first submit
      </span>
    ) : (
      <span className="note wiz-ok">
        ✓ a new branch, made from {mainBranch || 'main'}
        {local ? '' : ' and pushed'} when you finish
      </span>
    )
  }

  const modeCard = (value: 'team' | 'solo', title: string, lines: string[]) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      aria-pressed={mode === value}
      className={mode === value ? 'mode on' : 'mode'}
      onClick={() => setMode(value)}
    >
      <ModeGraph mode={value} />
      <b>
        {title}
        {value === 'team' ? ' (recommended)' : ''}
      </b>
      {lines.map((l) => (
        <span key={l} className="note">
          {l}
        </span>
      ))}
    </button>
  )

  return (
    <div className="s2">
      <div className="s2-left">
        <section className="rcard">
          <h3 className="rcard-h">Does anyone else work on this repository?</h3>
          <div className="mode-cards" role="radiogroup" aria-label="how you work">
            {modeCard('team', 'Team', [
              'Others push to this repository, or you review before main changes',
              'Works on your branch; main is brought in when you submit a PR',
              'Takes the issues assigned to you',
            ])}
            {modeCard('solo', 'Solo', [
              'Only you work on this repository',
              'Lands on one branch, by itself or when you approve',
              'Takes every ticket',
            ])}
          </div>
          {mode === 'team' ? (
            <div className="mode-branch">
              {!local && view.team.login === null ? (
                <label className="wiz-row">
                  <span>your GitHub login</span>
                  <input
                    className="wiz-input mono"
                    value={typedLogin}
                    onChange={(e) => onLogin(e.target.value)}
                    placeholder="octocat"
                  />
                </label>
              ) : null}
              <label className="wiz-row">
                <span>your personal branch</span>
                <input
                  className="wiz-input mono"
                  value={personal}
                  onChange={(e) => {
                    setPersonalTouched(true)
                    setPersonal(e.target.value)
                  }}
                />
              </label>
              <p className="mode-msg">{messageOf(checked)}</p>
              <ul className="wiz-list mode-facts">
                <li>
                  <b>Made from</b> origin/{mainBranch || 'main'}
                </li>
                <li>
                  <b>Default name</b> {local ? 'lingtai-base' : 'your GitHub login and this machine'}
                </li>
                <li>
                  <b>Main brought in</b> when you submit a PR, never before
                </li>
                <li>
                  <b>Never pushes</b> main
                </li>
                <li>
                  <b>Takes</b>{' '}
                  {local ? (
                    'every ticket in this project'
                  ) : (
                    <>
                      issues assigned to <span className="mono">{login ?? 'you'}</span>
                    </>
                  )}
                </li>
              </ul>
            </div>
          ) : null}
          <p className="note">
            You can switch to solo later, once everything on your branch has reached main and no PR is open.
          </p>
        </section>

        <section className="rcard">
          <h3 className="rcard-h">
            <span>What one attempt does, in order</span>
          </h3>
          <ol className="step-list">
            {STEPS.map((step, i) => (
              <StepRow
                key={step}
                n={i + 1}
                step={step}
                says={STEP_SAYS[step]}
                on={under[step] !== null}
                empty="nothing to set here"
              >
                {under[step]}
              </StepRow>
            ))}
          </ol>
        </section>

        {view.sandbox !== null ? (
          <section className="rcard">
            <h3 className="rcard-h">Sandbox</h3>
            {view.sandbox.cannot !== null ? <p className="note wiz-fail">{view.sandbox.cannot}</p> : null}
            <fieldset className="wiz-group">
              <label className="wiz-row">
                <input type="radio" checked={sandboxOn} onChange={() => setSandboxOn(true)} />
                <span>
                  <b>On</b> — agents and build commands run inside it
                </span>
              </label>
              <label className="wiz-row">
                <input type="radio" checked={!sandboxOn} onChange={() => setSandboxOn(false)} />
                <span>
                  <b>Off</b> — {view.sandbox.offLine}
                </span>
              </label>
            </fieldset>
            {sandboxOn ? (
              <>
                <p className="note">Hosts every sandboxed run may reach:</p>
                <p className="mono">{view.sandbox.builtIns.join(' · ')}</p>
                <label className="wiz-row">
                  <span>more hosts, one per line</span>
                  <textarea
                    className="wiz-input mono"
                    rows={3}
                    value={allowText}
                    onChange={(e) => setAllowText(e.target.value)}
                  />
                </label>
              </>
            ) : null}
          </section>
        ) : null}

        <section className="rcard">
          <h3 className="rcard-h">What an attempt may spend</h3>
          <div className="s2-limits">
            <label>
              refusal fixes {num(limits.refusalFixes, (refusalFixes) => setLimits({ ...limits, refusalFixes }))}
            </label>
            <label>
              conflict resolutions{' '}
              {num(limits.conflictResolutions, (conflictResolutions) => setLimits({ ...limits, conflictResolutions }))}
            </label>
            <label>
              new attempts {num(limits.newAttempts, (newAttempts) => setLimits({ ...limits, newAttempts }))}
            </label>
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
        </section>

        {say !== null ? <p className="note wiz-fail">{say}</p> : null}
        <p className="btnrow">
          <a className="btn" href="/setup/repository">
            Back
          </a>
          <button type="button" className="btn go" disabled={adding || confirming} onClick={add}>
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
          <div className="rfile">
            <div className="rfile-bar">
              <b>recipe.yml</b>
              <small>preview — nothing is written until Add</small>
            </div>
            <FileView text={preview.text} />
          </div>
        )}
      </div>
    </div>
  )
}
