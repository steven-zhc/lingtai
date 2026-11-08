/**
 * Step 2 of adding a repository: reading it (#971 replaces this). Until then
 * it names the choice step 1 made and prints the command that does the rest.
 */
import { Bar } from '@/app/bar.tsx'

export const dynamic = 'force-dynamic'

export default async function Read({ searchParams }: { searchParams: Promise<{ repo?: string; path?: string }> }) {
  const params = await searchParams
  const target = params.repo ?? params.path ?? ''
  const flag = params.path !== undefined ? '--local ' : ''
  return (
    <main className="detail">
      <Bar project={undefined}>
        <span className="sep" />
        <span className="mono">repository</span>
      </Bar>
      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">{target === '' ? 'nothing chosen' : target}</span>
          </h2>
          {target === '' ? (
            <p className="note">
              Nothing was chosen. <a href="/setup/repository">Choose a repository</a>.
            </p>
          ) : (
            <p className="note">
              Reading it happens in the terminal for now:{' '}
              <code>
                lingtai add {flag}
                {target}
              </code>
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
