# 0121 — The CLI: what a command prints, what `--json` promises, and where help comes from

**Status** accepted · 2026-10-25

Every `lingtai` command prints in one layout, in the board's colours, and
reads the same without colour. Every command that only reads takes `--json`
and then prints one versioned document and nothing else. Help is not
written by hand: a command's definition is the one source for `lingtai --help`,
`lingtai <command> --help` and the site's CLI page.

## Context

`apps/cli/src/lingtai.ts` grew its commands one at a time, and each chose its
own prose. A script that wants to know what is runnable reads `lingtai status`
and parses sentences, so rewording a line breaks it. Help is a hand-written
string, `USAGE`, that is maintained separately from the commands it describes
and from the page on the site. `lingtai.ts` says argument parsing is
hand-rolled until a specific failure demands a library; these are the
failures: prose that scripts parse, and help that drifts.

The palette already exists. `packages/env/src/colour.ts` is "the board's
vocabulary, not a second one", and `coloured()` there is already the one place
that decides whether to emit escape codes. What is missing is a rule for
using them in a terminal.

## Decision

1. **Layout.** A command's output is, in order: a heading line (the thing and
   its name), then sections grouped by subject, then — when something can be
   done next — one closing line that starts `next:` and names the command to
   run. Inside a section, facts that are one value each are an aligned
   key/value block; facts that repeat are a table with a header row. Each line
   is one fact. A command that has nothing to say says so in one line and
   exits 0.

   **`doctor`'s default view, and the report `init` shows after setup, is the
   exception: a flat list of what to fix, with no sections.** The heading is
   followed by a counts line (`N to fix · K passed · …`, or `all K passed · …`),
   then one block per thing to fix — failures first, then warnings, each in
   area order, and a check that was not run here left out. A block is a title
   line, the first line of the detail, and its `fix` lines; blocks whose fix is
   the same are drawn once, under one title. `next: lingtai doctor --verbose`
   closes `doctor`'s view when something warned or failed. `--verbose` keeps
   the sections.

   **Every line of that view starts in a label column**, right-aligned to the
   widest label, so a reader scans one edge to know what each line is:
   `PROBLEM` on a title, `FIX` on the first fix line, `NOTE` on an `info` row,
   `NEXT` on the closing line; detail and continuation lines leave the column
   blank. The heading and the counts line stay flush left; the column starts
   at the first block. A failing title keeps its `✗` after the label
   (`[problem] ✗ environment · store and log`); a warning has none, so plain
   mode tells the two apart (§3). The title carries its area tag at the end,
   `muted`. In this view
   alone the closing line is the `NEXT` label and the command, in place of
   `next:`; `init`'s own closing line after the report keeps `next:`.

2. **Symbols and colour come from `packages/env/src/colour.ts`; this ADR adds
   glyphs and labels, and no new hue.** Each glyph is drawn in an existing
   `paint` key and means one thing:

   | glyph  | `paint`  | meaning                          |
   | ------ | -------- | -------------------------------- |
   | ✓      | `pass`   | passed                           |
   | ✗      | `fail`   | failed                           |
   | !      | (none)   | needs attention, nobody is waiting on you (`--verbose` only) |
   | ●      | `signal` | waiting on you, and nothing else |
   | (none) | `held`   | held by a person                 |
   | (none) | `accent` | headings and running things      |
   | (none) | `muted`  | ids, clocks, hashes, and the area tag on a thing to fix |

   **A label is a word drawn as a badge**: the word, padded by one space each
   side, on a background. The backgrounds are the existing hues and no others,
   kept in `colour.ts` beside `paint`:

   | label     | badge                                   | meaning                         |
   | --------- | --------------------------------------- | ------------------------------- |
   | `PROBLEM` | `fail`'s red as the background          | a check failed                  |
   | `PROBLEM` | reversed, no hue                        | a check warned                  |
   | `FIX`     | `accent`'s cyan as the background       | the command that resolves it    |
   | `NOTE`    | padded like the others, no background, `muted` | true, and nothing to do  |
   | `NEXT`    | `pass`'s green as the background        | the one command to run next     |

   The fix command itself is drawn in `accent`, and so is the command after
   `NEXT`. Everywhere else green is an outcome — something passed or went
   right; `NEXT` is the one place it marks something not yet done. It is the
   last line of the view and is never on a check's title line, so it cannot be
   read as a check's verdict. Amber is never a badge. In
   plain mode (§3) a label is the same word in brackets and lower case
   (`[problem]`, `[fix]`, `[note]`, `[next]`), so its meaning survives with no
   escape codes.

   A state takes its colour from `stateInk` in `colour.ts`, not from a list
   here. Amber is `signal` and "nothing else may use this" (`colour.ts`): a
   command never draws amber for a thing that is not waiting on a person.
   A line for a wait says what is asked, in the words of 0118. The labels
   are in the table above; `doctor`'s default view draws no `!` — a warning is
   carried by its badge, its words and its place after the failures.

3. **Colour is never the only carrier of a meaning.** The glyph and the words
   carry it; colour repeats them. So plain output is the same text with no
   escape codes — not a different layout. Plain mode is on under `NO_COLOR`,
   `TERM=dumb`, `--no-color`, or when the stream is not a TTY; it is decided
   in `coloured()`, in that order, and no command decides it for itself.
   `--no-color` is `NO_COLOR` for that process, so it beats `FORCE_COLOR` for
   the reason `NO_COLOR` does. The glyphs stay in plain mode: they are text,
   not escapes, and alignment stays.

4. **Width.** Output is readable in a narrow terminal, without colour, and when
   redirected. A line is never wrapped by the command. Where `columns` is
   narrower than a table, each row is printed as a key/value block instead. A
   redirected stream has no width and is never truncated to one. A cap on how
   long one fact may be (`oneLine` in `status.ts`) is a rule about content, not
   about width, and stays.

5. **`--json`.** Every command whose definition says it only reads takes
   `--json`. Under it, stdout carries exactly one JSON value and nothing else
   — no prose, no progress lines — with no colour and no prompts. The top
   level is `{ "version": 1, "command": "<name>", … }`; `version` belongs to
   that command's shape, and adding a field does not change it. A failure is
   still one document on stdout,
   `{ "version": 1, "command": "<name>", "error": { "code": "…", "message": "…" } }`,
   with a non-zero exit, so a script needs one parser and one exit code.
   stderr is for people and is never parsed.

   **A command that changes state and answers with a verdict takes `--json`
   too** (#621): the _waiting on you_ group and `now`. Its document reports
   the verdict and not the state: `outcome` is `"accepted"` or `"refused"`,
   `reason` carries the refusal's code where the function that refused names
   one (and is left out otherwise, never `null`), and `detail` is the sentence
   the text form prints. A refusal is an outcome and exits non-zero as it
   always did; the `error` document stays for a command that could not run — a
   usage error, or a handler that threw. Whatever such a command writes along
   the way (the projector's warnings, the line `approve` prints as it
   resolves) goes to stderr under `--json`. The text form is one verdict line,
   `✓ approved <ticket>` or `✗ not approved (<reason>)`, the old sentence
   beneath it, and `next:` only where that sentence already named a command.

   **A read-only verb of a `changes` command takes `--json` too** (#623):
   `board status`, `ticket list`, the listing `backlog [<project>]`, `env list`
   and `projection lag` today, whose `command` is `"board status"`,
   `"ticket list"`, `"backlog"`, `"env list"` and `"projection lag"` so no
   other verb of the same command can be mistaken for them. A command that
   follows a stream (`attach`) is not a report and takes no `--json`; its lines
   are the run's own (0034 §8). Its three facts — who serves, whether a
   board answers, whether a supervisor keeps one — each carry `{ "unread": … }`
   in their own key when that fact could not be read; the `error` document is
   for a handler that could not run at all.

6. **A command's definition is the one source for its help.** Each definition
   carries its group, a one-line task, whether it only _reads_ or _changes_
   something, and one or two examples. `lingtai --help`,
   `lingtai <command> --help` and `doc/cli.md` are all generated from those
   definitions, and `doc/cli.md` is what the site's CLI page shows. For a
   command that only _reads_, the `reads`/`changes` marker is what decides
   whether it takes `--json` (clause 5); a `changes` command that answers
   with a verdict takes it as clause 5 says. A command that changes
   something but has a subcommand that only reads (`service status`) takes
   `--json` on that subcommand alone (#622).

7. **Help groups.** `lingtai --help` lists commands in four groups, each
   command in exactly one:

   | group              | commands                                                                            |
   | ------------------ | ----------------------------------------------------------------------------------- |
   | everyday           | `add`, `run`, `status`, `now`, `attach`, `backlog`, `report`, `ticket`, `board`, `env`, `end` |
   | waiting on you     | `approve`, `answer`, `ask`, `grant-fix-round`, `requeue`, `close`                   |
   | daemon             | `start`, `daemon`, `service`, `restart`, `shutdown`, `pause`, `resume`              |
   | install and upkeep | `init`, `version`, `upgrade`, `rollback`, `uninstall`, `doctor`, `projection`       |

   _Waiting on you_ holds the commands that answer a wait of 0118.

8. **Help needs no project and no network.** `help`, `--help` and
   `<command> --help` are answered from the command definitions alone, before
   `cli.ts` is imported — the same position as the commands `entry.ts`
   answers before the log is loaded — so they work with no project
   configured, no database and no network. `--help` anywhere in the arguments
   prints that command's help, does nothing else, and exits 0: it is a
   question, never an instruction.

9. **Libraries.** `@effect/cli` parses arguments and holds the command
   definitions (0101: Effect where configuration is read and something is
   acquired). `@clack/prompts` asks the questions. A prompt never appears
   without a TTY: every question has a flag, and when there is no terminal and
   no flag the command refuses by name, saying which flag would answer it.
   Under `--json` there are no prompts at all.

10. **Output only writes; the command owns the process.** A spinner, a
    progress line or anything else that draws output never reads stdin, never
    puts it in raw mode, never installs a signal listener and never calls
    `process.exit`. In raw mode Ctrl+C stops being `SIGINT` and arrives as a
    byte, so a command's own handler — `restart`'s drain, `service
shutdown`'s withdrawal — never runs; a library's own `SIGINT` listener
    that exits ends the process before that handler's asynchronous work has
    landed. Either way the cleanup is skipped and the exit code lies. The
    spinner is `ora` with `discardStdin: false` and `hideCursor: false`, which
    leaves it nothing but writing; `@clack/prompts`' `spinner`,
    `yocto-spinner` and `nanospinner` each take Ctrl+C for themselves and are
    not used. A prompt is the one exception, because asking is reading: while
    a question is open nothing is in flight to clean up, and clack hands a
    cancel back to the caller rather than exiting.

## Consequences

- The hand-written `USAGE` in `lingtai.ts` is deleted when this is built, not
  edited, and so is the comment there that argument parsing is hand-rolled.
  Done (#626): `lingtai.ts` holds one import of `entry.ts`, the file a supervisor's unit names.
- Neither library is a dependency of `apps/cli` today; adding them is part of
  building this.
- A test generates `doc/cli.md` and fails when the checked-in copy differs, so
  help, the file and the site cannot disagree.
- A script reads `--json`, never prose; rewording a human line is not a
  breaking change, removing or retyping a JSON field is.
- Because the palette is the board's, a state looks the same in the terminal
  and on the board, and a change to it is one edit in `colour.ts`.

## Example

`lingtai status` today, reconstructed from `apps/cli/src/status.ts` rather than
run against a log:

```
lingtai  base=main
  recipe 3f2a91c  branch main
  kinds: bug, tech-debt, feature, documentation
  from GitHub: 3 eligible
  dependencies unread: none
  #612  bug      runnable
  #615  feature  passed over: agent:hold
```

After this decision:

```
lingtai

Project
  base      main
  recipe    3f2a91c
  kinds     bug, tech-debt, feature, documentation

Queue  3 eligible, from GitHub
  ID    KIND      STATE
  #612  bug       runnable
  #613  feature   runnable
  #615  feature   passed over — agent:hold

Waiting on you
  ● #609  asks which of two approaches to take

next: lingtai answer lingtai --issue 609 "<choice>"
```

`#612`, `#613`, `#615` and `3f2a91c` are `muted`; `●` is `signal`; the headings
are `accent`. Redirected, it is the same text with no escape codes. With
`--json`:

```json
{
  "version": 1,
  "command": "status",
  "projects": [
    {
      "project": "lingtai",
      "base": "main",
      "filter": { "ok": true, "recipe": "3f2a91c", "kinds": ["bug", "tech-debt", "feature", "documentation"] },
      "source": "GitHub",
      "eligible": 3,
      "passedOver": [{ "ref": "#615", "reason": "agent:hold" }],
      "dependenciesUnread": false,
      "runnable": [
        { "taskId": "t1", "ref": "#612", "kind": "bug", "restarts": 0 },
        { "taskId": "t2", "ref": "#613", "kind": "feature", "restarts": 0 }
      ],
      "byState": { "waiting": [{ "taskId": "t3", "ref": "#609" }] }
    }
  ]
}
```

_New topic; replaces no archived ADR. The design discussion is #615._
