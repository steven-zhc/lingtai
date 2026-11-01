import { Bar, Foot, INSTALL_URL } from './chrome'
import { CopyCommand } from './copy-command'

export default function Home() {
  return (
    <>
      <Bar />
      <main className="home">
        <div className="wrap">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="kicker">For Claude Code and Codex</p>
              <h1 id="hero-title">Agents do the work. Lingtai keeps the books.</h1>
              <p className="lede">
                The agent writes the change. Your checks and a cold review decide whether it lands &mdash; and every
                ticket ends in a receipt you can check.
              </p>
              <div className="install">
                <CopyCommand command={`curl -fsSL ${INSTALL_URL} | sh`} />
                <p className="install-note">macOS and Linux &middot; runs on your machine &middot; no signup</p>
              </div>
              <div className="hero-actions">
                <a className="way-in" href="#setup">
                  Set up Lingtai <span aria-hidden="true">↓</span>
                </a>
              </div>
            </div>
          </section>

          <section className="home-setup" id="setup" aria-labelledby="setup-title">
            <div className="setup-lead">
              <p className="kicker">Start</p>
              <h2 id="setup-title">Three steps to your first receipt.</h2>
              <p>
                <a className="link" href="/docs/tutorial/">
                  The tutorial →
                </a>
              </p>
            </div>
            <ol className="setup-steps">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>Install and init</h3>
                  <div className="command">
                    <span>$</span> lingtai init
                  </div>
                </div>
              </li>
              <li>
                <span className="step-number">02</span>
                <div>
                  <h3>Write one ticket</h3>
                  <p>
                    A GitHub issue with a kind label, or <code>lingtai ticket new</code> on a local project.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>Start</h3>
                  <div className="command">
                    <span>$</span> lingtai start
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <p className="home-edges">
            Not a container &middot; one machine &middot; pre-1.0 &mdash;{' '}
            <a className="link" href="/docs/requirements/">
              what it does not do yet →
            </a>
          </p>
        </div>
      </main>
      <Foot />
    </>
  )
}
