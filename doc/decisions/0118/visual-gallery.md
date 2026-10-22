# Waiting visual acceptance

From the repository root, run `pnpm --filter @lingtai/board dev` and open
`http://localhost:17820/dev/waiting` (or the port configured by `board.port` or
`LINGTAI_BOARD_PORT`). This development-only gallery uses the production `Card` and
`TaskBody`, the board stylesheet and fonts, and the wait event fixtures shared
by the unit tests. It reads no live issue or event log, starts no triage, and
cannot submit a resolution. The previews are inert, and the gallery frames
disable scripts. These routes return 404 outside development and are absent
from normal navigation.

Each case has two direct URLs:
`/dev/waiting/<case>/card` and `/dev/waiting/<case>/task`. Cases are
`no-triage`, `questions`, `fixable-lines`, `conflicting-hunks`,
`triage-failed`, `triage-running`, and `resolution-cards`. The last case shows
the available moves drawn by the real `Standing` component.

Capture the card at a **440 px viewport** and the task page at **1200 px** to
compare with [Main.dc.html](Main.dc.html) and [Hold.dc.html](Hold.dc.html).
Capture both at **390 px** as the narrow check. Use the same browser, zoom,
color scheme, and viewport height for before and after screenshots. Link the
screenshots and the case URLs from later visual tickets. The clock is fixed at
2026-08-31 16:00 UTC; issue text, costs, and times in the references are
illustrative. The [ADR](../0118-a-hold-explains-itself.md) decides behavior.
