/**
 * `askRecipe` (#431, #432): every recipe question `init`'s local branch and
 * `lingtai add`'s GitHub branch both ask.
 *
 * **Two files, two shapes.** An existing file is edited through the draft:
 * every answer lands in memory and `applySetup` (#968) is the one writer. A
 * refusal leaves the disk as it was; a Ctrl+C keeps what was answered (#392
 * decision 1), because the caller is handed the draft through `onDraft` and
 * writes its changes when interrupted (`first-project.ts`). An absent file is created once:
 * the first four sections' answers are collected rather than written as they
 * are given, reduced in with the caller's own `seeds`, and handed to
 * `setRecipe` in a single call, with a comment above every block (`SAID`,
 * below) — #395's rule that a new file is written once, by whoever collects
 * every first-run answer.
 *
 * **In order:** `askAgents`, `askInstallAndBuild` (with the caller's
 * `tryBuild`, which runs the repository's own commands once and spends machine
 * time, never money, #436), `askTickets`, `askKinds` — these four are
 * where the two shapes differ — then, once the file is known to exist (on
 * disk already, or just created), `askLanding`, `askLimits`.
 *
 * **This asks; it does not probe.** `at.runtimes` is already probed
 * (`AskAgentsAt`'s own rule, `agents.ts:108`), and `at.reader` is already
 * built for wherever the file lives — a local directory or a GitHub ref.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { type RateRow, shipped } from '@lingtai/domain/rate-card'
import { codexTextConfig, type CodexTextConfig } from '@lingtai/env'
import { draftRecipe, recipePath, type RecipeDraft } from '@lingtai/project'
import { readJson, snapshotPath } from '@lingtai/projector'
import { assigneeChanges, branchOf, findingsJudgeChanges, type RecipeChange, resolveSource } from '@lingtai/recipe'
import { type Answers, ENV_PLANT_AT, SAID, type SetupReader } from '@lingtai/setup'
import { defaultPersonalBranch, type Proposal, type RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'

import { askAgents } from './agents.ts'
import { recovering } from './exit.ts'
import { askLanding, askLimits } from './landing.ts'
import { acceptingDefaults, questionEffect, type QuestionWorld } from './question.ts'
import { askSandbox } from './sandbox-step.ts'
import { type AskInstallAndBuildInput, type TrialOutcome, askInstallAndBuildEffect } from './setup-build.ts'
import type { LeftBehind } from './setup-card.ts'
import { askKinds, askTickets } from './source.ts'
import { askLogin, askMode, askPersonal, GITHUB_LOGIN, type Mode } from './team.ts'

/**
 * What a refusal inside `askRecipe` says was kept, for `lingtai add`'s
 * GitHub branch: by the time any of these questions is asked, each earlier
 * answer is already in the recipe, and none of it is undone — what has not
 * happened is the registration.
 */
export const ADD_KEPT = 'Nothing was written and nothing was registered'

export { ENV_PLANT_AT, SAID }

/** Whether `tool` is an existing file in a directory on this process's PATH. */
function toolOnPath(tool: string): Promise<boolean> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  const names = process.platform === 'win32' ? [tool, `${tool}.exe`, `${tool}.cmd`] : [tool]
  return Promise.resolve(dirs.some((dir) => names.some((name) => existsSync(join(dir, name)))))
}

export interface RecipeAt {
  project: string
  /** Handed the draft the answers land in, once it is read — so an interrupted run can write what was answered. */
  onDraft?: (draft: RecipeDraft) => void
  /** A local project is never asked where its tickets come from (`askTickets`'s own rule). */
  local: boolean
  /** Already probed — this function never probes on its own. */
  runtimes: readonly RuntimeFound[]
  /** The `codex_text` route (#1476): whether a new recipe may name Codex as its discuss agent. Absent, this machine's own file is read. */
  codexText?: () => CodexTextConfig | undefined
  reader: SetupReader
  flags: Readonly<Record<string, string>>
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[]
  defaultBranch: () => Promise<string | null>
  /**
   * What `proposeSetup` read: its values are the questions' fallbacks. A value
   * the file already has still wins — this replaces only what would have been
   * invented. Absent in a test that wants the plain defaults.
   */
  proposal?: Proposal
  /** The trial run (#436) — absent where there is no checkout to cut, and `setup-build.ts` then says so. */
  tryBuild?:
    | AskInstallAndBuildInput['tryBuild']
    | ((draft: RecipeDraft) => NonNullable<AskInstallAndBuildInput['tryBuild']>)
  /** `ticket-<project>-*` streams already in the log for this project — #396's `askTickets`. */
  history: (project: string) => Promise<readonly string[]>
  /**
   * The caller's own first-run answers — `branch.main`/`repo.remote`/`env.plantAt`
   * for a local project, `branch.main`/`env.plantAt` for a GitHub one. Written as
   * their own `setRecipe` call when the file already exists; reduced into the
   * one creation write, alongside this function's own four sections' answers,
   * when it does not (#432).
   */
  seeds: readonly RecipeChange[]
  /** `question.ts`'s `kept` — what a refusal after a write says is already written. */
  kept: string
  /**
   * What a refusal says before any write this function makes — the absent
   * path's first four questions reach no written file yet, so a refusal
   * there must say what was true before this call, not `kept` (#432).
   */
  keptBeforeWrite: string
  /** The command that changes what the summary shows — `lingtai add --local <dir>`, `lingtai add <owner>/<repo>`. */
  again: string
  home?: string
  /** The prices fetched onto this machine, `null` where the file is there and cannot be read; defaults to the real snapshot, which under a test reads as none unless it has its own `LINGTAI_HOME` (#693). */
  rates?: () => readonly unknown[] | null
  /**
   * The mode, where the caller already decided it (`runLocalBranch` asks before it makes the branch, 0130 §2).
   * Absent, this asks, with the recipe on disk's own mode as the default (#1474).
   */
  mode?: Mode
  /** What team mode needs from the machine; only a GitHub caller (`local: false`) is asked these questions here. */
  team?: {
    /** The login this machine's `gh` is signed in as; `null` is *ask* (an App machine, or an empty answer). */
    knownLogin: string | null
    hostname: () => string
    /** Whether the exact ref exists; `'unreadable'` is GitHub not answering, never *absent*. */
    branchExists: (name: string) => Effect.Effect<boolean | 'unreadable'>
    /** The commits (`<sha> <subject>`) `head` has that `base` does not; `null` when GitHub could not be read. */
    commitsOnlyIn?: (base: string, head: string) => Effect.Effect<string[] | null>
  }
}

/** The branch the caller must make, after every question is answered and before the recipe is written. */
export interface PersonalBranchToMake {
  name: string
  /** The branch it is cut from, as `origin/<main>`. */
  from: string
}

/** What the recipe, as written, will do with a change — the three facts a newcomer needs before anything is registered (#542). */
export interface Summary {
  checks: readonly string[]
  review: string | null
  landsUnattended: boolean
  base: string
  /** The model each agent action names, `null` where it names none (#693). */
  models: readonly { role: 'writer' | 'reviewer'; model: string | null }[]
}

/** The snapshot's rows; `null` where the file exists and is not a `{ rows: [...] }` document. */
function fetchedRates(): readonly unknown[] | null {
  const path = snapshotPath(process.env)
  if (path === null || !existsSync(path)) return []
  const doc = readJson(path) as { rows?: unknown } | undefined
  return Array.isArray(doc?.rows) ? doc.rows : null
}

/**
 * The lines that say which chosen models have no price yet (#693). A hint about
 * what this machine knows now, never a verdict: `init` does not fetch (#658).
 */
export function priceHints(models: Summary['models'], snapshot: readonly unknown[] | null): string[] {
  const lines: string[] = []
  const unreadable = snapshot === null
  const priced = (model: string) =>
    (snapshot ?? []).some((r) => typeof r === 'object' && r !== null && (r as Partial<RateRow>).model === model)
  const named = new Set<string>()
  for (const { model } of models) {
    if (model === null || named.has(model)) continue
    named.add(model)
    if (shipped(model) || priced(model)) continue
    lines.push(
      `${model} is not priced yet — the shipped rate card does not list it and no fetched price for it is on this machine${unreadable ? ' (the fetched-price snapshot there could not be read)' : ''}. The conductor fetches prices when it starts; check \`lingtai doctor\` after the first run.`,
    )
  }
  if (models.some((m) => m.model === null)) {
    lines.push('A role with no model is priced by the model its runtime reports on the first run.')
  }
  return lines
}

/** The draft as it stands, read the way the pass will read it. */
export function summariseRecipe(
  project: string,
  options: { home?: string; draft: RecipeDraft },
): Summary | { refused: string } {
  const path = recipePath(project, options.home)
  const text = options.draft.text()
  if (text === null) return { refused: `no recipe at ${path} to summarise` }
  try {
    const { recipe } = resolveSource(text, path, path)
    const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[]>
    const checks = (steps['build'] ?? []).filter((a) => typeof a['run'] === 'string').map((a) => String(a['run']))
    const reviewer = (steps['review'] ?? []).find((a) => typeof a['agent'] === 'string')
    const writer = (steps['implement'] ?? []).find((a) => typeof a['agent'] === 'string')
    const modelOf = (role: 'writer' | 'reviewer', action: Record<string, unknown> | undefined) =>
      action === undefined
        ? []
        : [{ role, model: typeof action['model'] === 'string' && action['model'] !== '' ? action['model'] : null }]
    return {
      models: [...modelOf('writer', writer), ...modelOf('reviewer', reviewer)],
      checks,
      review: reviewer === undefined ? null : String(reviewer['agent']),
      landsUnattended: !(steps['proposed'] ?? []).some((a) => 'human' in a),
      base: branchOf(recipe),
    }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

/** `draft.set`, with its refusal turned into the same `{refused}` shape every question here returns. */
function writeOrRefuse(
  draft: RecipeDraft,
  changes: readonly RecipeChange[],
): Effect.Effect<{ ok: true } | { refused: string }> {
  if (changes.length === 0) return Effect.succeed({ ok: true })
  return draft.set(changes).pipe(
    Effect.map((): { ok: true } => ({ ok: true })),
    recovering((err) => Effect.succeed({ refused: (err as Error).message })),
  )
}

/** The mode and working branch a rerun moved, as facts. The caller turns them into the card's lines. */
export interface RecipeChanged {
  mode?: { from: Mode; to: Mode; personal?: string; main?: string }
  /**
   * `from` is the recipe's old working branch; `made` is whether the new one was made, and `madeFrom` the branch it
   * was cut from (the old one, or main where the old one is no longer on GitHub). `commits` are the ones only
   * `from` has, where the new one existed; `null` is unreadable.
   */
  branch?: { from: string; to: string; made: boolean; madeFrom?: string; commits?: string[] | null }
}

/**
 * The card's lines for what a GitHub rerun changed (#1474). The commits come from the caller's `commitsOnlyIn`
 * port (a GitHub compare); where that port is absent or could not read, the line gives the command that prints them.
 */
export function changedLeftBehind(changed: RecipeChanged | undefined): LeftBehind[] {
  const out: LeftBehind[] = []
  const listing = (commits: string[] | null | undefined, command: string): string =>
    commits === undefined || commits === null
      ? `the commits could not be read — ${command} lists them`
      : commits.length === 0
        ? 'none'
        : `${commits.length} commit${commits.length === 1 ? '' : 's'}: ${commits.join(' · ')}`
  const m = changed?.mode
  if (m !== undefined && m.from === 'team' && m.to === 'solo' && m.personal !== undefined) {
    // Written only because no draft held a ticket and no PR was open (0130 §1), so nothing is waiting to reach main.
    out.push({ what: `${m.personal} was left as it is — nothing on it is waiting to reach ${m.main ?? 'main'}` })
  }
  const b = changed?.branch
  if (b !== undefined) {
    if (b.made) {
      const from = b.madeFrom ?? b.from
      out.push({
        what:
          from === b.from
            ? `${b.to} was made from origin/${b.from} — ${b.from} is kept and may be deleted`
            : `${b.to} was made from origin/${from} — ${b.from} is not on GitHub, so it could not be the source, and was left as it is`,
      })
    } else {
      const command = `git log --oneline origin/${b.to}..origin/${b.from}`
      out.push({
        what: `${b.to} existed and was left as it was — the commits only ${b.from} has: ${listing(b.commits, command)}`,
        command,
      })
    }
  }
  return out
}

type Recipe =
  | {
      ok: true
      trial: TrialOutcome
      hints: string[]
      answers: Answers
      make?: PersonalBranchToMake
      /** What a rerun changed that leaves something behind (#1474): structured, and said by whoever can read git. */
      changed?: RecipeChanged
    }
  | { refused: string }

export const askRecipeEffect = Effect.fn('recipe-flow.askRecipe')(function* (
  world: QuestionWorld,
  at: RecipeAt,
): Effect.fn.Return<Recipe, unknown> {
  // Every answer lands in this draft and nowhere else: `applySetup` (#968) is the one
  // writer of the file, so a refusal anywhere below leaves the disk as it was.
  const draft = yield* draftRecipe(at.project, { home: at.home, said: SAID })
  at.onDraft?.(draft)

  const absent = draft.text() === null

  if (!absent) {
    const wroteSeeds = yield* writeOrRefuse(draft, at.seeds)
    if ('refused' in wroteSeeds) return wroteSeeds
  }

  // A refusal in any of the next four sections reaches no written file yet
  // on the absent path — `at.keptBeforeWrite` is what it says instead of
  // `at.kept` (#432's split).
  const askKept = absent ? at.keptBeforeWrite : at.kept
  const collected: RecipeChange[] = []
  // Only the flag answers the mode, the login and the branch; a typed *yes* to *use every default?* never does (#1488).
  const landWorld = at.flags['defaults'] !== undefined ? acceptingDefaults(world) : world

  const rawMode = draft.get(['mode'])
  let mode: Mode = at.mode ?? (rawMode === 'team' ? 'team' : 'solo')
  let make: PersonalBranchToMake | undefined
  const changed: RecipeChanged = {}
  const modeBefore: Mode = rawMode === 'team' ? 'team' : 'solo'
  if (at.mode === undefined && !at.local) {
    const asked = yield* askMode(landWorld, {
      given: at.flags['mode'] ?? null,
      kept: askKept,
      current: absent ? null : modeBefore,
    })
    if ('refused' in asked) return asked
    mode = asked.mode
    if (!absent && mode !== modeBefore) {
      const p = draft.get(['branch', 'personal'])
      const m = draft.get(['branch', 'main'])
      const mainName = typeof m === 'string' && m !== '' ? m : null
      const personalName = typeof p === 'string' && p !== '' ? p : null
      changed.mode = {
        from: modeBefore,
        to: mode,
        ...(personalName === null ? {} : { personal: personalName }),
        ...(mainName === null ? {} : { main: mainName }),
      }
    }
    const rawMain = draft.get(['branch', 'main'])
    const seededMain = at.seeds.find((c) => c.path.join('.') === 'branch.main')?.value
    const mainBranch =
      typeof seededMain === 'string'
        ? seededMain
        : typeof rawMain === 'string'
          ? rawMain
          : yield* Effect.promise(() => at.defaultBranch())
    if (mode === 'solo') {
      // The branch the recipe governs and merges into, asked as `init --local` asks it (#1488). `--main` already
      // seeded the default, so it answers this and nothing new is asked.
      const team = at.team
      const landed = yield* questionEffect(landWorld, {
        name: 'the base branch',
        flag: '--main <branch>',
        given: at.flags['main'] ?? null,
        prompt: "the branch this project's recipe governs and merges into",
        current: typeof rawMain === 'string' && rawMain !== '' && !absent ? rawMain : null,
        detected: mainBranch,
        kept: askKept,
        validate: (answer) =>
          // The default is what GitHub or the recipe already named; only a different answer is looked up.
          team === undefined || answer === mainBranch
            ? Effect.succeed(null)
            : Effect.map(team.branchExists(answer), (exists) =>
                exists === 'unreadable'
                  ? `could not read whether ${answer} exists on GitHub`
                  : exists
                    ? null
                    : `${answer} is not a branch on GitHub`,
              ),
      })
      if ('refused' in landed) return landed
      // Where the mode is still changing, the answer is written with that change: checked on its own, the new
      // `branch.main` would be compared with the `branch.personal` that is about to be removed.
      if (absent || modeBefore === 'team') {
        if (absent || landed.answer !== rawMain) collected.push({ path: ['branch', 'main'], value: landed.answer })
      } else if (landed.answer !== rawMain) {
        const wroteMain = yield* writeOrRefuse(draft, [{ path: ['branch', 'main'], value: landed.answer }])
        if ('refused' in wroteMain) return wroteMain
      }
    }
    if (mode === 'solo' && !absent && modeBefore === 'team') {
      // `branch.personal` and `pr:` are read only in team mode: a recipe that keeps either does not resolve. The
      // branch, its commits, the draft and any open PR are the person's, and are not touched.
      collected.push(
        { path: ['mode'], value: 'solo' },
        { path: ['branch', 'personal'], value: undefined },
        ...(draft.get(['pr']) === null ? [] : [{ path: ['pr'], value: undefined }]),
      )
    }
    if (mode === 'team') {
      const team = at.team
      if (team === undefined) return { refused: `team mode needs the machine's login and host. ${askKept}` }
      const given = at.flags['login'] ?? null
      // The assignee the queue takes by is where `assigneeChanges` writes it: the `claim` entry's own `queue:` when
      // there is one, else `source.assignee` (`assigneeOf`'s own order), so the default is the login about to be replaced.
      const claimNow = draft.get(['steps', 'claim'])
      const queued = (Array.isArray(claimNow) ? claimNow : []).find(
        (entry): entry is { queue: { assignee?: unknown } } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { queue?: unknown }).queue === 'object' &&
          (entry as { queue?: unknown }).queue !== null,
      )?.queue.assignee
      const queuedLogin = typeof queued === 'object' && queued !== null ? (queued as { login?: unknown }).login : queued
      const rawAssignee = queuedLogin ?? draft.get(['source', 'assignee', 'login']) ?? draft.get(['source', 'assignee'])
      const currentLogin = typeof rawAssignee === 'string' && rawAssignee !== '' ? rawAssignee : null
      // A discovered login stands in for the question only where it is the recipe's own or the recipe has none:
      // a different one is asked, with the recipe's as the default, never written over it unanswered. With none
      // discovered the question is asked as a first run asks it (#1474).
      const known = team.knownLogin !== null && team.knownLogin !== '' ? team.knownLogin : null
      let login = given ?? (known !== null && (currentLogin === null || known === currentLogin) ? known : null)
      if (login === null || login === '') {
        const typed = yield* askLogin(landWorld, { given: null, kept: askKept, current: currentLogin })
        if ('refused' in typed) return typed
        login = typed.login
      } else if (given !== null && !GITHUB_LOGIN.test(given)) {
        return { refused: `${given} is not a GitHub login (letters, digits and single -). ${askKept}` }
      }
      if (mainBranch === null || mainBranch === '') {
        return { refused: `no main branch to cut ${login}'s branch from — pass --main <branch>. ${askKept}` }
      }
      const rawPersonal = draft.get(['branch', 'personal'])
      const oldPersonal = !absent && typeof rawPersonal === 'string' && rawPersonal !== '' ? rawPersonal : null
      const personal = yield* askPersonal(landWorld, {
        given: at.flags['personal'] ?? null,
        fallback: defaultPersonalBranch(login, team.hostname()),
        current: oldPersonal,
        main: mainBranch,
        kept: askKept,
      })
      if ('refused' in personal) return personal
      const exists = yield* team.branchExists(personal.personal)
      if (exists === 'unreadable') {
        return {
          refused: `could not read whether ${personal.personal} exists on GitHub — nothing was made. ${askKept}`,
        }
      }
      if (exists) {
        landWorld.log(
          `${personal.personal} exists already — Lingtai will use it as it is; main is brought into it at your first submit`,
        )
      } else {
        // A new working branch is cut from the old one where that exists: every ticket that landed on it and
        // has not reached main would otherwise be missing from the new one (#1474).
        let from = mainBranch
        if (oldPersonal !== null && oldPersonal !== personal.personal) {
          const oldExists = yield* team.branchExists(oldPersonal)
          if (oldExists === 'unreadable') {
            return {
              refused: `could not read whether ${oldPersonal} exists on GitHub — nothing was made. ${askKept}`,
            }
          }
          if (oldExists) from = oldPersonal
        }
        const confirmed = yield* questionEffect(world, {
          name: 'making the personal branch',
          flag: `--defaults, or make it yourself: git push origin origin/${from}:refs/heads/${personal.personal}`,
          given: at.flags['defaults'] !== undefined ? 'yes' : null,
          prompt: `${personal.personal} does not exist. Make it from origin/${from} and push it?`,
          choices: ['yes', 'no'],
          fallback: 'yes',
          kept: askKept,
        })
        if ('refused' in confirmed) return confirmed
        if (confirmed.answer === 'no') {
          return {
            refused:
              `${personal.personal} was not made — nothing was written and nothing was registered. ` +
              `Make it yourself with: git push origin origin/${from}:refs/heads/${personal.personal}, then run this again`,
          }
        }
        make = { name: personal.personal, from }
      }
      if (oldPersonal !== null && oldPersonal !== personal.personal) {
        const commits =
          make === undefined && team.commitsOnlyIn !== undefined
            ? yield* team.commitsOnlyIn(personal.personal, oldPersonal)
            : undefined
        changed.branch = {
          from: oldPersonal,
          to: personal.personal,
          made: make !== undefined,
          ...(make === undefined ? {} : { madeFrom: make.from }),
          ...(commits === undefined ? {} : { commits }),
        }
      }
      const rawClaim = draft.get(['steps', 'claim'])
      const teamChanges: RecipeChange[] = [
        { path: ['mode'], value: 'team' },
        { path: ['branch', 'personal'], value: personal.personal },
        ...assigneeChanges({ login, take: 'mine' }, Array.isArray(rawClaim) ? rawClaim : null),
      ]
      collected.push(...teamChanges)
    }
    if (!absent) {
      const wroteMode = yield* writeOrRefuse(draft, collected.splice(0))
      if ('refused' in wroteMode) return wroteMode
    }
  }

  // Asked after the mode and the branch, and answering only what comes after it (#1488): where the code lands is
  // never answered by a typed *yes* to a question that did not show it. A refusal here can only mean the question
  // went unanswered — `given` is either 'yes' or null and 'yes' always accepts, so the only way to land in
  // `{refused}` is no `--defaults` flag and no terminal to ask at. That is not a reason to stop the run: a headless
  // run whose every later question is already answered by a flag must still succeed, and one whose own flag is
  // missing must be refused by that question's own name, not this one's (#433).
  const defaults = yield* questionEffect(world, {
    name: 'every default',
    flag: '--defaults',
    given: at.flags['defaults'] !== undefined ? 'yes' : null,
    prompt: 'use every default?',
    choices: ['yes', 'no'],
    fallback: 'yes',
    kept: askKept,
  })
  const askWorld = 'answer' in defaults && defaults.answer === 'yes' ? acceptingDefaults(world) : world

  // The trial reads the recipe from the draft, and on a new recipe the answers are still in `collected`: it sees
  // them as they will be written, so it checks the branch the recipe will name and not GitHub's default (#1488).
  const trialDraft: RecipeDraft = absent
    ? {
        ...draft,
        get: (path) => {
          const hit = [...at.seeds, ...collected].reverse().find((c) => c.path.join('.') === path.join('.'))
          return hit === undefined ? draft.get(path) : (hit.value ?? null)
        },
      }
    : draft

  const agents = yield* askAgents(askWorld, {
    project: at.project,
    runtimes: at.runtimes,
    flags: {
      agent: at.flags['agent'],
      model: at.flags['model'],
      reviewer: at.flags['reviewer'],
      reviewerModel: at.flags['reviewer-model'],
    },
    home: at.home,
    draft,
    kept: askKept,
  })
  if ('refused' in agents) return agents
  if (absent) {
    collected.push(...agents.changes, ...agents.modelChanges)
    // The schema's discuss agent is claude-code. Where that cannot run and the model-only Codex route is
    // configured, name Codex instead; never `discuss.model` (doctor fails one that differs from codex_text).
    const claudeSignedIn = at.runtimes.find((r) => r.id === 'claude-code')?.signedIn === true
    if (!claudeSignedIn) {
      let codexText: CodexTextConfig | undefined
      try {
        codexText = (at.codexText ?? (() => codexTextConfig()))()
      } catch {
        // An unreadable or invalid codex_text names no Codex agent here; doctor's discuss row validates it again and reports why.
        codexText = undefined
      }
      if (codexText) collected.push({ path: ['discuss', 'agent'], value: 'codex' })
    }
  } else {
    const wroteAgentChanges = yield* writeOrRefuse(draft, agents.changes)
    if ('refused' in wroteAgentChanges) return wroteAgentChanges
    const wroteModelChanges = yield* writeOrRefuse(draft, agents.modelChanges)
    if ('refused' in wroteModelChanges) return wroteModelChanges
  }

  // Asked wherever the caller read the host (#1160), on a rerun too (#1474), with the recipe's own answer as the
  // default: absent is off. An answer equal to it writes nothing.
  if (at.proposal?.sandbox != null) {
    let current: { enabled: boolean; allow: readonly string[]; required?: boolean } | undefined
    if (!absent) {
      const text = draft.text()
      try {
        const block =
          text === null ? undefined : resolveSource(text, recipePath(at.project, at.home), at.project).recipe.sandbox
        current = {
          enabled: block?.enabled ?? false,
          allow: block?.network.allow ?? [],
          required: block?.required ?? false,
        }
      } catch {
        current = { enabled: false, allow: [] }
      }
    }
    const sandbox = yield* askSandbox(askWorld, {
      proposal: at.proposal.sandbox,
      flags: at.flags,
      kept: askKept,
      ...(current === undefined ? {} : { current }),
    })
    if ('refused' in sandbox) return sandbox
    if (absent) {
      collected.push(...sandbox.changes)
    } else {
      const wroteSandbox = yield* writeOrRefuse(draft, sandbox.changes)
      if ('refused' in wroteSandbox) return wroteSandbox
    }
  }

  const setup = yield* askInstallAndBuildEffect(askWorld, {
    project: at.project,
    reader: at.reader,
    ...(at.proposal?.detected.known === true ? { detected: at.proposal.detected.value } : {}),
    given: {
      install: at.flags['install'] ?? null,
      build: at.buildFlags.length === 0 ? null : [...at.buildFlags],
      // Keyed on the world and not on the flag, so a person who typed `yes` at
      // "use every default?" is held to it as `--defaults` is: no scripted or
      // defaulted setup runs minutes of somebody's build (#436).
      check: (at.flags['check-build'] as 'yes' | 'no' | undefined) ?? (askWorld !== world ? 'no' : null),
    },
    tryBuild: typeof at.tryBuild === 'function' ? at.tryBuild(trialDraft) : (at.tryBuild ?? null),
    recipeExisted: !absent,
    onPath: toolOnPath,
    home: at.home,
    draft,
    kept: askKept,
  })
  if ('refused' in setup) return setup
  const trial = setup.trial
  // Said only once the write that carries the list has happened, never when it was chosen.
  const sayKept = () => {
    if (trial.trial === 'failed-kept') {
      askWorld.log(
        `kept the list as tried — it goes into ${recipePath(at.project, at.home)} when the project is added; nothing is written yet`,
      )
    }
  }
  if (absent) {
    collected.push(...setup.changes)
  } else {
    const wroteSetup = yield* writeOrRefuse(draft, setup.changes)
    if ('refused' in wroteSetup) return wroteSetup
    sayKept()
  }

  const tickets = yield* askTickets(askWorld, at.project, at.local, at.flags['tickets'] ?? null, {
    home: at.home,
    draft,
    history: at.history,
    kept: askKept,
  })
  if ('refused' in tickets) return tickets
  if (absent) {
    collected.push(...tickets.changes)
  } else {
    const wroteTickets = yield* writeOrRefuse(draft, tickets.changes)
    if ('refused' in wroteTickets) return wroteTickets
  }

  const kinds = yield* askKinds(askWorld, at.project, at.flags['kinds'] ?? null, {
    home: at.home,
    draft,
    kept: askKept,
    ...(at.proposal?.kinds.known === true ? { kindsFallback: at.proposal.kinds.value } : {}),
  })
  if ('refused' in kinds) return kinds
  if (absent) {
    collected.push(...kinds.changes)
  } else {
    const wroteKinds = yield* writeOrRefuse(draft, kinds.changes)
    if ('refused' in wroteKinds) return wroteKinds
  }

  if (absent) {
    const all = [...at.seeds, ...collected]
    // `source.tickets` has no schema default (`recipe.ts:1108`) — a project
    // that pressed enter on `askTickets`'s own current answer wrote no change
    // at all. Fall back to `tickets.current` — the source `askTickets`
    // actually decided, history included, never a bare `'github'` literal:
    // a project read off an absent file whose log already has `db`-sourced
    // work items must keep that source, not have it silently overridden
    // (#432 fix round, finding 1).
    const changes = all.some((c) => c.path.join('.') === 'source.tickets')
      ? all
      : [...all, { path: ['source', 'tickets'], value: tickets.current }]
    const wrote = yield* writeOrRefuse(draft, changes)
    if ('refused' in wrote) return wrote
    sayKept()
  }

  // A team project lands where its mode says (0130 §2: *the lane has no key of its own*), and the PR is the
  // person's review, so neither half of the question is asked. `--land hold` is still honoured; `--land <branch>`
  // would be written at `branch.main` and quietly re-point the PR target, so it is refused.
  const landFlag = at.flags['land'] ?? null
  if (mode === 'team' && landFlag !== null && landFlag !== 'hold') {
    return {
      refused: `a team project lands on branch.personal, not on ${landFlag} — pass --personal <branch> to name it. ${at.kept}`,
    }
  }
  if (mode !== 'team' || landFlag === 'hold') {
    const landed = yield* askLanding(askWorld, at.project, landFlag, {
      home: at.home,
      draft,
      defaultBranch: at.defaultBranch,
      kept: at.kept,
    })
    if ('refused' in landed) return landed
  }

  // A new recipe sends review findings back to the writer through a judge (#1448). After the landing, so the hold
  // is first in the list as the board writes it; a recipe that already existed is left as it is.
  if (absent) {
    const writer = agents.changes.find((c) => c.path.join('.') === 'runtime.agent')?.value
    const proposedNow = draft.get(['steps', 'proposed'])
    const judged = yield* writeOrRefuse(
      draft,
      findingsJudgeChanges(typeof writer === 'string' ? writer : null, Array.isArray(proposedNow) ? proposedNow : null),
    )
    if ('refused' in judged) return judged
  }

  const limited = yield* askLimits(
    askWorld,
    at.project,
    {
      rounds: at.flags['rounds'],
      refusalFixes: at.flags['refusal-fixes'],
      conflictResolutions: at.flags['conflict-resolutions'],
      wall: at.flags['wall'],
      budget: at.flags['budget'],
    },
    { home: at.home, draft, kept: at.kept },
  )
  if ('refused' in limited) return limited

  // Last, and read back from the file: every registration follows this function (#542).
  const summary = summariseRecipe(at.project, { home: at.home, draft })
  if ('refused' in summary) return summary
  const hints = priceHints(summary.models, (at.rates ?? fetchedRates)())

  // Only the defaults can reach here without anyone having looked: a person who
  // typed an answer, or named `--build none` or `--land <branch>`, chose it.
  const unseenEmptyBuild = summary.checks.length === 0 && at.buildFlags.length === 0
  // Team lands on the person's own branch and `main` moves only through their PR (0130): nothing to confirm.
  const unseenUnattended = mode === 'solo' && summary.landsUnattended && at.flags['land'] === undefined
  if (askWorld !== world && (unseenEmptyBuild || unseenUnattended)) {
    // Asked of `world`, never `askWorld`: a terminal that accepted every default still stops to read.
    const lands = `an attempt lands on ${summary.base || 'the base branch'} with no one asking`
    const asks =
      unseenEmptyBuild && unseenUnattended
        ? `nothing checks a diff before review, and ${lands}`
        : unseenEmptyBuild
          ? 'nothing checks a diff before review'
          : lands
    const confirmed = yield* questionEffect(world, {
      name: 'registering with these defaults',
      flag: '--defaults, or --build <cmd>|none and --land <branch>|hold to choose explicitly',
      given: at.flags['defaults'] !== undefined ? 'yes' : null,
      prompt: `${asks} — register anyway?`,
      choices: ['yes', 'no'],
      fallback: 'yes',
      kept: at.kept,
    })
    if ('refused' in confirmed) return confirmed
    if (confirmed.answer === 'no') {
      return {
        refused: 'stopped before registering — nothing was written and nothing was registered',
      }
    }
  }

  return {
    ok: true,
    trial,
    hints,
    answers: { project: at.project, changes: draft.changes(), said: SAID },
    ...(make === undefined ? {} : { make }),
    ...(changed.mode === undefined && changed.branch === undefined ? {} : { changed }),
  }
})
