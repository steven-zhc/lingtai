/**
 * The onboarding wizard's page, as a value and the moves on it (#164,
 * [the design](../../../doc/design/the-onboarding-wizard.md), *The design: two
 * speeds*).
 *
 * **Most of onboarding is Lingtai reading the repository back to you**, and it
 * goes past in seconds; two answers will still be in force months from now. So
 * the page runs at two speeds, and a line moves one way through three states:
 *
 * - a **fast** row is filled in already, never becomes a question, and always
 *   carries `change`;
 * - a **decision** opens as a question in words, with its consequence written
 *   out;
 * - a **settled** decision collapses back to one line, which still says
 *   `change`.
 *
 * **The collapse is the mechanism.** Without it a scrolling wizard grows for
 * ever and is worse than a stepper; with it the page is always a short list of
 * settled facts plus one open question. `openDecision` is that rule, and the
 * only place it is written.
 *
 * **Pure, and nothing here imports a client or the environment.** The page
 * runs this in the browser as the dials move, so the one sentence it computes
 * — what a pass may spend — is `passCeiling`'s own, from `ceiling.ts`, and not
 * copy written for the page.
 *
 * **No money, anywhere.** A new repository has no cost history, so a figure
 * would be fabricated, and the recipe has no money field to set. Runs and hours
 * are exact; those are what is shown.
 *
 * Which rows are fast is the judgement the design can get wrong, and its
 * criterion is written on `FAST_ROWS` and `DECISIONS` below: a fast row is
 * something a person can get wrong and fix in a minute; a slow one is something
 * they cannot.
 */
import type { GateAction, Recipe, RecipeChange } from "@lingtai/recipe";
import { LIMIT_DEFAULTS, projectLimits } from "@lingtai/recipe/limits";
import { parseDuration } from "@lingtai/recipe/duration";
import { passCeiling } from "./ceiling.ts";

/** A new repository read back from a scan, or a recipe that is already there. */
export type WizardMode = "onboard" | "update";

export type FastRowId =
  | "repo.base"
  | "repo.submodules"
  | "source.kinds"
  | "source.exclude"
  | "gates.proposed"
  | "env.required"
  | "runtime.agent"
  | "gates.end";

export type DecisionId = "gates.merge" | "runtime.limits";

/**
 * The fast lane, in the design's order, each with what it is and why a mistake
 * in it costs a minute. The `why` is the review's to read, not the page's.
 */
export const FAST_ROWS: readonly { id: FastRowId; label: string; why: string }[] = [
  {
    id: "repo.base",
    label: "base branch",
    why: "a wrong base is refused by the first run, loudly, and is one field to fix",
  },
  {
    id: "repo.submodules",
    label: "submodules",
    why: "a worktree without them fails its build on the first ticket, and the fix is a tick",
  },
  {
    id: "source.kinds",
    label: "work",
    why: "a missing kind leaves tickets unclaimed, an extra one is seen on the last screen before anything is taken",
  },
  {
    id: "source.exclude",
    label: "passed over",
    why: "labels only; a wrong one is visible on the queue screen and one tick away",
  },
  {
    id: "gates.proposed",
    label: "checks",
    why: "every script is listed with the guess ticked, so a dropped half is an unticked box you can see",
  },
  {
    id: "env.required",
    label: "environment",
    why: "names only, never values; a missing name fails a run's build by name",
  },
  {
    id: "runtime.agent",
    label: "agent",
    why: "`lingtai doctor` says which is signed in, and a wrong one fails the first run before it spends",
  },
  {
    id: "gates.end",
    label: "when it lands",
    why: "closing an issue is undone by reopening it",
  },
];

/**
 * The slow lane: the two answers that are still in force months from now.
 *
 * An agent review at `proposed` was the third candidate. It costs money, which
 * is the usual reason to slow down — but it is reversible and cheap to be wrong
 * about, so it is not here.
 */
export const DECISIONS: readonly { id: DecisionId; question: string; why: string }[] = [
  {
    id: "gates.merge",
    question: "Does a person approve the merge?",
    why: "with nobody approving, a wrong answer is found out after the diffs have landed on the base branch",
  },
  {
    id: "runtime.limits",
    question: "How far may one ticket go before it is yours?",
    why: "the limits decide what every ticket may spend before a person hears of it, and that is found out by the bill",
  },
];

/** One check the page offers: a script found by the scan, or a gate the recipe has. */
export interface Check {
  id: string;
  /** What is shown: the command, or the gate's name. */
  label: string;
  ticked: boolean;
  /** The gate as the recipe has it, when the check came from a recipe rather than a scan. */
  action?: GateAction;
}

export interface Limits {
  turns: number | null;
  wall: string;
  rounds: number;
  restarts: number;
}

export interface Draft {
  base: string;
  submodules: boolean;
  kinds: string[];
  exclude: string[];
  checks: Check[];
  envRequired: string[];
  agent: "claude-code" | "codex" | null;
  /** Keep defaults out of saved YAML unless the operator actually configured them. */
  configuredLimits: { turns: boolean; wall: boolean };
  closeOnLand: boolean;
  personApproves: boolean;
  limits: Limits;
}

export interface WizardState {
  mode: WizardMode;
  slug: string;
  draft: Draft;
  /** Labels offered as kinds, and as holds: the repository's own, and what the recipe already names. */
  kindOptions: string[];
  excludeOptions: string[];
  /** The fast row whose `change` is open, if any. */
  editing: FastRowId | null;
  settled: DecisionId[];
  /** A settled decision a person pressed `change` on. It stays settled; its answer is kept. */
  reopened: DecisionId | null;
  /** The scan, or the file, has nothing to check a diff with — what flips the merge question's default. */
  noChecksFound: boolean;
  /** What the reading could not settle, in `proposeRecipe`'s words. */
  doubts: string[];
}

/** The human action a *yes* to the merge question writes. */
export const APPROVE_ACTION: GateAction = { name: "approve", human: "Merge this?" };

/** The end action *close the issue when it lands* writes. */
export const CLOSE_ACTION: GateAction = { name: "close the ticket", when: "landed", close: true };

/**
 * The sentence for a chain nothing reads, or null when something does.
 *
 * `wizard.ts`'s `nothingReadsIt` says it on the CLI's last screen; this is the
 * same sentence, kept here so the page can say it while the answer is still
 * being chosen. The page opens no pull request (0046), so on the page is the
 * only place a person reads it there.
 */
export function nothingChecks(base: string): string {
  return `Nothing checks a diff before it merges. Every ticket goes from an agent straight into \`${base}\`.`;
}

/**
 * The last screen's sentence once the button has written (#182): what was
 * written, where, and what is still to happen.
 *
 * **Where is this machine, and never the repository** (0046 §3). The recipe is
 * the file the button wrote; the agent and limits live beside every other
 * project's in the machine file; and the repository is named only to say that
 * nothing went to it.
 *
 * **What is left is `Recheck`, and never "install the App".** The button only
 * gets here through a client built on the App's installation on that
 * repository — without one `finishWizard` refuses and this sentence is never
 * shown — so an instruction to install it would send the operator after a step
 * already done. What `Recheck` still checks is `lingtai add`'s: the
 * installation's permissions and the recipe, and that is what is named.
 */
export function onboardingWritten(slug: string, path: string): string {
  const project = slug.slice(slug.lastIndexOf("/") + 1);
  return (
    `Written on this machine: the recipe is ${path}, and the agent and limits are ` +
    `projects.${project}.runtime in ~/.lingtai/config.yml. Nothing was written to ${slug}. ` +
    "Onboarding is recorded — press Recheck on the board's pending card to register it: it " +
    `checks the GitHub App's permissions on ${slug} and reads that recipe.`
  );
}

/** The scripts a scan found, in the order a gate would run the guessed ones. */
export interface ScannedScript {
  dir: string;
  name: string;
  run: string;
  guessed: boolean;
}

/**
 * The page for a repository read back by `proposeRecipe`.
 *
 * **The one default that flips.** When the scan found no checks at all, the
 * merge question's default is *a person approves*, and `mergeArgument` says
 * why. Everywhere else the page takes the reading's answer and offers `change`.
 */
export function onboardState(input: {
  slug: string;
  recipe: Recipe;
  scripts: readonly ScannedScript[];
  labels: readonly string[];
  doubts?: readonly string[];
  /** Explicit null means the scan did not choose an agent. */
  agent?: "claude-code" | "codex" | null;
  /** Explicit actions are retained intact; only scan-generated builds are aggregated. */
  proposedFromScan?: boolean;
}): WizardState {
  const { recipe } = input;
  const picked = recipe.gates.proposed.flatMap((a) => ("run" in a ? a.run.split(" && ") : []));
  const ordered = [
    ...picked.flatMap((run) => input.scripts.filter((s) => s.guessed && s.run === run)),
    ...input.scripts.filter((s) => !(s.guessed && picked.includes(s.run))),
  ];
  const checks: Check[] = input.proposedFromScan
    ? ordered.map((s) => ({ id: s.run, label: s.run, ticked: s.guessed && picked.includes(s.run) }))
    : [
        ...recipe.gates.proposed.map((action, index) => ({
          id: `${index}:${action.name}`, label: "run" in action ? `${action.name} — ${action.run}` : action.name,
          ticked: true, action,
        })),
        ...input.scripts.filter((s) => !picked.includes(s.run))
          .map((s) => ({ id: s.run, label: s.run, ticked: false })),
      ];
  const noChecksFound = recipe.gates.proposed.length === 0;
  return {
    mode: "onboard",
    slug: input.slug,
    draft: { ...fromRecipe(recipe, checks), ...(input.agent !== undefined ? { agent: input.agent } : {}), personApproves: noChecksFound },
    kindOptions: union(recipe.source.kinds, input.labels),
    excludeOptions: union(recipe.source.exclude, input.labels),
    editing: null,
    settled: [],
    reopened: null,
    noChecksFound,
    doubts: [...(input.doubts ?? [])],
  };
}

/**
 * The page for a recipe that is already on the base branch: the same two
 * speeds, the fast lane filled from the file instead of a scan.
 *
 * The decisions open settled, because the file has answered them — a person
 * adjusting a recipe reads the answers as facts and presses `change` on the one
 * they came for.
 *
 * **Except the one the page argues with.** A file that checks nothing and has
 * nobody approving is the case `mergeArgument` exists for, so the merge
 * question opens unanswered with *a person approves* chosen, as it does when a
 * scan finds nothing — the file's *no* is one click away, and the page cannot
 * finish until somebody has read the argument and answered it.
 */
export function updateState(input: { slug: string; recipe: Recipe }): WizardState {
  const { recipe } = input;
  const noChecksFound = recipe.gates.proposed.length === 0;
  const unread = noChecksFound && !recipe.gates.merge.some((a) => "human" in a);
  const checks = recipe.gates.proposed.map((action, i) => ({
    id: `${i}:${action.name}`,
    label: "run" in action ? `${action.name} — ${action.run}` : action.name,
    ticked: true,
    action,
  }));
  return {
    mode: "update",
    slug: input.slug,
    draft: unread ? { ...fromRecipe(recipe, checks), personApproves: true } : fromRecipe(recipe, checks),
    kindOptions: [...recipe.source.kinds],
    excludeOptions: [...recipe.source.exclude],
    editing: null,
    settled: DECISIONS.map((d) => d.id).filter((id) => !(unread && id === "gates.merge")),
    reopened: null,
    noChecksFound,
    doubts: [],
  };
}

function fromRecipe(recipe: Recipe, checks: Check[]): Draft {
  const { turns, wall, rounds, restarts } = projectLimits(recipe);
  return {
    base: recipe.repo.base,
    submodules: recipe.repo.submodules,
    kinds: [...recipe.source.kinds],
    exclude: [...recipe.source.exclude],
    checks,
    envRequired: [...recipe.env.required],
    agent: recipe.runtime.agent === "codex" ? "codex" : "claude-code",
    configuredLimits: { turns: recipe.runtime.limits.turns !== undefined, wall: recipe.runtime.limits.wall !== undefined },
    closeOnLand: recipe.gates.end.some(closesOnLand),
    personApproves: recipe.gates.merge.some((a) => "human" in a),
    limits: { turns, wall, rounds, restarts },
  };
}

function closesOnLand(action: GateAction): boolean {
  return "close" in action && (action.when === "landed" || action.when === "any");
}

export type WizardMove =
  | { type: "change"; row: FastRowId }
  | { type: "done" }
  | { type: "reopen"; decision: DecisionId }
  | { type: "settle"; decision: DecisionId }
  | { type: "set"; draft: Partial<Pick<Draft, "base" | "submodules" | "agent" | "closeOnLand" | "personApproves">> }
  | { type: "kind"; label: string; add?: true }
  | { type: "exclude"; label: string; add?: true }
  | { type: "check"; id: string }
  | { type: "add-check"; run: string }
  | { type: "env"; names: string[] }
  | { type: "limit"; key: keyof Limits; value: number | string };

/**
 * One move on the page.
 *
 * **The last kind cannot be unticked.** `source.kinds` has `.min(1)`, and a
 * page that lets the parse catch it at the end has let a person build a recipe
 * that takes no work. The move is refused where it is made, and `finishRefusals`
 * says it again for a state that arrived some other way.
 *
 * **`add` adds and never removes.** A kind or a label typed into a row's `add`
 * that is already ticked stays ticked; only the tick itself takes one away.
 */
export function wizardReducer(state: WizardState, move: WizardMove): WizardState {
  const draft = state.draft;
  switch (move.type) {
    case "change":
      return { ...state, editing: move.row };
    case "done":
      return { ...state, editing: null };
    case "reopen":
      return state.settled.includes(move.decision) ? { ...state, reopened: move.decision } : state;
    case "settle":
      return {
        ...state,
        settled: state.settled.includes(move.decision) ? state.settled : [...state.settled, move.decision],
        reopened: null,
      };
    case "set": {
      const agent = move.draft.agent;
      const turns = agent !== undefined && !draft.configuredLimits.turns
        ? agent === "codex" ? null : LIMIT_DEFAULTS.turns
        : draft.limits.turns;
      return { ...state, draft: { ...draft, ...move.draft, limits: { ...draft.limits, turns } } };
    }
    case "kind": {
      const on = draft.kinds.includes(move.label);
      if (on && (move.add || draft.kinds.length === 1)) return state;
      const kinds = on ? draft.kinds.filter((k) => k !== move.label) : [...draft.kinds, move.label];
      // A kind the recipe does not list yet, or a label the repository has not
      // created, is added by name — otherwise the row could only ever narrow.
      const kindOptions = state.kindOptions.includes(move.label) ? state.kindOptions : [...state.kindOptions, move.label];
      return { ...state, kindOptions, draft: { ...draft, kinds } };
    }
    case "exclude": {
      const on = draft.exclude.includes(move.label);
      if (on && move.add) return state;
      const exclude = on ? draft.exclude.filter((k) => k !== move.label) : [...draft.exclude, move.label];
      const excludeOptions = state.excludeOptions.includes(move.label)
        ? state.excludeOptions
        : [...state.excludeOptions, move.label];
      return { ...state, excludeOptions, draft: { ...draft, exclude } };
    }
    case "check":
      return withChecks(
        state,
        draft.checks.map((c) => (c.id === move.id ? { ...c, ticked: !c.ticked } : c)),
      );
    case "add-check": {
      // A command the scan did not find — a repository with no `package.json`
      // has none — is typed in, ticked, and runs in the gate like a found one.
      const run = move.run.trim();
      if (run === "") return state;
      const id = state.mode === "update" ? `added:${run}` : run;
      if (draft.checks.some((c) => c.id === id)) {
        return withChecks(state, draft.checks.map((c) => (c.id === id ? { ...c, ticked: true } : c)));
      }
      const check: Check =
        state.mode === "update"
          ? { id, label: `check — ${run}`, ticked: true, action: { name: "check", run, timeout: "20m", env: [] } }
          : { id, label: run, ticked: true };
      return withChecks(state, [...draft.checks, check]);
    }
    case "env":
      return { ...state, draft: { ...draft, envRequired: [...new Set(move.names.filter(Boolean))] } };
    case "limit":
      return { ...state, draft: { ...draft,
        configuredLimits: move.key === "turns" || move.key === "wall"
          ? { ...draft.configuredLimits, [move.key]: true } : draft.configuredLimits,
        limits: { ...draft.limits, [move.key]: move.value },
      } };
  }
}

/**
 * The checks changed, and **the merge question follows the ticks.**
 *
 * Unticking the last check is the one case the page argues with, whatever the
 * scan found: the default becomes *a person approves*, and a merge answer that
 * was already settled becomes unanswered again, so the end is refused until the
 * question is answered with the argument in view.
 *
 * It unsettles rather than reopens: `reopened` is what a person pressed `change`
 * on, and a limits question they had open stays open — the merge question is
 * the next one asked once that is settled.
 */
function withChecks(state: WizardState, checks: Check[]): WizardState {
  const next = { ...state, draft: { ...state.draft, checks } };
  if (!anyCheck(state.draft) || anyCheck(next.draft)) return next;
  return {
    ...next,
    draft: { ...next.draft, personApproves: true },
    settled: state.settled.filter((id) => id !== "gates.merge"),
    reopened: state.reopened === "gates.merge" ? null : state.reopened,
  };
}

/**
 * The one open question, or null when every decision is settled.
 *
 * A reopened decision first; otherwise the first one not yet answered. A
 * decision after that one is not shown at all — the page is settled facts plus
 * **one** question.
 */
export function openDecision(state: WizardState): DecisionId | null {
  if (state.reopened !== null) return state.reopened;
  return DECISIONS.find((d) => !state.settled.includes(d.id))?.id ?? null;
}

/** The decisions to draw as settled lines: answered, and not the open one. */
export function settledDecisions(state: WizardState): DecisionId[] {
  const open = openDecision(state);
  return DECISIONS.map((d) => d.id).filter((id) => state.settled.includes(id) && id !== open);
}

/** `passCeiling`'s sentence for these dials, or why the dials do not make one. */
export function limitsSentence(limits: Limits): { ok: true; sentence: string } | { ok: false; refusal: string } {
  let wallMs: number;
  try {
    wallMs = parseDuration(limits.wall);
  } catch (err) {
    return { ok: false, refusal: (err as Error).message };
  }
  if (!Number.isFinite(wallMs) || wallMs <= 0) return { ok: false, refusal: `wall must be positive and finite, not ${limits.wall}` };
  for (const key of ["turns", "rounds", "restarts"] as const) {
    const n = limits[key];
    if (key === "turns" && n === null) continue;
    if (n === null) return { ok: false, refusal: `${key} must be a whole number, not null` };
    if (!Number.isInteger(n) || n < (key === "turns" ? 1 : 0)) {
      return { ok: false, refusal: `${key} must be a whole number${key === "turns" ? " above 0" : ""}, not ${n}` };
    }
  }
  return { ok: true, sentence: passCeiling({ ...limits, wallMs }) };
}

/** Whether any check is ticked — what `gates.proposed` will run. */
function anyCheck(draft: Draft): boolean {
  return draft.checks.some((c) => c.ticked);
}

/** The consequence of the merge answer, written out. */
export function mergeConsequence(draft: Draft): string {
  if (draft.personApproves) {
    return `Every diff waits for a person to approve it before it lands in \`${draft.base}\`.`;
  }
  if (!anyCheck(draft)) return nothingChecks(draft.base);
  return `A diff lands in \`${draft.base}\` when the checks pass, and nobody reads it first.`;
}

/**
 * Why the merge question's default is *a person approves*, or null when it is
 * not arguing. Said only while no check is ticked: the one case the page argues
 * with. It reads the ticks rather than what the scan found, so ticking a check
 * the scan missed ends the argument, and unticking every one it found starts it.
 */
export function mergeArgument(state: WizardState): string | null {
  if (anyCheck(state.draft)) return null;
  return `${nothingChecks(state.draft.base)} So the default here is that a person approves.`;
}

/** One line for a fast row, as it reads collapsed. */
export function fastLine(draft: Draft, row: FastRowId): string {
  switch (row) {
    case "repo.base":
      return draft.base;
    case "repo.submodules":
      return draft.submodules ? "checked out with the worktree" : "none";
    case "source.kinds":
      return `${draft.kinds.join(" > ")}   (in priority order)`;
    case "source.exclude":
      return draft.exclude.length === 0 ? "nothing" : draft.exclude.join(", ");
    case "gates.proposed": {
      const ticked = draft.checks.filter((c) => c.ticked);
      const unticked = draft.checks.length - ticked.length;
      const runs = ticked.length === 0 ? "nothing checks a diff" : ticked.map((c) => c.label).join(" && ");
      return unticked === 0 ? runs : `${runs}   (${unticked} more found, not ticked)`;
    }
    case "env.required":
      return draft.envRequired.length === 0 ? "nothing" : draft.envRequired.join(", ");
    case "runtime.agent":
      return draft.agent ?? "choose an agent";
    case "gates.end":
      return draft.closeOnLand ? "close the issue" : "leave the issue open";
  }
}

/** One line for a settled decision. */
export function settledLine(draft: Draft, decision: DecisionId): string {
  if (decision === "gates.merge") return draft.personApproves ? "a person approves" : "nobody approves";
  const { turns, wall, rounds, restarts } = draft.limits;
  return `${turns === null ? "no turns limit" : `${turns} turns`} · ${wall} · ${rounds} rounds · ${restarts} restarts`;
}

/**
 * Everything that stops the page reaching its end, as sentences. Empty means it
 * may finish.
 */
export function finishRefusals(state: WizardState): string[] {
  const refusals: string[] = [];
  if (state.draft.agent === null) refusals.push("runtime.agent: choose an agent explicitly for this project.");
  if (state.draft.kinds.length === 0) {
    refusals.push("source.kinds is empty — no issue would ever be work. Tick at least one kind.");
  }
  if (state.draft.base.trim() === "") refusals.push("repo.base is empty — work has to land on a branch.");
  for (const d of DECISIONS) {
    if (!state.settled.includes(d.id)) refusals.push(`${d.question} is not answered yet.`);
  }
  if (state.reopened !== null) refusals.push(`${state.reopened} is open — settle it first.`);
  const limits = limitsSentence(state.draft.limits);
  if (!limits.ok) refusals.push(`runtime.limits: ${limits.refusal}`);
  return refusals;
}

/**
 * The recipe the page describes, built on the one it started from.
 *
 * Only the rows the page shows are set; everything else — presets, admit and
 * prepared gates, a merge `watch`, the prompt — comes through as it was.
 */
export function applyDraft(recipe: Recipe, state: WizardState): Recipe {
  const { draft } = state;
  const ticked = draft.checks.filter((c) => c.ticked);
  const scanned = ticked.filter((c) => c.action === undefined);
  const proposed: GateAction[] = [
    ...ticked.flatMap((c) => c.action === undefined ? [] : [c.action]),
    ...(state.mode === "onboard" && scanned.length > 0
      ? [{ name: "build", run: scanned.map((c) => c.label).join(" && "), timeout: "20m", env: [] }] : []),
  ];

  const humans = recipe.gates.merge.filter((a) => "human" in a);
  const merge = draft.personApproves
    ? humans.length > 0
      ? recipe.gates.merge
      : [...recipe.gates.merge, APPROVE_ACTION]
    : recipe.gates.merge.filter((a) => !("human" in a));

  const end = draft.closeOnLand
    ? recipe.gates.end.some(closesOnLand)
      ? recipe.gates.end
      : [...recipe.gates.end, CLOSE_ACTION]
    : recipe.gates.end.filter((a) => !closesOnLand(a));

  return {
    ...recipe,
    repo: { ...recipe.repo, base: draft.base.trim(), submodules: draft.submodules },
    source: { ...recipe.source, kinds: [...draft.kinds], exclude: [...draft.exclude] },
    env: { ...recipe.env, required: [...draft.envRequired] },
    gates: { ...recipe.gates, proposed, merge, end },
    runtime: {
      ...recipe.runtime,
      agent: draft.agent ?? recipe.runtime.agent,
      model: draft.agent !== recipe.runtime.agent ? undefined : recipe.runtime.model,
      limits: { ...recipe.runtime.limits, ...draft.limits,
        turns: draft.configuredLimits.turns ? draft.limits.turns ?? undefined : undefined,
        wall: draft.configuredLimits.wall ? draft.limits.wall : undefined,
      },
    },
  };
}

/** Every path the page can change, narrowest first where a row is several values. */
const PATHS: readonly (readonly string[])[] = [
  ["repo", "base"],
  ["repo", "submodules"],
  ["source", "kinds"],
  ["source", "exclude"],
  ["gates", "proposed"],
  ["env", "required"],
  ["runtime", "agent"],
  ["runtime", "model"],
  ["gates", "end"],
  ["gates", "merge"],
  ["runtime", "limits", "turns"],
  ["runtime", "limits", "wall"],
  ["runtime", "limits", "rounds"],
  ["runtime", "limits", "restarts"],
];

/**
 * What changed between the recipe the page loaded and the one it describes, as
 * `editRecipe`'s changes — one per field that moved, and none for one that did
 * not.
 *
 * **Editing one field changes one field.** A limit is its own path rather than
 * the block, so moving `rounds` touches the `rounds:` line and leaves the
 * comment above `limits:` and the other three dials as they were written.
 */
export function changesFrom(before: Recipe, after: Recipe): RecipeChange[] {
  return PATHS.flatMap((path) => {
    const was = at(before, path);
    const now = at(after, path);
    return JSON.stringify(was) === JSON.stringify(now) ? [] : [{ path, value: now }];
  });
}

/**
 * The sentences a new recipe carries as comments, by path — the words the page
 * showed, so the file does not explain a field a second way.
 */
export function saidFor(state: WizardState): Record<string, string> {
  const said: Record<string, string> = {
    "source.kinds": "The labels that make an issue work, in priority order.",
    "gates.merge": `${DECISIONS[0]!.question} ${mergeConsequence(state.draft)}`,
  };
  const limits = limitsSentence(state.draft.limits);
  if (limits.ok) said["runtime.limits"] = `A pass: ${limits.sentence}.`;
  return said;
}

/**
 * `changes` with everything under `gates` made one change to the whole block.
 *
 * **A preset's gates come whole or not at all.** `applyPreset` takes a file's
 * own `gates` in place of the preset's entire block (`presets.ts`), so on a file
 * that says `extends:` and has no `gates:`, setting `gates.end` alone writes a
 * `gates` of one point and every gate the preset supplied is gone. Writing the
 * block the page describes keeps them, spelled out in the file.
 */
export function wholeGates(changes: readonly RecipeChange[], after: Recipe): RecipeChange[] {
  const rest = changes.filter((c) => c.path[0] !== "gates");
  return rest.length === changes.length ? [...changes] : [...rest, { path: ["gates"], value: after.gates }];
}

function at(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
    value,
  );
}

function union(first: readonly string[], rest: readonly string[]): string[] {
  return [...new Set([...first, ...rest])];
}
