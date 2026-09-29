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
import { RuntimeId } from "@lingtai/domain";
import type { StepAction, Recipe, RecipeChange } from "@lingtai/recipe";
import { parseDuration } from "@lingtai/recipe/duration";
import { passCeiling } from "./ceiling.ts";
import { baseOf, excludeOf, kindsOf, limitsFor, submodulesOf } from "@lingtai/recipe/settings";

/** A new repository read back from a scan, or a recipe that is already there. */
export type WizardMode = "onboard" | "update";

export type FastRowId =
  | "repo.base"
  | "repo.submodules"
  | "source.kinds"
  | "source.exclude"
  | "steps.proposed"
  | "env.required"
  | "runtime.agent"
  | "steps.end";

/**
 * **`steps.merge` names the question and no longer names the key it writes**
 * (`#270`).
 *
 * The question is *does a person approve the merge?* and that is what a person
 * reads; what it writes is a `human:` at **`proposed:`**, because 0058 §3b gives
 * `merge` three ways out and only `proposed` may send one to a person — and since
 * `mergePlugin` serves `merge`, a hold declared beside the lane would be asked
 * about a merge the same list had already made. `humanPlugin.at` refuses it there
 * by name now.
 *
 * The id keeps the name for `FastRowId.steps.proposed`'s reason, one screen up:
 * renaming it moves nothing a person sees and touches every switch on it. Both
 * write `proposed:` and they write different things into it — the row writes the
 * ticked checks, this writes the hold, and `applyDraft` is the one place that
 * knows that.
 */
export type DecisionId = "steps.merge" | "runtime.limits";

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
    // **One row, and since `#263` three keys** — `build:`, `review:` and
    // `proposed:`, which is `CHECKING_STEPS`. The id keeps the name it was
    // given when `proposed` was the only step a check could be declared at:
    // renaming it moves nothing and touches every `FastRowId` switch, and a
    // person reads the label. `applyDraft` is where the three are written.
    id: "steps.proposed",
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
    id: "steps.end",
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
    id: "steps.merge",
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
  action?: StepAction;
  /**
   * **The step it was read from, so a save puts it back there.** Absent for a
   * check the page invented — those go to `homeStep`'s answer.
   *
   * It is the field that makes the widened read safe. Reading three steps and
   * writing one would relocate a build declared at `build:` into `proposed:`
   * the moment somebody pressed Save, undoing the move `#263` is about with no
   * refusal and no diff to read: worse than the sentence it fixes.
   */
  step?: CheckStep;
}

export interface Limits {
  turns: number;
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
  /** `RuntimeId` and not its members written out: a third one is then this too. */
  agent: RuntimeId;
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

/**
 * The human action a *yes* to the merge question writes — **at `proposed:`, which
 * is the step before the lane** (`#270`, 0058 §3b).
 *
 * The question it asks is unchanged, because the question a person is answering is
 * unchanged: `proposed` is reached by every pass that got past `review`, so a hold
 * there is a hold on the merge. What moved is the key, and it moved because the
 * other one now lands.
 */
export const APPROVE_ACTION: StepAction = { name: "approve", human: "Merge this?" };

/** The end action *close the issue when it lands* writes. */
export const CLOSE_ACTION: StepAction = { name: "close the ticket", when: "landed", close: true };

/**
 * **The steps whose declared actions check a diff before it merges**, in the
 * order a pass reaches them.
 *
 * One list, because this question used to be written out at each site as
 * `recipe.steps.proposed`, and the sites drifted the moment `build` opened:
 * widening `nothingReadsIt` alone left the page's own copy reading `proposed`,
 * so it told an operator *nothing checks a diff* while a full build ran at
 * `build:`, and offered the person-approves remedy `wizard.ts` calls out as
 * undoing the move. A second copy of the question is a second answer to it.
 *
 * `merge` is deliberately not here: its actions run *after* the verdicts this
 * asks about, and `nothingReadsIt` reads it separately for that reason.
 */
export const CHECKING_STEPS = ["build", "review", "proposed"] as const;

/** One of them: the step a check on the page was read from, and returns to. */
export type CheckStep = (typeof CHECKING_STEPS)[number];

/**
 * **Where a check the page invented may be written**, and the whole of why it
 * is not `CHECKING_STEPS`.
 *
 * `review` checks a diff, so it belongs in the list above — but what checks
 * there is an `agent:`, and `run:` does not serve `review`. A command typed
 * into the checks row and sent there builds a recipe `Recipe.parse` refuses by
 * name (*the "check" action is a "run" at the "review" step*), so
 * `editExisting` throws where it parses and the check cannot be added at all.
 * The reading and the writing are two questions, and this is the second one.
 *
 * Written out rather than read off `runPlugin.at`: this file is bundled for the
 * browser and imports nothing from `@lingtai/recipe` but types and its two leaf
 * modules. `wizard-page.test.ts` reads the plugin's own `at` and fails on a
 * divergence, so the list is held to it rather than remembered.
 */
export const COMMAND_STEPS = ["build", "proposed"] as const;

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
}): WizardState {
  const { recipe } = input;
  const declared = CHECKING_STEPS.flatMap((step) => recipe.steps[step].filter(isCheck));
  const picked = declared.flatMap((a) => ("run" in a ? a.run.split(" && ") : []));
  const ordered = [
    ...picked.flatMap((run) => input.scripts.filter((s) => s.guessed && s.run === run)),
    ...input.scripts.filter((s) => !(s.guessed && picked.includes(s.run))),
  ];
  const checks = ordered.map((s) => ({ id: s.run, label: s.run, ticked: s.guessed && picked.includes(s.run) }));
  const noChecksFound = declared.length === 0;
  return {
    mode: "onboard",
    slug: input.slug,
    draft: { ...fromRecipe(recipe, checks), personApproves: noChecksFound },
    kindOptions: union(kindsOf(recipe), input.labels),
    excludeOptions: union(excludeOf(recipe), input.labels),
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
  // Every checking step, each check remembering which one it came off — the
  // row is one list to a reader and three keys in the file, and `applyDraft`
  // needs the second to put an edited one back where it was.
  const checks: Check[] = CHECKING_STEPS.flatMap((step) =>
    recipe.steps[step].filter(isCheck).map((action, i) => ({
      id: `${step}.${i}:${action.name}`,
      label: "run" in action ? `${action.name} — ${action.run}` : action.name,
      ticked: true,
      action,
      step,
    })),
  );
  const noChecksFound = checks.length === 0;
  const unread = noChecksFound && !recipe.steps.proposed.some((a) => "human" in a);
  return {
    mode: "update",
    slug: input.slug,
    draft: unread ? { ...fromRecipe(recipe, checks), personApproves: true } : fromRecipe(recipe, checks),
    kindOptions: [...kindsOf(recipe)],
    excludeOptions: [...excludeOf(recipe)],
    editing: null,
    settled: DECISIONS.map((d) => d.id).filter((id) => !(unread && id === "steps.merge")),
    reopened: null,
    noChecksFound,
    doubts: [],
  };
}

function fromRecipe(recipe: Recipe, checks: Check[]): Draft {
  const { turns, wall, rounds, restarts } = limitsFor(recipe, "implement");
  return {
    base: baseOf(recipe),
    submodules: submodulesOf(recipe),
    kinds: [...kindsOf(recipe)],
    exclude: [...excludeOf(recipe)],
    checks,
    envRequired: [...recipe.env.required],
    // `recipe.runtime.agent` is already a `RuntimeId`; the ternary this replaces
    // narrowed it to the two it knew about, so a third would have been silently
    // read back as `claude-code` on the page that sets it.
    agent: recipe.runtime.agent,
    closeOnLand: recipe.steps.end.some(closesOnLand),
    // `proposed:` and not `merge:` since `#270`: that is where the hold is legal
    // and where `applyDraft` writes it.
    personApproves: recipe.steps.proposed.some((a) => "human" in a),
    limits: { turns, wall, rounds, restarts },
  };
}

/**
 * **What the checks row is a list of — and a hold is not one** (`#270`).
 *
 * `proposed:` carries two of the page's answers since the merge decision moved
 * there: the ticked checks and, when a person approves, the hold. Both read the
 * same key, so the row has to be able to say which entries are its own — a
 * `human:` shown as a check would be labelled *approve*, ticked, and unticking it
 * would silently answer the decision below.
 *
 * `human:` and nothing else. A `watch:` reads the diff's files and has read as a
 * check since the row existed, and this is not the ticket that re-decides that.
 */
function isCheck(action: StepAction): boolean {
  return !("human" in action);
}

function closesOnLand(action: StepAction): boolean {
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
    case "set":
      return { ...state, draft: { ...draft, ...move.draft } };
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
      return { ...state, draft: { ...draft, limits: { ...draft.limits, [move.key]: move.value } } };
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
    settled: state.settled.filter((id) => id !== "steps.merge"),
    reopened: state.reopened === "steps.merge" ? null : state.reopened,
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
  if (wallMs <= 0) return { ok: false, refusal: `wall must be longer than nothing, not ${limits.wall}` };
  for (const key of ["turns", "rounds", "restarts"] as const) {
    const n = limits[key];
    if (!Number.isInteger(n) || n < (key === "turns" ? 1 : 0)) {
      return { ok: false, refusal: `${key} must be a whole number${key === "turns" ? " above 0" : ""}, not ${n}` };
    }
  }
  return { ok: true, sentence: passCeiling({ ...limits, wallMs }) };
}

/** Whether any check is ticked — what the `CHECKING_STEPS` will run between them. */
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
    case "steps.proposed": {
      const ticked = draft.checks.filter((c) => c.ticked);
      const unticked = draft.checks.length - ticked.length;
      const runs = ticked.length === 0 ? "nothing checks a diff" : ticked.map((c) => c.label).join(" && ");
      return unticked === 0 ? runs : `${runs}   (${unticked} more found, not ticked)`;
    }
    case "env.required":
      return draft.envRequired.length === 0 ? "nothing" : draft.envRequired.join(", ");
    case "runtime.agent":
      return draft.agent;
    case "steps.end":
      return draft.closeOnLand ? "close the issue" : "leave the issue open";
  }
}

/** One line for a settled decision. */
export function settledLine(draft: Draft, decision: DecisionId): string {
  if (decision === "steps.merge") return draft.personApproves ? "a person approves" : "nobody approves";
  const { turns, wall, rounds, restarts } = draft.limits;
  return `${turns} turns · ${wall} · ${rounds} rounds · ${restarts} restarts`;
}

/**
 * Everything that stops the page reaching its end, as sentences. Empty means it
 * may finish.
 */
export function finishRefusals(state: WizardState): string[] {
  const refusals: string[] = [];
  if (state.draft.kinds.length === 0) {
    refusals.push("source.kinds is empty — no issue would ever be work. Tick at least one kind.");
  }
  // Not `repo.base` by name: the value may be `worktree:`'s at `admit`, and a
  // refusal that named the key the file does not use would send a person to the
  // wrong line (`#268`).
  if (state.draft.base.trim() === "") refusals.push("the base is empty — work has to land on a branch.");
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
  const home = homeStep(recipe);
  // Emptied first and refilled from the ticks, so unticking the last check at
  // a step clears that key rather than leaving it as the file had it.
  const checked: Record<CheckStep, StepAction[]> = { build: [], review: [], proposed: [] };
  if (state.mode === "update") {
    for (const check of ticked) {
      if (check.action !== undefined) checked[check.step ?? home].push(check.action);
    }
  } else if (ticked.length > 0) {
    checked[home].push({ name: "build", run: ticked.map((c) => c.label).join(" && "), timeout: "20m", env: [] });
  }

  /**
   * **The merge decision writes `proposed:`, after the checks that row refilled**
   * (`#270`).
   *
   * It wrote `merge:` until that ticket opened `mergePlugin.at.merge`, and the two
   * cannot share a list: the lane is an action there now, so an approval appended
   * beside it is asked *after* the branch has landed. `humanPlugin.at` refuses it
   * at `merge` by name, so a page that still wrote one would build a recipe
   * `Recipe.parse` throws on — and `proposed` is where 0058 §3b puts the question
   * anyway.
   *
   * **A question somebody wrote in their own words is kept.** The holds are not
   * checks, so `isCheck` keeps them out of the row above and out of `ticked`; this
   * is the only line that puts one back, and it re-uses what the file said rather
   * than overwriting it with `APPROVE_ACTION`'s wording. A *no* drops them, which
   * is the answer being honoured.
   *
   * After the checks, because a hold before them asks a person about a diff whose
   * own build has not run yet.
   */
  const asks = recipe.steps.proposed.filter((a) => !isCheck(a));
  checked.proposed = [
    ...checked.proposed,
    ...(draft.personApproves ? (asks.length > 0 ? asks : [APPROVE_ACTION]) : []),
  ];

  const end = draft.closeOnLand
    ? recipe.steps.end.some(closesOnLand)
      ? recipe.steps.end
      : [...recipe.steps.end, CLOSE_ACTION]
    : recipe.steps.end.filter((a) => !closesOnLand(a));

  /**
   * **The base row is written where `baseOf` reads it, which is two places**
   * (`#268`).
   *
   * A recipe that declares a `worktree:` at `admit` has its base and its
   * submodules *there*, and `repo:` is the v1 spelling of the same setting — so a
   * page that wrote only `repo.base` would report the base as changed, write it,
   * hash it, say *a diff lands in `release` when the checks pass*, and then cut
   * the next worktree from `main`. The wizard's own read-back guard cannot catch
   * it: the recipe it hashes against has the same stale declaration. So the edit
   * goes to whichever spelling the file uses, and the other is left exactly as it
   * was rather than being filled in as a second home.
   */
  const admit = recipe.steps.admit.map((action) =>
    "worktree" in action
      ? { ...action, worktree: { base: draft.base.trim(), submodules: draft.submodules } }
      : action,
  );

  /**
   * **The kinds row is written where `kindsOf` reads it, which is two places**
   * (`#269`) — the block above, one setting down.
   *
   * A recipe that declares a `queue:` at `claim` has its kinds and its holds
   * *there*, and `source:` is the v1 spelling of the same three settings. A page
   * that wrote only `source.kinds` would show the block's list (the row is read
   * through `kindsOf`), report the untick as an edit, write it, hash it, and then
   * take a `documentation` ticket on the next pass — with the page showing the
   * removed kind back on the next render, so the edit reads as silently reverted.
   * The read-back guard cannot catch it for `admit`'s reason: the recipe it
   * hashes against carries the same stale declaration.
   *
   * The other two fields of the block are left exactly as written: `backoff` and
   * `assignee` are not this page's rows, and filling them in would be the second
   * home the spelling exists to avoid.
   */
  const claim = recipe.steps.claim.map((action) =>
    "queue" in action
      ? { ...action, queue: { ...action.queue, kinds: [...draft.kinds], exclude: [...draft.exclude] } }
      : action,
  );

  return {
    ...recipe,
    repo: { ...recipe.repo, base: draft.base.trim(), submodules: draft.submodules },
    source: { ...recipe.source, kinds: [...draft.kinds], exclude: [...draft.exclude] },
    env: { ...recipe.env, required: [...draft.envRequired] },
    steps: { ...recipe.steps, claim, admit, ...checked, end },
    runtime: {
      ...recipe.runtime,
      agent: draft.agent,
      limits: { ...limitsFor(recipe, "implement"), ...draft.limits },
    },
  };
}

/**
 * **Where a check the page invented is written**: the first `COMMAND_STEPS`
 * entry this recipe already runs a command at, and `proposed` when it runs
 * none — which is where every check went before `build` opened, so a recipe
 * that has not moved is written exactly as it was.
 *
 * **The recipe and not the draft**, so the answer does not move as boxes are
 * ticked: a person who unticks the build at `build:` and types a replacement
 * gets it back at `build:`, rather than relocated by the act of retyping it.
 *
 * It can only answer a step `run:` serves, which is the whole of why
 * `COMMAND_STEPS` is a second list. `review` holds a check — an `agent:` — and
 * a command sent there is refused by the schema, so an answer of `review` here
 * would be a save that throws instead of a save that writes.
 */
function homeStep(recipe: Recipe): CheckStep {
  return COMMAND_STEPS.find((step) => recipe.steps[step].some((a) => "run" in a)) ?? "proposed";
}

/** Every path the page can change, narrowest first where a row is several values. */
const PATHS: readonly (readonly string[])[] = [
  ["repo", "base"],
  ["repo", "submodules"],
  // The same row's other spelling: `worktree:` at `admit` carries the base and
  // the submodules where a recipe has moved them, and `baseOf` reads it first
  // (`#268`). One path, because the two fields are one map and one row.
  ["steps", "admit"],
  ["source", "kinds"],
  ["source", "exclude"],
  // The same row's other spelling: `queue:` at `claim` carries the kinds and the
  // holds where a recipe has moved them, and `kindsOf`/`excludeOf` read it first
  // (`#269`). One path, because the block is one map and the two fields are one
  // row — and the block's other two fields are nobody's row here, so a `claim`
  // that only holds them never appears as a change.
  ["steps", "claim"],
  // The checks row is one row and three keys: a build at `build:`, a cold
  // reviewer at `review:`, whatever is left at `proposed:`. Each is its own
  // path so that editing one of them writes one of them.
  ["steps", "build"],
  ["steps", "review"],
  ["steps", "proposed"],
  ["env", "required"],
  ["runtime", "agent"],
  ["steps", "end"],
  // No `["steps", "merge"]`: the page stopped writing that key with `#270`, and the
  // merge decision's `human:` goes to `["steps", "proposed"]` above — which is the
  // same path the checks row writes, because they are two things in one list.
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
    "steps.merge": `${DECISIONS[0]!.question} ${mergeConsequence(state.draft)}`,
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
 * that says `extends:` and has no `gates:`, setting `steps.end` alone writes a
 * `gates` of one point and every gate the preset supplied is gone. Writing the
 * block the page describes keeps them, spelled out in the file.
 */
export function wholeSteps(changes: readonly RecipeChange[], after: Recipe): RecipeChange[] {
  const rest = changes.filter((c) => c.path[0] !== "steps");
  return rest.length === changes.length ? [...changes] : [...rest, { path: ["steps"], value: after.steps }];
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
