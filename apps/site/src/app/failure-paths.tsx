import { FailurePathsStage } from './failure-paths-stage'

/**
 * Where each failure goes (#1265, #1291; the agreed mock `doc/design/smart-routing.html`). `ITEMS` is the one
 * source: the drawing is handed it, and the FAQ's table is mapped over it, so the two cannot disagree. Without
 * script the table is the whole of the paths.
 * The copy is written out as it is shown: `unit/failure-paths.test.tsx` holds every number in it to the
 * constant it states.
 */

type Item = {
  key: string
  say: string
  lane: 'rule' | 'look' | 'you'
  laneName: string
  what: string
  bound: string
  ext?: string
}

const ITEMS: Item[] = [
  {
    key: 'api',
    say: 'The API went down at 3am',
    lane: 'rule',
    laneName: 'Rule',
    what: 'It saved the half-done work, waited a minute, and redid the step from there. You never heard about it.',
    bound: 'At most 3 tries, after 1, 5, then 15 minutes. Then it asks you.',
    ext: 'Still down after the third wait? It stops, says which limit ran out and how many times it tried, and waits for you. The saved work is still there.',
  },
  {
    key: 'flaky',
    say: 'A test is flaky',
    lane: 'rule',
    laneName: 'Rule',
    what: 'Your checks went red. It ran them again on the same code, at once: green. It carried on, and noted the flaky test for you to look at later.',
    bound: 'One rerun only. Red twice means it is real, so the agent fixes it.',
    ext: 'Red twice: the agent fixes the code on top of its own work, up to 6 times. Still red: one closer look, then it asks you. If the approach looks wrong, it starts over from main instead, at most twice.',
  },
  {
    key: 'review',
    say: 'The reviewer found a bug',
    lane: 'look',
    laneName: 'One look',
    what: 'One quick look named the lines to change. The agent fixed them on top of its own work, and your checks and the review ran again.',
    bound: 'Up to 6 fixes. Then a fresh start, at most twice, or it asks you.',
    ext: 'Six fixes and still refused? One closer look. If the approach looks wrong, it starts over from main with a note on why, at most twice. Otherwise it stops and asks you.',
  },
  {
    key: 'unclear',
    say: 'The ticket is unclear',
    lane: 'you',
    laneName: 'You',
    what: 'It stopped before guessing and asked you. Your answer went into the ticket, and it carried on from where it paused.',
    bound: 'Up to 5 stops per ticket. Then it waits for you to decide.',
    ext: 'After 5 stops on one ticket it stops asking. You edit the ticket, close it, or give it another go. The agent never answers for you.',
  },
  {
    key: 'big',
    say: 'The ticket is too big',
    lane: 'look',
    laneName: 'One look',
    what: 'It ran out of time. One quick look split it into 3 tickets that run in order. When all three landed, your ticket checked its own list, line by line, and closed.',
    bound: 'Split once per ticket, into at most 8. A part that is still too big comes to you.',
    ext: 'A part ran out of time too. It is not split again: it stops and asks you how to cut it. The parts already landed stay landed.',
  },
  {
    key: 'main',
    say: 'Someone else changed main',
    lane: 'rule',
    laneName: 'Rule',
    what: 'Someone merged into main. It merged the new main into its work and ran your checks again, then landed.',
    bound: 'Up to 10 merges per try. Then it asks you.',
    ext: 'Main moved 10 times under one ticket. That is rare; it stops and asks you whether to try again.',
  },
  {
    key: 'limit',
    say: 'My Claude limit ran out',
    lane: 'rule',
    laneName: 'Rule',
    what: 'Nothing could start, so nothing was spent. It waited for your limit to reset, then carried on from the same place.',
    bound: 'Nothing to count: waiting is free. A limit with no reset, like a monthly cap, waits for you.',
  },
]

function QuestionCard() {
  return (
    <figure className="fp-ask">
      <div className="fp-ask-top">
        <span>
          <b>#1 · Add a reading-time badge</b>
          <small>WAITING ON YOU · 1 QUESTION</small>
        </span>
      </div>
      <ol>
        <li>
          <p>How are part minutes shown?</p>
          <ul>
            <li className="fp-rec">
              Round up: 4.2 minutes shows &quot;5 min read&quot;<small>SUGGESTED</small>
            </li>
            <li>Round to the nearest: &quot;4 min read&quot;</li>
            <li>Under one minute shows &quot;&lt; 1 min read&quot;</li>
          </ul>
        </li>
      </ol>
      <p className="fp-ask-own">Or write your own answer.</p>
      <div className="fp-ask-moves">
        <span className="fp-ask-btn">Send answer</span>
      </div>
      <figcaption>
        Up to 5 questions at a time, 2 to 4 choices each, the suggested one first. Each choice says what the agent will
        do.
      </figcaption>
    </figure>
  )
}

const LEGEND = [
  { lane: 'rule', bold: 'A rule', rest: ' handles most of it, free' },
  { lane: 'look', bold: 'one quick AI look', rest: ' handles some, for cents' },
  { lane: 'you', bold: 'you', rest: ' see only what needs a decision' },
]

export function FailurePaths() {
  return (
    <section className="fp" id="when-it-fails" aria-labelledby="fp-title">
      <div className="fp-head">
        <div className="fp-head-box" data-route-to>
          <h2 id="fp-title">Here is what happens when something breaks.</h2>
          <p className="fp-legend">
            {LEGEND.map((l, i) => (
              <span key={l.lane}>
                {i > 0 ? ' · ' : null}
                <span className={`fp-dot-key fp-${l.lane}`} aria-hidden="true" />
                <b>{l.bold}</b>
                {l.rest}
              </span>
            ))}
            . Every path has a limit.
          </p>
        </div>
      </div>

      <FailurePathsStage items={ITEMS}>
        <QuestionCard />
      </FailurePathsStage>
    </section>
  )
}

/** The seven paths as one table: the FAQ's first answer, and the whole of the section without script. */
export function FailurePathsTable() {
  return (
    <>
      <table className="fp-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who handles it</th>
            <th>What happens</th>
            <th>Limit, and past it</th>
          </tr>
        </thead>
        <tbody>
          {ITEMS.map((it) => (
            <tr key={it.key} data-key={it.key}>
              <th scope="row" className="fp-say">
                {it.say}
              </th>
              <td>
                <span className={`fp-lanetag fp-${it.lane}`}>{it.laneName}</span>
              </td>
              <td className="fp-what">{it.what}</td>
              <td>
                <b className="fp-bound">{it.bound}</b>
                {it.ext ? (
                  <>
                    <br />
                    <span className="fp-ext">{it.ext}</span>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fp-edge">If the quick look itself fails, it asks once more, then hands it to you and says so.</p>
    </>
  )
}
