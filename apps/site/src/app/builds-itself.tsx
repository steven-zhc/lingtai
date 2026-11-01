/**
 * The *Lingtai builds Lingtai* card. `landed` is the snapshot's Landed lane
 * count, or `null` when there is no figure to print (no snapshot, or a lane of
 * zero): then the sentence stands alone, with no empty line under it.
 */
export function BuildsItself({ landed }: { landed: number | null }) {
  return (
    <article className="home-card home-six-card">
      <span className="home-ico" aria-hidden="true">
        ⟲
      </span>
      <h3>Lingtai builds Lingtai</h3>
      <p>
        Nearly all of the tickets closed in this repository, epics aside, were claimed, built, reviewed and landed by
        Lingtai itself. The board below is its own.
      </p>
      {landed === null ? null : <p className="home-figure">{landed} landed or closed on its board</p>}
    </article>
  )
}
