# 0038 — An extension declares what it is given, and that is the whole of what it gets

**Status** accepted · 2026-09-10 · closes
[0037](0037-an-extension-is-a-command.md)'s *"Credentials per extension"*; adds
nothing to [0021](0021-the-recipe-decides-the-environment.md)'s layers

## Context

0037 §1 separated the two meanings of "untrusted" and settled the first one:

> | the extension's **code** | **no** | it can hang, exit, leak, or read
> `LINGTAI_DATABASE_URL` | it runs in its own process, on a clock, with its own
> credentials |

and then left the last third of that sentence open:

> **Credentials per extension.** §1 says an extension gets its own rather than
> the daemon's. Where they are declared, and how a Telegram bot token reaches
> the process without reaching every other one, is not designed.
> `~/.lingtai/env/` and [0021](0021-the-recipe-decides-the-environment.md)'s
> layers are where it should start.

It matters as soon as there are two extensions. A notifier that needs nothing
and a Telegram bot that needs a token cannot share an environment without the
first one holding the second's token — and "the daemon's environment, minus a
denylist" is the shape that has already failed here twice: `RESERVED` in 0021,
and the unprefixed `DATABASE_URL` of `#63`. A denylist is a list somebody has to
keep correct, and the first name it misses is the one nobody thought of.

## Decision

### 1. The subscriber declares the names, and the names are all it gets

```yaml
subscribers:
  - name: telegram
    on: [WorkItemLanded]
    run: npx @lingtai/telegram
    env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
```

`env:` is 0021's `required` narrowed to one process: **a check, not a filter.**
Naming a variable says this extension needs one, and a name neither file
supplies stops the command being started at all — rather than starting it and
watching it fail on an HTTP 401 two minutes later, about a variable nobody
thought was missing.

There is no `allow`/`deny` pair here and there should not be. A subscriber's
whole environment is short enough to write out, and the pair exists in `env:` at
the recipe's top level because a project's *agent* inherits two whole files.

### 2. The values come from the layers that already exist

The machine's env file minus everything of Lingtai's own, then
`~/.lingtai/env/<project>.env` over it — 0021's layers 2 and 3, unchanged, and
the same read `resolveAgentEnv` does. So a bot token is set with

    lingtai env set <project> TELEGRAM_BOT_TOKEN

and lives beside that project's other values rather than in a location invented
for extensions. **Nothing new was built for this**, which is the same instinct
0037 §2 applied to `run:`.

Layer 1 (`PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `LOGNAME`) is added, because a
process cannot be a process without it and the alternative is every extension
dying on `sh: node: command not found`.

### 3. Built, not inherited — and that is what makes the guarantee structural

The extension's environment is **constructed**. The daemon's `process.env` is
not passed through, so `LINGTAI_DATABASE_URL`, the GitHub App key and whatever
is exported in the terminal the daemon was started from are not there to be
read. This is the difference from a denylist: there is no list, and therefore
no line missing from one.

Two things then say the same thing at two altitudes, and both are worth having:

- **The schema refuses a `LINGTAI_` name in `env:`** — loud, at the moment
  somebody writes it, naming the key. This is what tells a person *why* nothing
  arrived.
- **`extensionEnv` never has one to hand over**, because `isMachineOwn` strips
  the prefix from the machine's file. This is the one that survives somebody
  editing the other.

`#63`'s prefix is what lets the second be one rule instead of a list.

## Consequences

- **An extension cannot read the log.** It was never given a connection string
  and there is no capability to ask for one. 0037's line — *"reading the log is
  a **capability**, which an extension would have to be granted by name"* — is
  still where the next argument is, and nothing here grants one.

- **A project's own file is the sharing boundary.** Two extensions declared by
  the same project can both name `TELEGRAM_BOT_TOKEN` and both get it. That is
  correct: they are the same operator's, on the same repository, and a
  per-extension secret store would be a second thing to configure for a
  distinction nobody has asked for. Two *projects* are already separate, because
  layer 3 is per project.

- **An extension that wants a value the operator has not set fails loudly and
  keeps failing.** `PluginFailed` is appended on every matching event until
  somebody sets it, and `lingtai doctor` counts them. That is why this
  repository ships `telegram` declared but commented out: a subscriber
  configured with no credentials is a warning that means nothing by the second
  day.

## Open

- **A secret source.** 0021's layer 4 — `TOKEN=!op read op://…` — is still not
  built, and an extension's token is exactly the kind of value somebody will
  want to keep in 1Password rather than in a file. `parseEnvFile` already keeps
  those lines apart rather than planting them literally, so the refusal is
  honest; the layer is not.

- **The gate action's side.** This decides what a *subscriber* is given. A gate
  action still runs with the agent's filtered environment, which is the
  project's whole `required` set — wider than it needs to be for, say, a
  vulnerability scanner. Narrowing it is the same `env:` key on the same shape,
  and is not done here because nothing has needed it yet.
