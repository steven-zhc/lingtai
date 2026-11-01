import type { ReactNode } from 'react'

/**
 * The seven small illustrations on the front page, one beside each stop and each card beside the loop.
 * Each says it is an illustration, and the ticket names and dollar figures in it are invented.
 */

/** What `lingtai start` prints per ticket, in the shape `takingLine` and `endingLine` build (two spaces after the number). */
export const WORKTREE_LINES: readonly string[] = [
  'taking #12  Fix a failing test',
  '#12  Fix a failing test — implement ✓ build ✓ review ✓ · $0.84 · landed in 3f9c2a1',
  '#15  Add retry to uploader — implement ✓ build ✓ review ✗ · $1.20 · waiting for you: lingtai approve my-app --issue 15',
]

function Mini({
  title,
  label,
  short,
  children,
}: {
  title: ReactNode
  label: string
  short?: boolean
  children: ReactNode
}) {
  return (
    <div className={short ? 'home-mini short' : 'home-mini'} role="img" aria-label={`Illustration: ${label}`}>
      <div className="home-mini-t" aria-hidden="true">
        {title} <span>ILLUSTRATION</span>
      </div>
      <div aria-hidden="true">{children}</div>
    </div>
  )
}

export function QueuedMini() {
  return (
    <Mini title="QUEUED" label="the Queued column, with two tickets in order and one blocked by another">
      <div className="home-qrow chosen">
        <i />
        Fix a failing test<em>bug</em>
      </div>
      <div className="home-qrow">
        <i />
        Update API docs<em>feature</em>
      </div>
      <div className="home-qrow muted">
        <i />
        Rename config key<em>blocked by #15</em>
      </div>
    </Mini>
  )
}

export function WorktreeMini() {
  return (
    <Mini title="$ lingtai start" label="the lines lingtai start prints, one landed and one waiting for you">
      {WORKTREE_LINES.map((line, i) => (
        <div key={line} className={i === 2 ? 'home-logline wait' : 'home-logline'}>
          {line}
        </div>
      ))}
    </Mini>
  )
}

export function StepsMini() {
  return (
    <Mini title="STEPS" label="a ticket's steps: a finding in review, a fix round, then a pass, and a base that is red">
      <div className="home-rail">
        <span className="d ok">✓</span>
        <b>Worktree</b>
        <em>passed</em>
      </div>
      <div className="home-rail">
        <span className="d ok">✓</span>
        <b>Your tests</b>
        <em>passed</em>
      </div>
      <div className="home-rail">
        <span className="d bad">✕</span>
        <b>Second reviewer</b>
        <em>1 finding</em>
      </div>
      <div className="home-rail">
        <span className="d">↻</span>
        <b>Fix round</b>
        <em>what the fix changed is re-reviewed</em>
      </div>
      <div className="home-rail">
        <span className="d ok">✓</span>
        <b>Second reviewer</b>
        <em>passed</em>
      </div>
      <div className="home-rail">
        <span className="d bad">!</span>
        <b>Your tests, on a red base</b>
        <em>base is red</em>
      </div>
    </Mini>
  )
}

export function WaitingMini() {
  return (
    <Mini
      title="WAITING ON YOU"
      label="a waiting ticket: triage's reading of the cause and two answers, one recommended"
    >
      <div className="home-cause">
        <small>TRIAGE&rsquo;S READING</small>Review kept finding the same problem after the fix rounds.
      </div>
      <div className="home-ans rec">
        <div>
          <b>Continue from the saved work</b>
          <small>Keeps the commits so far</small>
        </div>
        <span className="tagrec">RECOMMENDED</span>
      </div>
      <div className="home-ans">
        <div>
          <b>Start again from base</b>
          <small>Throws the attempt away</small>
        </div>
      </div>
    </Mini>
  )
}

export function LandedMini() {
  return (
    <Mini short title="LANDED" label="a landed ticket with its cost, and its issue closed">
      <div className="home-srow">
        <span>#12 Fix a failing test</span>
        <b>$0.84</b>
      </div>
      <div className="home-srow landed">
        <span>landed · issue closed</span>
        <b>✓</b>
      </div>
    </Mini>
  )
}

export function SpendMini() {
  return (
    <Mini title="/SPEND" label="spend per ticket, one of them unknown, and today against the daily ceiling">
      <div className="home-srow">
        <span>Ticket A · 3 runs</span>
        <b>$2.10</b>
      </div>
      <div className="home-srow">
        <span>Ticket B · 1 run</span>
        <b>$0.74</b>
      </div>
      <div className="home-srow unk">
        <span>Ticket C · model unpriced</span>
        <b>unknown</b>
      </div>
      <div className="home-ceil">
        TODAY vs DAILY CEILING
        <div className="home-meter">
          <i />
        </div>
        new work stops at the ceiling
      </div>
    </Mini>
  )
}

export function LanesMini() {
  return (
    <Mini title="SEVERAL AT ONCE" label="three tickets running, two queued behind them, one landed">
      <div className="home-lanes-mini">
        <div>
          <small>RUNNING</small>
          <div className="blk">#12 docs</div>
          <div className="blk">#15 test</div>
          <div className="blk">#18 api</div>
        </div>
        <div>
          <small>QUEUED</small>
          <div className="blk q">#16 blocked by #15</div>
          <div className="blk q">#20</div>
        </div>
        <div>
          <small>LANDED</small>
          <div className="blk landed">#9</div>
        </div>
      </div>
    </Mini>
  )
}

export function EnvironmentMini() {
  return (
    <Mini
      title="THE AGENT’S ENVIRONMENT"
      label="what the agent is given: what the recipe allows, and none of Lingtai's own settings"
    >
      <div className="home-srow">
        <span>What your recipe allows</span>
        <b>passed</b>
      </div>
      <div className="home-srow">
        <span>Lingtai&rsquo;s own settings</span>
        <b>never</b>
      </div>
      <div className="home-srow">
        <span>Your Claude Code / Codex limits</span>
        <b>kept</b>
      </div>
      <div className="home-ceil">LINGTAI&rsquo;S FLAGS ONLY NARROW THEM</div>
    </Mini>
  )
}
