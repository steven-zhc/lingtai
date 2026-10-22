# Discussion answers reach the current wait's destination

| | |
|---|---|
| **Problem** | Discussion can conclude into the next run prompt or the ticket body, but cannot add an answer to a fix list, a split, or the person's answer box. |
| **Want** | The destination offered under each wait matches the action it performs. |
| **Fix** | Add destination specific conclusion actions for fix lines, split tickets, and the current answer box. Connect each action to its own write path and show it only where that destination exists. |
| **Watch out** | `concludeChat` currently accepts `prompt`, `ticket`, and `none`; relabeling its ticket outcome would still write to the issue body. Preserve the distinction between a discussion trace and its recorded answer. |

## Evidence

`Discussion.dc.html` shows “Add as fix 5,” “Use as the split,” and “Use as my answer.” These have different destinations. `apps/board/src/app/discussion.tsx` offers only the two existing write destinations. #426 covers the Split action itself.

## Done when

- [ ] Each offered destination writes to the named place and has a test for that write.
- [ ] Unsupported destinations are absent until their write paths exist.
- [ ] Asking and concluding cannot purchase or record the same discussion turn twice.

Related: #532 supplies the presentation and #426 supplies the Split action.
