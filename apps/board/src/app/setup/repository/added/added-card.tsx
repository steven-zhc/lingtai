/**
 * Step 3 of adding a repository, drawn from plain props (#972).
 *
 * Pure for #101's reason: every state this page can be in — nothing added, a
 * stale link, an unreadable log, a recipe that no longer parses, the whole
 * card — is a claim about markup, and `page.tsx` is the reads and nothing else.
 */
export type Added =
  | { state: 'none' }
  | { state: 'unregistered'; project: string }
  | { state: 'unreadable'; project: string }
  | {
      state: 'registered'
      project: string
      recipe: string
      /** The recipe as read, or the reason it could not be. */
      read:
        | { ok: true; kinds: string[]; held: string[]; owner: string | null; github: boolean }
        | { ok: false; problem: string }
    }

/** A shell word: bare when it needs no quoting, single-quoted otherwise. */
const shellWord = (w: string) => (/^[A-Za-z0-9._/@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

const Stepper = () => (
  <ol className="wiz-steps">
    <li className="done">✓ Repository</li>
    <li className="done">✓ Read and decide</li>
    <li className="on">3 Added</li>
  </ol>
)

const Labels = ({ names }: { names: string[] }) => (
  <>
    {names.map((n) => (
      <span key={n} className="wiz-tag mono">
        {n}
      </span>
    ))}
  </>
)

export function AddedCard(props: Added) {
  if (props.state === 'none') {
    return (
      <p className="note">
        Nothing was added. <a href="/setup/repository">Choose a repository</a>.
      </p>
    )
  }
  if (props.state === 'unregistered') {
    return (
      <p className="note">
        <span className="mono">{props.project}</span> is not registered.{' '}
        <a href="/setup/repository">Choose a repository</a>.
      </p>
    )
  }
  if (props.state === 'unreadable') {
    return (
      <p className="note wiz-fail">
        The log could not be read, so whether <span className="mono">{props.project}</span> is registered is not known.
        Reload to try again.
      </p>
    )
  }

  const { project, recipe, read } = props
  const p = encodeURIComponent(project)
  const ticket =
    read.ok && read.github && read.owner !== null
      ? `https://github.com/${encodeURIComponent(read.owner)}/${p}/issues/new`
      : null

  return (
    <div className="wiz-added">
      <Stepper />
      <h3 className="wiz-title">
        <span className="mono">{project}</span> is added
      </h3>
      <ul className="wiz-list">
        <li>
          <span className="wiz-ok">✓</span> recipe written — <code>{recipe}</code>
        </li>
        <li>
          <span className="wiz-ok">✓</span> registered
        </li>
      </ul>
      {read.ok ? (
        <p className="note">
          Lingtai takes an issue with a kind label — <Labels names={read.kinds} />
          {read.held.length > 0 ? (
            <>
              {' '}
              — and none of <Labels names={read.held} />
            </>
          ) : null}
          .
          {ticket === null ? (
            <>
              {' '}
              Tickets here are Lingtai's own: <code>lingtai ticket new --project {shellWord(project)}</code> opens one.
            </>
          ) : null}
        </p>
      ) : (
        <p className="note wiz-fail">The recipe could not be read: {read.problem}</p>
      )}
      <div className="wiz-foot">
        <a href={`/recipe/${p}/edit`}>Edit the recipe</a>
        {ticket !== null ? (
          <a className="wiz-primary" href={ticket}>
            Open the first ticket →
          </a>
        ) : null}
      </div>
    </div>
  )
}
