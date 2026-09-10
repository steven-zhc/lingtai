/**
 * The recipe: `<repo>/.lingtai/config.yaml`, committed to the managed
 * repository and owned by it.
 *
 * It is safe to keep this in the repo the agent is editing because of one rule,
 * borrowed wholesale from GitHub Actions: **the recipe that governs a run is
 * read from `origin/<base>`, never from the agent's branch.** An agent that
 * edits this file changes nothing about the run in flight; the edit shows up in
 * the diff, the `tamper` gate catches it, and it takes effect only after a
 * human approves and merges it.
 *
 * Nothing sits above this file. The workflow is the repository's to define,
 * and Lingtai does not second-guess it — what Lingtai owns is *where the file
 * is read from*, and that is the one thing a branch cannot change about the run
 * it is part of.
 *
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import { z } from "zod";
import { Tier, RuntimeId, isEventType, isRetiredEventType } from "@lingtai/domain";
import { PREFIX } from "@lingtai/env";

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

/**
 * One thing that runs at a gate.
 *
 * The shape is GitHub Actions' — an optional `name`, exactly one key saying
 * *what kind of thing this is*, and that kind's parameters beside it. Copied
 * rather than invented because [ADR 0005](../../../doc/decisions/0005-config-in-target-repo.md)
 * already frames a recipe as a workflow file, and a second dialect for the same
 * idea is a second thing to learn for no gain.
 *
 * A union rather than a discriminated union: the discriminator is *which key is
 * present*, which zod cannot switch on. The cost is a worse error message on a
 * malformed action; the alternative was a `uses:` field on every entry,
 * including the ones where it says nothing.
 */
export const GateAction = z.union([
  /**
   * A command. Its exit code is the verdict, and `env` is every credential it
   * gets — see `ExtensionEnvNames`. This is the extension point (0037 §2),
   * which is why it is the only kind carrying one: `agent`, `watch` and `human`
   * are the core's own and run in the core's own process.
   */
  z.object({
    name: z.string(),
    run: z.string(),
    timeout: z.string().default("15m"),
    env: ExtensionEnvNames,
  }),
  /** A cold reviewer, given the diff and this prompt. */
  z.object({
    name: z.string(),
    agent: z.string(),
  }),
  /** Globs against the diff's file list; a match holds or fails. */
  z.object({
    name: z.string(),
    watch: z.array(z.string()).min(1),
    then: z.enum(["request-approval", "fail"]).default("request-approval"),
  }),
  /** Waits for a person. The string is the question they are asked. */
  z.object({
    name: z.string(),
    human: z.string(),
  }),
  /**
   * Closes the issue. Only meaningful at `end`, which is the one point that
   * cannot refuse — these run for effect.
   *
   * `when` filters on the outcome, because `end` fires on *every* terminal
   * state. "Close it when it lands, label it when it is blocked" is then one
   * configuration rather than two mechanisms.
   */
  z.object({
    name: z.string(),
    close: z.literal(true),
    when: z.enum(["landed", "blocked", "failed", "any"]).default("landed"),
  }),
  /** Sets labels. Lingtai's own are replaced; everybody else's are kept. */
  z.object({
    name: z.string(),
    labels: z.array(z.string()),
    when: z.enum(["landed", "blocked", "failed", "any"]).default("any"),
  }),
]);
export type GateAction = z.infer<typeof GateAction>;

/**
 * What runs at each of the five points.
 *
 * Every point is present and defaults to empty, which is the whole design in
 * one line: **an unconfigured gate is skipped, and the skip is visible.** A
 * missing key here is not "undefined", it is "nothing runs, and the board says
 * so" (ADR 0016 §4).
 *
 * Order within a point is the array's. The first refusal wins and the actions
 * after it do not run — continuing would spend money producing verdicts about a
 * diff that is not going anywhere.
 *
 * **Strict, and that is what makes the closed set enforceable.** A key that is
 * not one of the five is a typo or a stale name, and zod's default is to drop
 * it silently — which would mean a recipe whose `merg:` block never runs and a
 * board that says `skipped` because it was told nothing was configured. That is
 * exactly the "configured and did not run" failure the model calls Lingtai's
 * bug (ADR 0016 §4). It is also what a recipe still saying `diff:` would hit
 * after [0018](../../../doc/decisions/0018-the-proposed-point.md): it fails to
 * resolve, loudly, naming the key.
 */
export const GateMap = z.strictObject({
  admit: z.array(GateAction).default([]),
  prepared: z.array(GateAction).default([]),
  /** Was `diff` until [0018](../../../doc/decisions/0018-the-proposed-point.md). */
  proposed: z.array(GateAction).default([]),
  merge: z.array(GateAction).default([]),
  end: z.array(GateAction).default([]),
});
export type GateMap = z.infer<typeof GateMap>;

/** The action's kind, for an event and for dispatch. Exactly one key decides it. */
export type ActionKind = "run" | "agent" | "watch" | "human" | "close" | "labels";

export function kindOfAction(action: GateAction): ActionKind {
  if ("run" in action) return "run";
  if ("agent" in action) return "agent";
  if ("watch" in action) return "watch";
  if ("close" in action) return "close";
  if ("labels" in action) return "labels";
  return "human";
}

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
    /** Where the filtered env file is planted inside the worktree. Rarely the
     *  repo root — Next/Prisma/vitest read it from the app directory. */
    plantAt: z.string(),
  }),

  // Spelled out rather than `.default({})`: all five points exist whether or
  // not a recipe mentions them, and writing that here says so once.
  gates: GateMap.default({ admit: [], prepared: [], proposed: [], merge: [], end: [] }),

  /**
   * Who is told what happened, and about which events.
   *
   * Here rather than in the daemon because **which events are worth telling
   * somebody about is a fact about a channel, not about Lingtai.**
   * `DEFAULT_SUBSCRIPTIONS` in `packages/daemon/src/notify.ts` is four types,
   * the same for every project, changeable only by editing the daemon — and it
   * is four *because it is a desktop notification*, which interrupts. A landed
   * task is not worth interrupting for and is worth a Telegram message, and
   * only a per-channel list can say both. That is 0016 §7's argument again: the
   * repository knows which of its outcomes it wants to hear about and the core
   * cannot see it.
   *
   * Defaulted to empty rather than optional, like `gates`: a project that
   * declares no subscriber has *declared none*, which is a thing that can be
   * rendered, rather than an absence.
   */
  subscribers: z.array(Subscriber).default([]),

  /**
   * Whether a failure of **this repository's** buys an agent to fix it, and how
   * many times ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md)).
   *
   * Here rather than compiled into Lingtai for the reason 0016 §7 deleted the
   * hardcoded skip: this is a policy about a repository, and a repository knows
   * things about itself that the core cannot see. Whether a red build is worth
   * an agent is one of them.
   *
   * **Defaulted rather than optional, and rendered either way.** `lingtai add`
   * prints it and the board shows it, exactly as an empty gate point is printed
   * and shown as `skipped` — a repository must be able to see whether it
   * repairs without reading Lingtai's source. A field that is absent from the
   * output when it is off would be the same invisibility 0016 §4 forbids.
   *
   * Only Lingtai's *own* failures are excluded unconditionally, in code
   * (`whoseFailure`), because no recipe can make an agent able to fix a
   * database it cannot reach.
   */
  repair: z
    .strictObject({
      on: z.boolean().default(true),
      /**
       * The ceiling, per work item, across every distinct failure.
       *
       * One by default. The failure mode this bounds is unbounded spend rather
       * than a wrong answer (0025 §3), so the default is the smallest number
       * that makes the feature exist, and raising it is the repository's call.
       */
      maxAttempts: z.number().int().positive().default(1),
    })
    .default({ on: true, maxAttempts: 1 }),

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
    limits: z
      .object({ turns: z.number().int().positive().default(300), wall: z.string().default("2h") })
      .default({ turns: 300, wall: "2h" }),
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

/**
 * `15m`, `2h`, `90s` → milliseconds.
 *
 * The recipe writes durations the way a person says them; everything that
 * consumes one needs a number. Throws on anything else rather than defaulting —
 * a gate that silently got a 0ms timeout would fail every run for a reason
 * nobody could see.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a duration like 30s, 15m or 2h`);
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h";
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
}

/** `parseDuration`, as a predicate: for a schema, where throwing is the wrong shape. */
function positiveDuration(text: string): boolean {
  try {
    return parseDuration(text) > 0;
  } catch {
    return false;
  }
}
