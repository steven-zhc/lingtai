/**
 * The recipe: `~/.lingtai/<project>/recipe.yml`, on this machine, with
 * `runtime.agent` and `runtime.limits` from `~/.lingtai/config.yml`
 * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §3, #180).
 * `local.ts` reads it; this file is its schema.
 *
 * **It is not in the managed repository any more.** A `.lingtai/config.yaml`
 * committed there is an ordinary file: nothing reads it to run anything, and
 * editing it changes nothing. Before #180 it was, and the rule that made that
 * safe was 0005's — *read from `origin/<base>`, never from the agent's branch*,
 * with `tamper` catching an edit to it. That rule now holds by location: an
 * agent's blast radius is its worktree, and `~/.lingtai/` is not in it.
 *
 * Nothing sits above this file. The workflow is the recipe's to define, and
 * Lingtai does not second-guess it — what Lingtai owns is *where the file is
 * read from*.
 */
import { z } from "zod";
import { Tier, RuntimeId, type Step, isEventType, isRetiredEventType } from "@lingtai/domain";
import { PREFIX } from "@lingtai/env";
import {
  type Plugin,
  type PluginSecrets,
  definePlugin,
  disclose,
  pluginNaming,
  pluginsNamed,
  readFields,
} from "./plugin.ts";
import { parseDuration } from "./duration.ts";

/**
 * The names an **extension** may read, declared beside the extension itself
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
 *
 * `run:` is the single extension point (0037 §2), its code is not trusted, and
 * this is where it says which of this machine's credentials it needs. The
 * values are 0021's — `~/.lingtai/env/<project>.env` over the machine's own
 * file — so this file stays a list of names and stays safe to commit, exactly
 * as `env.required` does. **This is 0021's second consumer, not a second
 * mechanism.**
 *
 * **Absent means nothing, not everything.** A command used to be handed the
 * environment the *agent* was given, which is how a Telegram bot token put in
 * one place would reach every extension at once. The declared set is the whole
 * set, and an extension that declares nothing gets only what
 * `runnableEnv` gives any process — `PATH`, `HOME` and the four beside them,
 * which are how a binary is found rather than credentials.
 *
 * **`LINGTAI_*` is refused, and the refusal names the variable.** 0037 §1's
 * reason for distrusting an extension's code is, in as many words, that it
 * "can hang, exit, leak, or read `LINGTAI_DATABASE_URL`" — this system's own
 * log. It is a *prefix* and not a list because `#63` made every name Lingtai
 * reads for itself begin `LINGTAI_`, which is the same reason `isMachineOwn`
 * in `@lingtai/agent-env` is one rule: 0021 deleted `RESERVED` because a
 * denylist is a thing to keep up to date, and a prefix is not.
 *
 * Refused *here*, at the recipe, rather than at the point of use: `lingtai
 * doctor` and `lingtai add` both resolve a recipe without running anything, so
 * a declaration that cannot be honoured is red before a run rather than during
 * one.
 *
 * It costs Lingtai's own recipe nothing, and that is worth writing down because
 * it looks like it should: `LINGTAI_TEST_DATABASE_URL` is what this repository's
 * suite needs, and `pnpm typecheck && pnpm test` reads it from the `.env.local`
 * this run planted in the worktree (`env.plantAt`), not from its environment.
 * A project's own file keeps its own names, so no other repository has a
 * `LINGTAI_` name to declare in the first place.
 */
export const ExtensionEnvNames = z
  .array(z.string())
  .default([])
  .superRefine((names, ctx) => {
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      ctx.addIssue({
        code: "custom",
        message:
          `"${name}" is one of Lingtai's own names and cannot be declared for an extension — ` +
          `every name Lingtai reads for itself begins "${PREFIX}" (#63), and an extension's code ` +
          "is not trusted with them (0037 §1). A project's own variable keeps its own name.",
      });
    }
  });

/** The outcomes `end` fires on, which is what the two effects filter by. */
const WHEN = z.enum(["landed", "blocked", "failed", "closed", "any"]);

/**
 * A command. Its exit code is the verdict, and `env` is every credential it
 * gets — see `ExtensionEnvNames`. This is the extension point (0037 §2), which
 * is why it is the only one of the six declaring an `env` field at all:
 * `agent`, `watch` and `human` are the core's own and run in the core's own
 * process, so a recipe writing `env:` under one of them is refused by name
 * (0061 §9) rather than having it accepted and ignored.
 */
export const runPlugin = definePlugin("run", {
  run: z.string(),
  timeout: z.string().default("15m"),
  env: ExtensionEnvNames,
});

/** A cold reviewer, given the diff and this prompt. */
export const agentPlugin = definePlugin("agent", { agent: z.string() });

/** Globs against the diff's file list; a match holds or fails. */
export const watchPlugin = definePlugin("watch", {
  watch: z.array(z.string()).min(1),
  then: z.enum(["request-approval", "fail"]).default("request-approval"),
});

/** Waits for a person. The string is the question they are asked. */
export const humanPlugin = definePlugin("human", { human: z.string() });

/**
 * Closes the issue. Only meaningful at `end`, which is the one point that
 * cannot refuse — these run for effect.
 *
 * `when` filters on the outcome, because `end` fires on *every* terminal
 * state. "Close it when it lands, label it when it is blocked" is then one
 * configuration rather than two mechanisms.
 *
 * `closed` is the fourth, and `any` includes it (0044): a ticket a person
 * ended is a ticket whose issue this action is the right way to close. It is
 * also the pairing that removes a manual step — `lingtai close` used to
 * append a terminal and leave the GitHub issue open, so somebody still had
 * to run `gh issue close` by hand afterwards.
 */
export const closePlugin = definePlugin("close", {
  close: z.literal(true),
  when: WHEN.default("landed"),
});

/** Sets labels. Lingtai's own are replaced; everybody else's are kept. */
export const labelsPlugin = definePlugin("labels", {
  labels: z.array(z.string()),
  when: WHEN.default("any"),
});

/**
 * **The branch a pass owns, cut** — a name for `provisionWorktree` in
 * `packages/repo/src/worktree.ts`, which is what has always done this
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * A map rather than a scalar, which is 0061 §2's rule — *a scalar where one
 * reads well and a map where it does not* — applied to a plugin that carries
 * two settings and no obvious principal one. It is also the shape
 * [`the-v2-recipe.md`](../../../doc/design/the-v2-recipe.md) §1 writes, and
 * that file is the target T3 is checked against.
 *
 * **`base` is written here and nowhere else, and that is what this plugin is
 * for.** `repo.base` is where it is written today; when the file becomes
 * `steps:` this is where it moves, and the merge lane goes on being *handed*
 * it rather than declaring it a second time (§4). Until then no step accepts
 * this key — `whyNoKindAt` refuses it at all ten — so the two are not two
 * homes for one setting; they are one home and the name of the one it will
 * become.
 *
 * `submodules` keeps `repo.submodules`'s default and its reason: `git worktree
 * add` leaves submodule directories empty, and the tests that import one then
 * fail in a way that reads as the agent's fault.
 */
export const worktreePlugin = definePlugin("worktree", {
  worktree: z.strictObject({
    /** The branch the agent's work is cut from and lands on. `origin/<base>`, never local state. */
    base: z.string(),
    submodules: z.boolean().default(false),
  }),
});

/**
 * **The same branch, landed** — a name for the integrator,
 * `packages/repo/src/integrate.ts`: the base in, verify, the base out.
 *
 * **It declares no `base:`, and that is deliberate rather than an omission**
 * (0061 §4). `base` is one value that flows: `worktree.ts:133` and
 * `integrate.ts:73` both take it as a parameter and exactly one place writes
 * it. Giving this plugin one of its own would manufacture a disagreement
 * between what a pass cut and what it lands — a failure that cannot happen
 * today and that no amount of checking would be as good as not having.
 *
 * `strategy` has one legal value because `integrate.ts` offers one: `git merge
 * --no-edit` of the branch into the base, then a push that is a fast-forward
 * where it can be one. A second value here would be a behaviour this repository
 * does not have, declared as though it did — `#61` one level down — so the
 * enum says what the code does and grows when the code does.
 */
export const mergePlugin = definePlugin("merge", {
  merge: z.strictObject({
    strategy: z.enum(["merge-commit"]).default("merge-commit"),
  }),
});

/**
 * **The closed set**, and the only list of plugins anywhere.
 *
 * It lists the plugins and not their fields: each of the eight above declares
 * what it accepts, and this array is what the resolve walks to find out *which*
 * of them an action names (0061 §9). A closed set needs no namespace — 0037 §2
 * settled that there is no plugin system and an extension is a command — so a
 * key is a bare word and a word that is not one of these is refused.
 *
 * **Eight of the twelve 0061 §3 names.** `worktree:` and `merge:` are in the
 * set and in no step's row: they are names for code the pass calls directly
 * today, so every cell of theirs refuses, by a sentence that says where that
 * code is called instead. That is the same two-valued rule the six steps with
 * no call site are held to — **naming a thing is not wiring it** — read down
 * the other axis.
 *
 * `as const`, so `ActionKind` and `GateAction` are read off it rather than
 * written down a second time.
 */
export const PLUGINS = [
  runPlugin,
  agentPlugin,
  watchPlugin,
  humanPlugin,
  closePlugin,
  labelsPlugin,
  worktreePlugin,
  mergePlugin,
] as const;

/**
 * One thing that runs at a step.
 *
 * The shape is GitHub Actions' — a `name`, exactly one key saying *which plugin
 * this is*, and that plugin's fields beside it. Copied rather than invented
 * because [ADR 0005](../../../doc/decisions/0005-config-in-target-repo.md)
 * already frames a recipe as a workflow file, and a second dialect for the same
 * idea is a second thing to learn for no gain.
 *
 * A union rather than a discriminated union: the discriminator is *which key is
 * present*, which zod cannot switch on. **What that used to cost is gone**: a
 * malformed action gave the union's own unreadable error, because zod had tried
 * six schemas and could not say which one the writer meant. `actionsAt` asks
 * which key is present first and the plugin that owns it second, so the refusal
 * is that plugin's and names the field. This union is now only what gives the
 * closed set a single type.
 */
export const GateAction = z.union([
  runPlugin.schema,
  agentPlugin.schema,
  watchPlugin.schema,
  humanPlugin.schema,
  closePlugin.schema,
  labelsPlugin.schema,
  worktreePlugin.schema,
  mergePlugin.schema,
]);
export type GateAction = z.infer<typeof GateAction>;

/** The action's kind, for an event and for dispatch. Exactly one key decides it. */
export type ActionKind = (typeof PLUGINS)[number]["key"];

/** The plugin an action names, against the closed set. */
export function pluginOf(action: unknown, plugins: readonly Plugin[] = PLUGINS): Plugin | null {
  return pluginNaming(action, plugins);
}

export function kindOfAction(action: GateAction): ActionKind {
  // The loop rather than `pluginOf`, which answers `null` for an action naming
  // two plugins: a resolved recipe can hold no such thing, and this is read on
  // the board's path where the first key is a better answer than none.
  for (const plugin of PLUGINS) if (plugin.key in action) return plugin.key;
  return "human";
}

/**
 * The resolved steps as anything outside a plugin may see them — every field a
 * plugin marked `noLog` standing in for itself (0061 §9).
 *
 * One function for the log, the board and a refusal, so all three learn a
 * secret field from the one declaration. It answers the object it was given
 * where there is nothing to withhold, which is every recipe today. What a
 * withheld field becomes, and why it is not simply dropped, is `withheld` in
 * `plugin.ts`: a value taken out of the hash would make two recipes that differ
 * in a credential one document (0047 §2).
 */
export function discloseSteps<Steps extends Readonly<Record<string, readonly GateAction[]>>>(
  steps: Steps,
  plugins: readonly PluginSecrets[] = PLUGINS,
): Steps {
  const shown: Record<string, unknown> = {};
  for (const [step, actions] of Object.entries(steps)) {
    shown[step] = actions.map((action) => disclose(action, plugins));
  }
  return shown as Steps;
}

/**
 * **Which of the eight kinds each of the ten steps actually runs.**
 *
 * Eighty cells, and ten of them used to be accepted here, resolved into
 * `GatesResolved`, printed by `lingtai add`, drawn on the board — and never
 * called (`#61`). `merge` was a sixteenth until `#58` built its pipeline, and
 * the weeks it spent declared-but-unbuilt are the argument for writing the
 * table down: *a control the log claims and the code does not have is worse
 * than an unimplemented one, because every signal an operator has says it is
 * there* (`run-once.ts`, section 11).
 *
 * So the matrix lives beside the schema that enforces it, and
 * `doc/reference.md`'s copy is checked against this constant by a test rather
 * than kept by hand — the copy in `#61`'s own body was wrong about `merge`
 * within three weeks of being written.
 *
 * **It does not narrow the closed set of steps** ([0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md),
 * widened to ten by [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §5).
 * All ten are still steps and the set may still never grow; what is narrowed is
 * what a recipe may *say* today, to exactly what today's code does. The day
 * something runs a pipeline at `design`, its row grows and nothing else moves.
 *
 * **Six empty rows, and they are the honest half of widening the vocabulary.**
 * Naming `claim`, `design`, `implement`, `build` and `review` is what lets the
 * log and the board draw the pass 0058 §3 describes; it does not build the
 * pass, which is that plan's next ticket. Until it is built, an action written
 * at one of them is the exact `#61` failure one level up — resolved, recorded,
 * drawn, never called — so it is refused by name when the recipe resolves.
 *
 * **And two empty columns, for the same reason read the other way.**
 * `worktree:` and `merge:` name code the pass calls itself, so no row carries
 * them and `CALLED_DIRECTLY` is what their twenty cells refuse with.
 */
export const KINDS_AT = {
  /** Nothing yet: the queue picks the item and no pipeline is constructed here. */
  claim: [],
  /** Nothing yet: no pipeline is constructed at `admit` anywhere. */
  admit: [],
  /** A command. The other three want a diff or an answer, and there is neither yet. */
  prepared: ["run"],
  /** Nothing yet: 0058 §3's design step is named here and built by the pass ticket. */
  design: [],
  /** Nothing yet: the implementing agent is dispatched by `run-once.ts`, not by a recipe entry here. */
  implement: [],
  /** Nothing yet: today's build is a `run:` action at `proposed`. */
  build: [],
  /** Nothing yet: today's review is an `agent:` action at `proposed`. */
  review: [],
  proposed: ["run", "agent", "watch", "human"],
  merge: ["run", "agent", "watch", "human"],
  /** The two effects — the two kinds that carry `when:`. */
  end: ["close", "labels"],
} as const satisfies Record<Step, readonly ActionKind[]>;

/**
 * Where the work a not-yet-built step names is actually done today.
 *
 * The half of the refusal that is worth reading. *Nothing runs here* leaves an
 * operator with a recipe key and no next move; *the build runs as a `run:`
 * action at `proposed`* is the line they can act on, and it is also the thing
 * that will stop being true when the pass ticket lands — at which point this
 * table and that step's `KINDS_AT` row move together.
 */
const WHERE_INSTEAD: Record<"claim" | "design" | "implement" | "build" | "review", string> = {
  claim: "the queue picks the item by `source.kinds`, `source.exclude` and `runtime.assignee`",
  design: "there is no design step: the implementing agent is handed the issue body and works from it",
  implement: "`run-once.ts` dispatches the implementing agent directly, under `runtime.limits`",
  build: "the build is a `run:` action at `proposed`",
  review: "the review is an `agent:` action at `proposed`",
};

/**
 * **The same table read down the other axis**: a plugin the pass calls itself,
 * and where it calls it.
 *
 * `WHERE_INSTEAD` above is *this step is named and not built*; this is *this
 * plugin is named and not read*. Both are `#61`'s failure caught before it can
 * happen, and both say the one thing an operator can act on — not *nothing
 * runs this* but **the code is already running, here, and the recipe is not yet
 * what tells it to**.
 *
 * Why these two are declared at all before anything reads them: a plugin no
 * list carries is a plugin no step refuses
 * ([`the-v2-recipe.md`](../../../doc/design/the-v2-recipe.md) §3.2). Outside
 * the closed set, `worktree:` written under `end:` is *an action naming no
 * plugin* — a true refusal with the wrong subject. Inside it, the refusal is
 * the sentence below, and the day the file becomes `steps:` this entry goes
 * and a `KINDS_AT` row arrives in the same diff.
 */
const CALLED_DIRECTLY: Partial<Record<ActionKind, string>> = {
  worktree:
    "`run-once.ts` cuts it itself before the pass reaches any step, from `repo.base` and " +
    "`repo.submodules` — `provisionWorktree` in `packages/repo/src/worktree.ts`",
  merge:
    "the merge lane runs it itself once everything before it has passed — `integrate` in " +
    "`packages/repo/src/integrate.ts`, which is handed `repo.base` rather than reading a base of its own",
};

/**
 * Why a step does not run a kind, in the words the refusal carries — or `null`
 * when it does.
 *
 * Every reason is a fact about the **step**, and that is why they are spelled
 * out rather than left as "unsupported": an operator told that `agent:` is
 * refused at `prepared` should not have to read `run-once.ts` to discover that
 * the reason is that nothing has been committed yet.
 *
 * **Two of them are facts about the plugin instead, and they are asked first.**
 * `worktree:` and `merge:` are refused everywhere and for one reason, so a
 * sentence about the step would be the less useful half of the truth at all
 * ten: *nothing runs a pipeline at `admit`* is right and leaves a reader
 * looking for the code that cuts their worktree, which `CALLED_DIRECTLY` names.
 */
export function whyNoKindAt(point: Step, kind: ActionKind): string | null {
  if ((KINDS_AT[point] as readonly ActionKind[]).includes(kind)) return null;
  const calledDirectly = CALLED_DIRECTLY[kind];
  if (calledDirectly !== undefined) {
    return (
      `no step reads a \`${kind}:\` action from the recipe yet — the plugin is the name ` +
      "[0061](doc/decisions/0061-the-recipe-is-the-pipeline.md) §3 gives code the pass already runs, and " +
      `it is wired to the recipe by the ticket that makes the file \`steps:\`. Today ${calledDirectly}. ` +
      "Refused rather than accepted here because an action nothing reads would be resolved, recorded on " +
      "the log, printed by `lingtai add`, drawn on the board — and never called (`#61`)"
    );
  }
  if (point === "admit") {
    return (
      "nothing runs a pipeline at `admit` — the step is in the closed set and no code reaches it, " +
      "so an action here would be resolved, printed, and never called. A question that has to be " +
      "asked before anything is spent is `lingtai ask`, which holds the item in the queue instead"
    );
  }
  // The five 0058 §3 named and the pipeline does not yet construct. One
  // sentence per step and not one for the group: *nothing runs here* is the
  // same refusal at all five, and **where the work actually happens today** is
  // different at each — which is the only part an operator can act on.
  if (point === "claim" || point === "design" || point === "implement" || point === "build" || point === "review") {
    return (
      `nothing runs a pipeline at \`${point}\` yet — the step is named by ` +
      "[0058](doc/decisions/0058-lingtai-is-a-development-pipeline.md) §3 so that the log, the recipe and the board " +
      `have a word for it, and the pass that runs it is that plan's next ticket. Today ${WHERE_INSTEAD[point]}. ` +
      "Refused rather than accepted here because an action at a step no code reaches would be resolved, recorded " +
      "in `GatesResolved`, printed by `lingtai add`, drawn on the board — and never called (`#61`)"
    );
  }
  if (point === "end") {
    return (
      "`end` fires on every terminal outcome and produces no verdict, so the only actions it can " +
      "carry are the two that run for effect — `close:` and `labels:`, the two that take `when:`"
    );
  }
  if (kind === "close" || kind === "labels") {
    return "it is an effect rather than a verdict, and only the `end` point carries out effects";
  }
  if (kind === "agent") {
    return "nothing has been committed at `prepared`, so a cold reviewer would be given no diff to read";
  }
  if (kind === "watch") {
    return "nothing has been committed at `prepared`, so the globs would be matched against no file list";
  }
  return (
    "a hold at `prepared` cannot be answered — the run is released back to the queue and the " +
    "question goes with it, so the item would re-claim, re-install and ask again on every pass. " +
    "Ask before the claim with `lingtai ask`, or at `proposed`, where there is a diff to approve"
  );
}

/**
 * The refusal, in the one wording the schema and `gatesFromRecipe` both use.
 *
 * **`tail` is the rest of the sentence, and it has a default rather than a
 * second function** (0061 §9). §8's rule grew one clause — *a step refuses a
 * plugin it cannot run, and a plugin refuses a field it does not understand* —
 * and the two halves of it have to read as one rule: the same opening names the
 * action, its kind and the step either way, and only what follows differs.
 */
export function kindRefusedAt(
  point: Step,
  kind: ActionKind,
  action: string,
  why: string,
  tail = "Refusing rather than accepting it: an action that is silently absent is worse than a run that will not start.",
): string {
  return `the "${action}" action is a "${kind}" at the "${point}" point, and ${why}. ${tail}`;
}

/** What a plugin's own refusal of a field says after the sentence above. */
const REFUSED_WHEN_IT_RESOLVED =
  "Refused when the recipe resolves, before a worktree, before an agent, before any money.";

/** What an action naming no plugin, or two, is told — and what the legal names are. */
function pluginRefusedAt(step: Step, action: unknown, named: readonly Plugin[]): string {
  const called = nameOf(action);
  const legal = PLUGINS.map((plugin) => `"${plugin.key}"`).join(", ");
  return named.length === 0
    ? `the "${called}" action at the "${step}" step names no plugin — an action carries exactly one of ` +
        `${legal}, and that key is what it is. Refusing rather than accepting it: an action that is ` +
        "silently absent is worse than a run that will not start."
    : `the "${called}" action at the "${step}" step names ${named.length} plugins — ` +
        `${named.map((plugin) => `"${plugin.key}"`).join(" and ")} — and an action carries exactly one. ` +
        "Which of them was meant is not Lingtai's to guess.";
}

/** What a refusal calls an action whose `name` may itself be what is wrong. */
function nameOf(action: unknown): string {
  const written = (action as { name?: unknown } | null)?.name;
  return typeof written === "string" ? written : "(unnamed)";
}

/**
 * One step's actions: the plugin each one names, checked by that plugin, and
 * **every** problem in one answer.
 *
 * The refusal is here rather than in the conductor because this is the file a
 * recipe is read by, and a step that cannot run the action should say so when
 * the recipe resolves — before a ticket is claimed, a worktree cut, or an
 * install paid for. `lingtai doctor`, `lingtai add` and every pass resolve the
 * recipe, so all three name it.
 *
 * **Three questions in order, and each one is somebody's.** *Which plugin is
 * this* is the shape's, *may this step run it* is the step's (`whyNoKindAt`),
 * and *are these its fields* is the plugin's (`readFields`). They stop at the
 * first that answers, because a field's wording is moot under an action the
 * step will not run at all — but an action that stops does not stop the ones
 * after it, and a step that stops does not stop the other nine. A resolve that
 * halted at the first bad field would make a person fix one thing per attempt,
 * which is `#222`'s lesson about the build step applied to configuration.
 *
 * `z.unknown()` rather than the union, so the dispatch is the key's and not
 * zod's: a union tries six schemas and reports six failures about one action.
 */
function actionsAt(step: Step) {
  return z
    .array(z.unknown())
    .transform((written, ctx) => {
      const resolved: GateAction[] = [];
      written.forEach((action, i) => {
        const named = pluginsNamed(action, PLUGINS);
        const plugin = pluginNaming(action, PLUGINS);
        if (plugin === null) {
          ctx.addIssue({ code: "custom", path: [i], message: pluginRefusedAt(step, action, named) });
          return;
        }
        const kind = plugin.key as ActionKind;
        const why = whyNoKindAt(step, kind);
        if (why !== null) {
          ctx.addIssue({ code: "custom", path: [i], message: kindRefusedAt(step, kind, nameOf(action), why) });
          return;
        }
        const read = readFields(plugin, action);
        if (read.problems !== undefined) {
          for (const problem of read.problems) {
            ctx.addIssue({
              code: "custom",
              path: [i, ...problem.at],
              message: kindRefusedAt(step, kind, nameOf(action), problem.why, REFUSED_WHEN_IT_RESOLVED),
            });
          }
          return;
        }
        resolved.push(read.value as GateAction);
      });
      return resolved;
    })
    .default([]);
}

/**
 * What runs at each of the ten steps.
 *
 * Every step is present and defaults to empty, which is the whole design in
 * one line: **an unconfigured step is skipped, and the skip is visible.** A
 * missing key here is not "undefined", it is "nothing runs, and the board says
 * so" (ADR 0016 §4). That is also
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §5 — *the
 * file may omit a step; the resolved recipe may not* — and this object is the
 * mechanism that ADR names.
 *
 * Order within a step is the array's. The first refusal wins and the actions
 * after it do not run — continuing would spend money producing verdicts about a
 * diff that is not going anywhere.
 *
 * **Strict, and that is what makes the closed set enforceable.** A key that is
 * not one of the ten is a typo or a stale name, and zod's default is to drop
 * it silently — which would mean a recipe whose `merg:` block never runs and a
 * board that says `skipped` because it was told nothing was configured. That is
 * exactly the "configured and did not run" failure the model calls Lingtai's
 * bug (ADR 0016 §4). It is also what a recipe still saying `diff:` would hit
 * after [0018](../../../doc/decisions/0018-the-proposed-point.md): it fails to
 * resolve, loudly, naming the key.
 *
 * **Strict about the kind at a step, too, and for the same reason** (`#61`).
 * A key that *is* one of the ten, carrying an action that step does not run,
 * is the identical failure reached one level down: it resolves, it is drawn,
 * and nothing happens. `KINDS_AT` is which pairs run and `whyNoKindAt` is what
 * the refusal says — and it is what keeps the five steps 0058 §3 named but has
 * not yet built from becoming five silent cells: their keys parse, and any
 * action in them is refused with the step's own sentence.
 */
export const GateMap = z.strictObject({
  claim: actionsAt("claim"),
  admit: actionsAt("admit"),
  prepared: actionsAt("prepared"),
  design: actionsAt("design"),
  implement: actionsAt("implement"),
  build: actionsAt("build"),
  review: actionsAt("review"),
  /** Was `diff` until [0018](../../../doc/decisions/0018-the-proposed-point.md). */
  proposed: actionsAt("proposed"),
  merge: actionsAt("merge"),
  end: actionsAt("end"),
});
export type GateMap = z.infer<typeof GateMap>;

/**
 * An event type the log actually has, as a subscription's `on:` entry.
 *
 * **The check is the whole point of putting `on:` in the recipe.** A name that
 * is not in the catalogue is a typo or a name that has moved, and the failure
 * it produces without this is the worst kind a notifier can have: a
 * subscription that parses, resolves, renders, and never once fires. Nobody
 * finds that out — you only ever notice the message you did not get.
 *
 * So it names the offending string rather than saying the list is wrong, the
 * same way `env`'s strictness names the misspelled key. `EVENTS` in
 * `packages/domain/src/events.ts` is the catalogue, and `isEventType` is the
 * one reading of it — a second list here would be a list to keep correct.
 *
 * A **retired** type is refused for the same reason and said differently: it is
 * spelled right, it is in the catalogue, and nothing appends it any more
 * (`RETIRED`), so subscribing to it is the identical silent nothing reached by
 * a different mistake.
 */
const SubscribedEvent = z.string().superRefine((name, ctx) => {
  if (isRetiredEventType(name)) {
    ctx.addIssue({
      code: "custom",
      message: `"${name}" is a retired event type — nothing appends it any more, so this would never fire`,
    });
    return;
  }
  if (!isEventType(name)) {
    ctx.addIssue({
      code: "custom",
      message: `"${name}" is not an event type — the catalogue is EVENTS in packages/domain/src/events.ts`,
    });
  }
});

/**
 * Something told about events, which the loop does not wait for
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3).
 *
 * The same `run:` a gate action has, and the whole of the difference is that
 * nothing reads the exit code: a gate action's verdict is about a commit, and
 * this one has no verdict. That is 0016 §5's rule — *if the loop must wait for
 * it, it is a gate action; if it cannot affect the outcome, it is a
 * subscriber* — with the mechanism filled in and no plugin system underneath
 * it.
 *
 * **One mechanism doing two jobs.** `on:` is both the declaration of what this
 * subscriber is for and the subscription itself, so the core knows what it
 * wants before it spends a process finding out. That is what VS Code's
 * activation events buy, and it is the half of their design worth copying.
 *
 * **Strict, for the reason `GateMap` and `env` are.** A key that is not one of
 * the four is a typo or a name from a draft of 0037 — `events:`, `uses:` — and
 * zod's default is to drop it silently, which here would mean a subscriber
 * subscribed to nothing while the recipe reads as though it were configured.
 */
export const Subscriber = z.strictObject({
  name: z.string(),
  /** The types it wants. Empty is not a subscriber, it is a command nobody runs. */
  on: z.array(SubscribedEvent).min(1),
  /** The command. Its exit code is discarded — see 0037 §5. */
  run: z.string(),
  /**
   * Every credential this subscriber gets, and nothing else reaches it — see
   * `ExtensionEnvNames`.
   *
   * This is the case 0037 §1 is written about in as many words: *"a Telegram
   * bot token must reach the Telegram extension and nothing else"*. Declaring
   * it beside the subscriber is what makes "and nothing else" a fact rather
   * than an intention, because the alternative — the daemon's own environment —
   * hands it to every extension at once.
   */
  env: ExtensionEnvNames,
});
export type Subscriber = z.infer<typeof Subscriber>;

/**
 * `mine`: only issues assigned to `login`. `unassigned`: only issues assigned
 * to nobody. `both`: every issue, whoever it is assigned to — today's queue.
 */
export const AssigneeTake = z.enum(["mine", "unassigned", "both"]);
export type AssigneeTake = z.infer<typeof AssigneeTake>;

/**
 * The machine's GitHub login and what it takes by assignee.
 *
 * The login is not proof of anything, and does not need to be: a wrong one
 * hands this machine somebody else's tickets on the next pass, which is a
 * mistake that shows itself (0046 §2).
 */
export const AssigneeRule = z
  .strictObject({
    login: z.string().min(1).optional(),
    take: AssigneeTake.default("both"),
  })
  // `mine` with nobody named would match no issue at all, and an empty queue
  // reads exactly like a repository with nothing to do.
  .refine((rule) => rule.take !== "mine" || rule.login !== undefined, {
    message: "take: mine needs a login — the GitHub login this machine's issues are assigned to",
    path: ["login"],
  });
export type AssigneeRule = z.infer<typeof AssigneeRule>;

export const Recipe = z.object({
  version: z.literal(1),
  /** Pulls install/build/test defaults from a preset shipped with Lingtai. */
  extends: z.string().optional(),

  repo: z.object({
    base: z.string(),
    /** `git worktree add` does not populate submodules; not doing so breaks every
     *  test that imports one, and reads as "the agent broke the tests". */
    submodules: z.boolean().default(false),
  }),

  /**
   * Getting the worktree workable before the agent starts. Ordered, and the
   * first refusal stops the run.
   *
   * Optional because it is genuinely optional: a Go repository may need nothing
   * at all. But `git worktree add` copies no `node_modules`, so for most of them
   * the absence of this is the difference between an agent that can run the
   * tests and one writing blind.
   *
   * Not a gate. A gate's verdict is about a commit — `onSha` — and a force-push
   * invalidates it by arithmetic. A prepare step runs before the agent has
   * written anything and holds no verdict about anything.
   */
  source: z.object({
    /**
     * Labels of yours that mark an issue as work, **most wanted first**.
     *
     * One list doing three jobs, and that is the design rather than an
     * economy: it is the vocabulary (a label outside it is not a kind at all),
     * the filter (`kindOf` matches against exactly this), and the priority
     * order (earlier wins).
     *
     * Free-form since #76, and `exclude` always was. There used to be a
     * `WorkKind` enum in the core — `bug` · `feature` · `enhancement` ·
     * `tech-debt` — and a recipe naming any other label failed to resolve,
     * which took *every* issue in the project down with it rather than the one
     * label. It also contained `enhancement`, which no recipe had ever used,
     * and omitted `documentation`, which one wanted. Which of a repository's
     * labels name work is a fact that repository has and this schema does not,
     * which is 0016 §7 exactly.
     */
    kinds: z.array(z.string()).min(1),
    /**
     * Labels of yours that must keep the agent off a ticket, matched
     * case-insensitively by whole name.
     *
     * **This is the only reason an issue is passed over for its labels.** There
     * was a rule in `discover.ts` too, skipping anything labelled `agent:*` as
     * belonging to another system; it is gone. A namespace is not a meaning —
     * `agent:hold` and `agent:followup` share a prefix and mean opposite
     * things — and which of a repository's labels are holds is a fact that
     * repository has and this schema does not.
     *
     * Whole names rather than patterns, deliberately: `agent:*` would have to
     * be spelled with an exception for the one label in it that means "ready",
     * and an exclude list with negation in it is a small language. List them.
     */
    exclude: z.array(z.string()).default([]),
    /**
     * How long a failed attempt keeps its own ticket out of the queue
     * ([0028](../../../doc/decisions/0028-the-backoff-is-the-recipes.md)).
     *
     * A failed run releases its task, a release is a completion event, and a
     * completion event is what tells the conductor to look again — so without
     * this the top of the queue is the ticket that just failed, forever, at
     * agent prices. The old harness re-ran #58 and #59 five times for roughly
     * $29 exactly that way.
     *
     * Here rather than compiled into Lingtai for the reason `repair` is: how
     * long a failure of *this* repository's is worth waiting out depends on
     * what its failures usually are, and that is a thing the repository knows
     * and the core cannot see (0016 §7). One hour by default, flat — the wait
     * does not grow with attempts, because what changes between attempts is
     * what the next one is told (#82) and not how long it sat.
     *
     * A duration like `runtime.limits.wall`, and it must be a positive one:
     * zero is not a shorter backoff, it is the absence of the guard, and the
     * thing a person wants when they reach for it is `lingtai now`.
     */
    backoff: z
      .string()
      .default("1h")
      // Checked here rather than left to throw at the point of use: a recipe
      // that will not resolve names the key it failed on, and an exception out
      // of the middle of a queue pass names nothing.
      .refine((text) => positiveDuration(text), { message: "must be a positive duration, like 1h" }),
  }),

  /**
   * What the run cannot proceed without.
   *
   * **Strict, for the reason `GateMap` is.** This was `allow` — an allowlist,
   * meaning "plant these if they happen to exist" — and that meaning cost $0.97
   * and ten turns against a database the agent could not reach, with one log
   * line as the only sign. A repository naming a variable is a repository saying
   * it needs one ([0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)).
   * A recipe still saying `allow:` must therefore fail to resolve and name the
   * key, rather than resolve to an empty list and refuse nothing — the same
   * silent half-move [0018](../../../doc/decisions/0018-the-proposed-point.md)
   * made zod's default drop.
   */
  env: z.strictObject({
    /**
     * If present, **only** these names reach the agent.
     *
     * Back in the schema since `#60`, with the meaning it never had before: a
     * filter over data that already exists, not a list of names to go looking
     * for in the process environment. Absent and empty are different — absent
     * means "no allowlist", `[]` means "nothing passes" — which is why this is
     * `optional` and not `.default([])`.
     */
    allow: z.array(z.string()).optional(),
    /** If present, these names do not reach the agent, whatever `allow` says. */
    deny: z.array(z.string()).default([]),
    /**
     * Variable NAMES only. Values resolve at runtime from somewhere the agent
     * cannot see, so this file is safe to commit.
     *
     * **A check, not a filter** ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
     * It is evaluated against the merged data, before `allow`/`deny` apply, so a
     * name that is both `required` and `deny`ed is legal and says two true
     * things: this machine must be configured with it, and this run does not
     * need to see it.
     */
    required: z.array(z.string()).default([]),
    /**
     * Host segments that refuse a value outright — production host patterns,
     * and the field `agent-env`'s tripwire said it was waiting for.
     *
     * **Added to `prod` and `production`, never in place of them**
     * (`productionPatterns`): this file is one the governed agent can edit, and
     * a field that could drop `prod` would let that edit turn the tripwire off.
     * (0005's "add strictness, never remove it" is not the ground: 0016
     * withdrew it.) Those two are inert on a managed database named by a random ref
     * (`#51`), so a repository
     * whose production host is `db.<ref>.supabase.co` names `<ref>` here. That
     * puts an identifier — not a credential — in a committed file, and it is
     * meant to: a reviewer sees the host being refused.
     *
     * Checked before the claim against every value that reaches the agent or an
     * extension, from either file: the agent's by `resolveAgentEnv`, after
     * `allow`/`deny`, and each extension's declared names by `extensionEnv`,
     * which reads them before `deny` — both in `runOnce`, at stage `env`, and
     * both in `lingtai doctor` (`env: <project>`, `env: <project> extensions`).
     *
     * An entry is a segment or a run of them — `<ref>`, `prod-db`, or a whole
     * host — matched segment by segment against a URL's hostname. One that
     * could never equal a run of a hostname's segments is refused here rather
     * than shown to a reviewer as a host being refused: an empty segment
     * (`.supabase.co`), and anything a hostname does not hold — a port
     * (`db.<ref>.supabase.co:5432`), a scheme (`postgresql://…`), a user, a path.
     */
    refuseHosts: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9_]+(?:[.\-][a-z0-9_]+)*$/i,
            "a host, or segments of one — no port, scheme, user or path, and no empty segment",
          ),
      )
      .default([]),
    /** Where the filtered env file is planted inside the worktree. Rarely the
     *  repo root — Next/Prisma/vitest read it from the app directory. */
    plantAt: z.string(),
  }),

  // Spelled out rather than `.default({})`: all ten steps exist whether or
  // not a recipe mentions them, and writing that here says so once. 0061 §5 is
  // this line — the file may omit a step, the resolved recipe may not.
  gates: GateMap.default({
    claim: [],
    admit: [],
    prepared: [],
    design: [],
    implement: [],
    build: [],
    review: [],
    proposed: [],
    merge: [],
    end: [],
  }),

  /**
   * Who is told what happened, and about which events.
   *
   * Here rather than in the daemon because **which events are worth telling
   * somebody about is a fact about a channel, not about Lingtai.**
   * `DEFAULT_SUBSCRIPTIONS` was four types in `packages/daemon/src/notify.ts`,
   * the same for every project, changeable only by editing the daemon — and it
   * was four *because it was a desktop notification*, which interrupts. A
   * landed task is not worth interrupting for and is worth a Telegram message,
   * and only a per-channel list can say both. That is 0016 §7's argument again:
   * the repository knows which of its outcomes it wants to hear about and the
   * core cannot see it.
   *
   * It is gone since `#123`, and this is the whole of what replaced it: the
   * desktop notification is `node apps/cli/src/notify.ts` under Lingtai's own
   * `subscribers:`, started by the same code that starts
   * `node packages/telegram/src/cli.ts` beside it (`#125`). There is no list in the daemon to fall back to, which
   * is what makes the paragraph below true rather than decorative.
   *
   * Defaulted to empty rather than optional, like `gates`: a project that
   * declares no subscriber has *declared none*, which is a thing that can be
   * rendered, rather than an absence.
   */
  subscribers: z.array(Subscriber).default([]),

  runtime: z.object({
    agent: RuntimeId.default("claude-code"),
    /**
     * How contained the runtime must be. `run-once` refuses to dispatch when the
     * runtime cannot meet it, which is the whole of the enforcement.
     *
     * Defaulted rather than optional: nothing sits underneath it to fall back
     * to, so an absent tier meaning "unspecified" would be a run whose
     * containment nothing states. `guarded` is what every
     * run has actually used ([ADR 0007](../../../doc/decisions/0007-dual-runtime.md)).
     */
    tier: Tier.default("guarded"),
    prompt: z.string().optional(),
    /**
     * What one pass may spend, as one block
     * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
     *
     * `turns` and `wall` bound **one agent run**; `rounds` bounds **how many of
     * them a pass may buy**; `restarts` bounds **how many passes one ticket may
     * buy** (0040). Keeping all four here rather than in sections of their own
     * is the decision, not tidiness: what a ticket costs is then
     * `(restarts + 1) × (rounds + 1) × wall`, readable without leaving the
     * block. On 2026-09-10 the drain told an operator it would wait at most one
     * `wall`, which the fix loop had already made false — a sentence in one file
     * chasing a number kept in another. Four numbers in one place cannot drift
     * apart like that, and `passCeiling` is the one function that multiplies
     * them, so nothing else writes the product down.
     */
    limits: z
      .object({
        turns: z.number().int().positive().default(300),
        /**
         * A duration, checked here for the reason `source.backoff` is checked
         * where it is written: `parseDuration` throws, and a throw out of the
         * middle of something *reading* the resolved recipe names neither the
         * key nor the file. `wall: "90"` — the unit forgotten — resolved
         * cleanly and threw later inside the board's reading of it, where it
         * was read as *the recipe could not be read* (#218).
         */
        wall: z
          .string()
          .default("2h")
          .refine((text) => positiveDuration(text), { message: "must be a positive duration, like 2h" }),
        /**
         * How many times a pass sends the agent back, carrying what refused it.
         *
         * **Two by default, and the number has an argument.** 0025 §3's rule for
         * a spending default is *the smallest number that makes the feature
         * exist*, which would say one — but this key replaces two ceilings that
         * were one each, and 0038 §4's reason for splitting them was real: a
         * build going red and a review refusing are different failures, and a
         * single round shared between them means whichever happens first decides
         * whether the other gets an attempt at all. That is the race 0038 called
         * *not a budget*. A pass that fixes a red build and then meets a finding
         * needs two rounds to do what two purses of one used to do, so two is
         * the smallest number that does not quietly take the feature away.
         *
         * Zero is legal and means **every refusal goes straight to a person** —
         * what `repair.on: false` used to say, now said in the block where the
         * other limits are. A boolean beside a count whose zero already means
         * the same thing is a redundant pair (0039 §4).
         *
         * **And it is the only number a refusal spends against** (`#143`). It
         * was read twice for a while: once here, for a round inside the pass,
         * and once by `decideRepair` for a whole new run the merge lane bought
         * — one key naming two extents, which is what `#141` left behind and
         * 0039 §Consequences says should not exist. The second reading is gone
         * with the purchase, so `rounds` means one thing: how many times a
         * **pass** sends the agent back.
         *
         * Lingtai's *own* failures never reach it, in code (`whoseFailure`): no
         * recipe can make an agent able to fix a database it cannot reach.
         */
        rounds: z.number().int().nonnegative().default(2),
        /**
         * How many times a spent `rounds` ceiling starts the work over instead
         * of asking a person — a fresh pass, from a worktree cut off the base.
         *
         * **The breadth half of the pair `rounds` is the depth half of**
         * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
         * A round buys another attempt at *this* approach; a restart buys
         * another approach. When the approach is the defect, no value of
         * `rounds` reaches the fix — which is what
         * [experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)
         * measured: `#144` patched across two rounds refused three times, cost
         * ~$12 and landed nothing, while the same ticket started over carrying
         * those findings passed first read for $6.56, using none of the ten
         * rounds it had. Each refusal in the first arm was about the code the
         * round before it had written.
         *
         * **Zero by default, and zero is today's behaviour**: a pass whose
         * rounds are spent asks a person, exactly as it did before this key
         * existed. That is 0040 §4 and it is the whole of why this is a key
         * rather than a change — the evidence is one ticket, and no second
         * restart has ever been observed.
         *
         * 0025 §3's rule for a spending default — *the smallest number that
         * makes the feature exist* — would say one, and it does not apply here.
         * That rule is about not taking a feature away by defaulting it too
         * low; this default takes nothing away, because until a project writes
         * a number down there is no feature to take. Turning it on for every
         * project on the strength of n = 1 is the thing being avoided.
         *
         * Only a **judgement** is answered this way, in code and not by recipe:
         * a red build and a conflict stay in the worktree, because for those
         * *the work is still there* is a fact rather than an assumption
         * (0039 §2). See `decideRestart`.
         */
        restarts: z.number().int().nonnegative().default(0),
      })
      .default({ turns: 300, wall: "2h", rounds: 2, restarts: 0 }),
    /**
     * Which issues this machine takes, by their assignee
     * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §2, #181).
     *
     * **The machine's, never the recipe file's**: `resolveLocalRecipe` puts it
     * here from `~/.lingtai/config.yml` and refuses it written in the recipe,
     * as it does `agent` and `limits`. Whether one person's Lingtai leaves a
     * colleague's tickets alone is that person's setting, not the repository's.
     *
     * **Optional, and absent is `both`** — every ticket, assigned or not, which
     * is how the queue behaved before an assignee was read and what somebody
     * working alone expects. Optional rather than defaulted so that a recipe
     * that says nothing hashes and emits exactly as it did.
     */
    assignee: AssigneeRule.optional(),
    /**
     * How much an agent is told, in characters and rows
     * ([0029](../../../doc/decisions/0029-the-prompt-budget-is-the-recipes.md)).
     *
     * `limits` bounds what a run may *spend*; this bounds what it is *given*,
     * and the two are the same kind of decision — which is why they sit
     * together. Four numbers decided the answer to "what does an agent know
     * about why the last attempt failed" (`#82`, `#84`) from four constants in
     * two packages that nobody reviewed together, and prompt content is the
     * most expensive lever this system has.
     *
     * Here rather than compiled in for the reason `backoff` and `repair` are
     * (0016 §7): how much of a failure is worth quoting depends on what this
     * repository's failures look like — a build that prints one line and a
     * suite that prints two hundred do not want the same budget — and that is a
     * thing the repository knows and the core cannot see.
     *
     * The defaults are the constants they replaced, unchanged, so a recipe that
     * says nothing renders exactly the prompt it rendered before.
     */
    budget: z
      .object({
        /** Characters of one earlier failure's output quoted verbatim into the next prompt. */
        evidence: z.number().int().positive().default(2_000),
        /** Rows the attempt table names before it says "and N earlier". */
        attempts: z.number().int().positive().default(5),
        /** Findings of a review gate carried into the next attempt. */
        findings: z.number().int().positive().default(5),
        /**
         * Bytes of the diff a review agent sees before it is truncated.
         *
         * [Experiment 001](../../../doc/experiments/001-cold-review-issue-58.md)'s
         * diff was 1391 lines across 6 files and fitted comfortably. Far past
         * that is a work item scoped too large, which the compaction counter
         * already reports; sending a megabyte produces a worse review, not a
         * better one.
         */
        diff: z.number().int().positive().default(400_000),
      })
      .default({ evidence: 2_000, attempts: 5, findings: 5, diff: 400_000 }),
  }),
});
export type Recipe = z.infer<typeof Recipe>;

export { formatDuration, parseDuration } from "./duration.ts";

/**
 * What a recipe that says nothing about limits gets.
 *
 * Exported so that a sentence about the default can be **generated from the
 * default** — `apps/cli`'s drain names a number it cannot read from any one
 * project's recipe, and naming it by hand is how it came to say one `wall` when
 * the fix loop had already made that false.
 */
export const LIMIT_DEFAULTS = Recipe.shape.runtime.shape.limits.parse(undefined);

/**
 * `parseDuration`, as a predicate: for a schema, where throwing is the wrong
 * shape.
 *
 * Exported for the machine file's schema, which holds the same `wall` this one
 * does and must refuse the same values by name (0046 §3, #218).
 */
export function positiveDuration(text: string): boolean {
  try {
    return parseDuration(text) > 0;
  } catch {
    return false;
  }
}
