# The board

*What each column, the PR view and every key do*

The board is where you watch an attempt and choose when it waits on you. Its bar answers two questions and no third: *is anything waiting on me?* and *is the system doing what the code says?*

## The columns

A ticket sits in one of four columns, and a ticket is in exactly one at a time.

- **Queued**: open, not yet taken.
- **Running**: an attempt is working it now.
- **Waiting on you**: the attempt stopped where the recipe says a person decides. This is the column to open first. Automatic triage may resolve a wait and send the ticket back to work without you; otherwise it stays until you choose, and nothing is lost while it waits.
- **Landed**: the ticket is over. Most landed their change on the branch; one found already done, or one closed, shares the column and its row says which ending it was, so check the row before assuming a change was delivered.

## The PR view

Only a team project has it, because only a team project opens pull requests. Each pull request sits in one of five states, shown as a strip across the page.

- **Draft**: local work not yet submitted. No pull request exists on the host; the page offers Submit PR.
- **In progress**: an agent is still working.
- **Waiting on you**: it needs your answer.
- **In review**: with its reviewers.
- **Merged**: done.

## The bar and the footer

The bar carries three things: the filter, health and the headline. Health is green and silent until something is wrong, and then a sentence beside it names the fault and the command that fixes it. It reports how far the projections lag and whether the daemon is alive, not whether a connection is open. A banner under the bar names any lock that stops a project's work: a person's pause, the day's spend ceiling, or a runtime's usage limit.

The footer sits on the pages that read the log. It shows today's spend against the ceiling, the landed count, how current the projections are, and links to the report and spend pages.

## Keys

| Key | Where | What |
|---|---|---|
| `⌘K` / `Ctrl+K` | outside a field | open search |
| `⌘K` / `Ctrl+K` | in search | close it |
| `#` | outside a field | search a ticket or PR number |
| `G T` | outside a field | go to Tickets |
| `G P` | outside a field | go to PRs, team project only |
| `G S` | outside a field | switch project |
| `↑` `↓` | in search | move, wrapping round |
| `Home` `End` | in search | first, last |
| `Enter` | in search | open |
| `⌘Enter` / `Ctrl+Enter` | in search | open in a new tab |
| `Esc` | in search | close |
| `Enter` | in a discussion box | send |
| `Shift+Enter` | in a discussion box | new line |

`G` waits one and a half seconds for its second key. While search is open, `#` and `G` are off, and only its own keys apply. On a solo project `G P` does nothing.

The rule for all of them: no key is bound while focus is in an input, a textarea, a select or an editable element, so typing a `#` or a `G` into a field is only text. The discussion box's two keys are that box's own. None works while an input method is composing text. The palette also lists its keys in one line at its foot.

## Other pages

- `/spend`: what runs cost.
- `/report`: what each ticket cost and did.
- `/backlog`: the minor findings passing gates raised.
- `/recipe`: the recipe a project runs.
- `/setup`: the conductor's setup.

## Next

[Writing a ticket an agent can work](tickets.md)
