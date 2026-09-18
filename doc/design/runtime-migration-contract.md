# Runtime configuration migration (#201)

This implements the migration in [agent-runtimes.md §7](agent-runtimes.md#7-旧配置迁移)
and the ownership decision in [ADR 0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md).
It moves configuration only. Codex execution and per-role dispatch remain the
adapter and integration tickets in [the implementation plan](agent-runtimes-plan.md).

## Commands

```sh
lingtai migrate-runtime                 # preview only
lingtai migrate-runtime --dry-run       # same preview
lingtai migrate-runtime --apply         # explicit writes
lingtai upgrade --migrate-runtime --dry-run
lingtai upgrade --migrate-runtime --apply
lingtai migrate-runtime --agent app=codex       # explicit choice for an old ambiguous project
lingtai migrate-runtime --agent app=codex --apply
```

The upgrade forms run the configuration migration; binary upgrades still use
the ordinary `lingtai upgrade` command. Help works before database configuration.
Preview/apply require the configured event log so membership comes from all
registered and pending onboarding project streams, rather than guessed directories.
Pending projects already have files from the old wizard; migrating them releases
Recheck's recipe read without registering or activating them. A failed registry
read refuses migration. Neither command claims work, appends events, starts a
conductor, nor invokes a model. Missing agent choices can probe CLI login status.

Paths use `LINGTAI_HOME`, defaulting to `~/.lingtai`. Preview reads every project
recipe and `config.yml` before planning, shows field values and source paths,
and lists all unresolved projects. It creates no directories, locks, backups or
journal and never prints database credentials or whole machine file contents.
Exit codes are 0 for success, 1 for unresolved inputs/apply failures, and 2 for
invalid arguments. Dry-run is the default; `--apply` and `--dry-run` are exclusive.

## Preserved choices

For each legacy project, recorded project machine values win over global
machine values, by field. Existing recipe/preset choices are preserved; a
different recorded value reports both sources and refuses the entire apply.
Missing limits use existing recipe declarations and then old defaults: Claude
300 turns, 2h wall, 2 fix rounds and 0 restarts. Codex receives no manufactured
turn limit; any explicit or inherited Codex turn bound remains visible and
refuses migration until the user explicitly adjusts its source.

Missing agents use a recipe declaration or exactly one signed-in runtime.
Zero or multiple signed-in runtimes require an explicit migration choice via
`--agent <project>=<agent>` (repeat the flag for different projects). This input
is distinct from a new recipe declaration, so resolving ambiguity still
materializes old discussion and limits. It cannot replace a different recorded
machine, recipe or journal choice. Invalid, duplicate and unknown project flags
refuse. Preview remains read-only; rerun with the same flags and `--apply`.
Model-only presets retain their model when the detected agent is materialized.
Review inherits the migrated top-level runtime unless its recipe already
declares an override. Legacy discussion is explicitly Claude Code, 40 turns,
5m wall, independent of development limits. Conflicting discussion choices
also refuse instead of being overwritten. Discussion declarations are expanded
from presets before conflict checks. Materializing a role retains its declared
model and other fields, because a new role block replaces its preset wholesale.

An already configured recipe with no applicable legacy machine source is left
byte-for-byte unchanged, including its discussion/review intent. A missing or
invalid registered recipe refuses all writes. Recorded scoped choices for an
unregistered project refuse cleanup so they cannot be silently lost. Global
choices with no registered recipients also refuse cleanup.

Only global/scoped machine `agent` and `limits` are removed. Assignees, ports,
database/auth settings, other machine fields, recipe comments and unrelated
recipe fields are preserved. Machine YAML aliases that would change unrelated
settings during cleanup must be expanded by the user first.

## Writes and recovery

Apply takes the existing `lingtai:daemon` file lock. A running conductor or
another migration refuses it; stop/drain the conductor before retrying. Apply
replans under this lock, so its earlier preview is not permission to overwrite
newer input. It creates:

| Path under the state directory | Purpose |
|---|---|
| `migrations/runtime-v1.json` | Versioned journal with membership, original/planned bytes, recorded agent choices and completion |
| `migrations/<transaction UUID>/<file index>.bak` | Original contents of each changed existing file |

The journal and backups are 0600. Each write uses an exclusive 0600 temporary
file beside its target, flushes it, renames it atomically, and flushes the
directory. Owned temporary files are cleaned on ordinary failures. A process
killed before rename may leave an unused UUID `.new` file; it is never mistaken
for configuration or reused. Existing backups with different contents refuse
instead of being overwritten.

The journal is durable before backups or recipe mutations. Each recipe is read
back and parsed. All recipes and registry membership are checked again before
the final machine cleanup. Machine bytes are read back and parsed before the
journal is marked complete. Thus partial project writes retain the old machine
source. Runtime resolution refuses *any* remaining legacy machine fields or
unfinished migration journal and names migration as the remedy, including
fields scoped to another project and unfinished migration project names.

After interruption, rerun preview and then apply. Original or planned bytes are
accepted for every file; outputs already written are validated and skipped.
The original transaction and backups are reused, and a journaled detection is
not repeated if login availability changed. Intervening edits, changed project
membership or changed presets refuse automatic recovery; restore the original
or planned bytes/membership before resuming. If cleanup finished before the
completion marker, the same journal safely finishes. Repeating a completed
migration produces no duplicate YAML or replacement backups. A later migration
uses a fresh transaction directory.

## New configuration paths and validation

`resolveLocalRecipe` reads agent/model/limits solely from the project recipe or
its preset; it never falls back to legacy machine settings. `machineFiles`
keeps generated agent/limits in that recipe and only moves explicitly written
assignees to the machine file. Existing machine assignees are never copied from
the resolved recipe into a new override. Onboarding and editing refuse legacy
machine sources first. `init` verifies availability without creating or
replacing a global agent choice. Role selection UI belongs to #206.

Tests use temporary homes, scripted registry/login readers and the memory event
store. Fixtures cover source precedence, conflicts, missing/ambiguous choices,
unsupported Codex turns, fixed legacy discussion, comments, backup modes,
read-back corruption, membership changes, lock refusal and interruption both
before and after machine cleanup. CLI tests check read-only defaults, error
codes, credential omission and help without event-store initialization. New
onboarding is tested through the real file writer with memory events; no test
migrates the user's home, calls a model or needs Postgres for these checks.
