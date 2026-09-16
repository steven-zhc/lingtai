"use client";

/**
 * The wizard's page, drawn (#164). Two lanes on a dot ground: the fast lane,
 * which is what Lingtai read, and the slow one, which is settled lines plus one
 * open question.
 *
 * **Ink blue is structure, brass is a person being waited on** — the board's
 * `--signal`, and nothing else on this page wears it: the open question, and
 * the one sentence the page argues with. The dots carry nothing; delete them
 * the first time they make something harder to read.
 *
 * Every rule about which line is open, what a move does and what stops the end
 * is `@lingtai/conductor/wizard-page`. This file only draws its answers.
 */
import Link from "next/link";
import { type ReactNode, useReducer, useState, useTransition } from "react";
import type { Recipe } from "@lingtai/recipe";
import {
  DECISIONS,
  type DecisionId,
  FAST_ROWS,
  type FastRowId,
  type Limits,
  type WizardMove,
  type WizardState,
  fastLine,
  finishRefusals,
  limitsSentence,
  mergeArgument,
  mergeConsequence,
  openDecision,
  settledLine,
  wizardReducer,
} from "@lingtai/conductor/wizard-page";
import { type Finished, finishWizard } from "./finish.ts";

export type Loaded =
  | { state: "no-app" }
  | { state: "unreadable"; why: string }
  | { state: "invalid"; slug: string; why: string }
  | { state: "ready"; initial: WizardState; recipe: Recipe; existing: string | null };

export function WizardScreen({ loaded }: { loaded: Loaded }) {
  return (
    <main className="detail wizard">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">{loaded.state === "ready" ? loaded.initial.slug : "wizard"}</span>
      </div>
      <div className="detail-body">
        <section>
          {loaded.state === "no-app" ? (
            <p className="note">
              There is no GitHub App configured yet. <Link href="/setup/github-app">Create it first</Link>.
            </p>
          ) : loaded.state === "invalid" ? (
            <p className="refusal">
              {loaded.slug} was read, and its recipe was not — {loaded.why}. The fault is in that file, not the
              repository: fix it on the base branch and reload.
            </p>
          ) : loaded.state === "unreadable" ? (
            <p className="refusal">
              The repository could not be read — {loaded.why}. <Link href="/setup/repository">Pick another</Link>, or
              reload to ask again.
            </p>
          ) : (
            <Wizard initial={loaded.initial} recipe={loaded.recipe} existing={loaded.existing} />
          )}
        </section>
      </div>
    </main>
  );
}

function Wizard({ initial, recipe, existing }: { initial: WizardState; recipe: Recipe; existing: string | null }) {
  const [state, move] = useReducer(wizardReducer, initial);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [busy, startTransition] = useTransition();
  const open = openDecision(state);
  const refusals = finishRefusals(state);
  const act = (m: WizardMove) => {
    setFinished(null);
    move(m);
  };

  return (
    <>
      <h2>
        <span className="hlab">{state.mode === "onboard" ? "Onboard" : "Adjust"}</span>
        <span className="hfact">
          {state.mode === "onboard"
            ? `read from ${state.draft.base} — change anything that is wrong`
            : `the recipe on ${state.draft.base} — change what you came for`}
        </span>
      </h2>

      <ol className="wz-lane" aria-label="read from the repository">
        {FAST_ROWS.map((row) => (
          <li key={row.id} className="wz-row">
            <span className="wz-key">{row.label}</span>
            <span className="wz-val">{fastLine(state.draft, row.id)}</span>
            <button
              type="button"
              className="wz-change"
              onClick={() => act(state.editing === row.id ? { type: "done" } : { type: "change", row: row.id })}
            >
              {state.editing === row.id ? "done" : "change"}
            </button>
            {state.editing === row.id ? <div className="wz-edit">{fastEditor(state, row.id, act)}</div> : null}
          </li>
        ))}
      </ol>

      {state.doubts.length === 0 ? null : (
        <ul className="wz-doubts" aria-label="what the reading could not settle">
          {state.doubts.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}

      <ol className="wz-lane wz-slow" aria-label="decisions">
        {DECISIONS.map((d) =>
          d.id === open ? (
            <li key={d.id} className="wz-question">
              <p className="wz-ask">{d.question}</p>
              {decisionEditor(state, d.id, act)}
              <div className="btnrow">
                <button type="button" className="btn" onClick={() => act({ type: "settle", decision: d.id })}>
                  {state.settled.includes(d.id) ? "keep this answer" : "that is the answer"}
                </button>
              </div>
            </li>
          ) : state.settled.includes(d.id) ? (
            <li key={d.id} className="wz-row wz-settled">
              <span className="wz-key">{d.id === "gates.merge" ? "merge" : "limits"}</span>
              <span className="wz-val">{settledLine(state.draft, d.id)}</span>
              <button type="button" className="wz-change" onClick={() => act({ type: "reopen", decision: d.id })}>
                change
              </button>
            </li>
          ) : null,
        )}
      </ol>

      <div className="wz-end">
        {refusals.length > 0 ? (
          <ul className="wz-refusals">
            {refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <div className="btnrow">
            <button
              type="button"
              className="btn pri"
              disabled={busy}
              onClick={() =>
                startTransition(async () => setFinished(await finishWizard({ state, recipe, existing })))
              }
            >
              {state.mode === "onboard" ? "Show the recipe" : "Show the change"}
            </button>
          </div>
        )}
        {finished === null ? null : finished.ok ? (
          <>
            <p className="decided">
              {state.mode === "update"
                ? finished.changed.length === 0
                  ? "Nothing changed."
                  : `Changes ${finished.changed.join(", ")}, and every other line as it was.`
                : "The recipe, parsed by the system's own parser. Nothing has been written."}
            </p>
            <pre className="wz-file">{finished.file}</pre>
          </>
        ) : (
          <ul className="wz-refusals">
            {finished.refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function fastEditor(state: WizardState, row: FastRowId, act: (m: WizardMove) => void): ReactNode {
  const { draft } = state;
  switch (row) {
    case "repo.base":
      return (
        <input value={draft.base} onChange={(e) => act({ type: "set", draft: { base: e.target.value } })} />
      );
    case "repo.submodules":
      return (
        <Tick
          label="check submodules out with the worktree"
          on={draft.submodules}
          flip={() => act({ type: "set", draft: { submodules: !draft.submodules } })}
        />
      );
    case "source.kinds":
      return (
        <>
          {state.kindOptions.map((k) => {
            const on = draft.kinds.includes(k);
            const last = on && draft.kinds.length === 1;
            return (
              <Tick
                key={k}
                label={k}
                on={on}
                disabled={last}
                title={last ? "the last kind — with none, no issue is ever work" : undefined}
                flip={() => act({ type: "kind", label: k })}
              />
            );
          })}
          <AddLabel add={(label) => act({ type: "kind", label, add: true })} placeholder="another kind" />
          <small>Ticked order is priority. The last kind cannot be unticked.</small>
        </>
      );
    case "source.exclude":
      return (
        <>
          {state.excludeOptions.map((k) => (
            <Tick key={k} label={k} on={draft.exclude.includes(k)} flip={() => act({ type: "exclude", label: k })} />
          ))}
          <AddLabel add={(label) => act({ type: "exclude", label, add: true })} placeholder="another label" />
        </>
      );
    case "gates.proposed":
      return (
        <>
          {draft.checks.length === 0 ? <small>No scripts were found.</small> : null}
          {draft.checks.map((c) => (
            <Tick key={c.id} label={c.label} on={c.ticked} flip={() => act({ type: "check", id: c.id })} />
          ))}
          <AddLabel add={(run) => act({ type: "add-check", run })} placeholder="another command, e.g. make test" />
        </>
      );
    case "env.required":
      return (
        <>
          <input
            defaultValue={draft.envRequired.join(", ")}
            onBlur={(e) => act({ type: "env", names: e.target.value.split(/[\s,]+/) })}
          />
          <small>
            Names only. Values go through <code>lingtai env set</code>, never this page.
          </small>
        </>
      );
    case "runtime.agent":
      return (["claude-code", "codex"] as const).map((agent) => (
        <label key={agent} className="wz-tick">
          <input
            type="radio"
            name="agent"
            checked={draft.agent === agent}
            onChange={() => act({ type: "set", draft: { agent } })}
          />{" "}
          {agent}
        </label>
      ));
    case "gates.end":
      return (
        <Tick
          label="close the issue when it lands"
          on={draft.closeOnLand}
          flip={() => act({ type: "set", draft: { closeOnLand: !draft.closeOnLand } })}
        />
      );
  }
}

function decisionEditor(state: WizardState, decision: DecisionId, act: (m: WizardMove) => void): ReactNode {
  const { draft } = state;
  if (decision === "gates.merge") {
    const argument = mergeArgument(state);
    return (
      <>
        {argument === null ? null : <p className="wz-argues">{argument}</p>}
        {[false, true].map((yes) => (
          <label key={String(yes)} className="wz-tick">
            <input
              type="radio"
              name="merge"
              checked={draft.personApproves === yes}
              onChange={() => act({ type: "set", draft: { personApproves: yes } })}
            />{" "}
            {yes ? "Yes — a person approves" : "No — it lands when the checks pass"}
          </label>
        ))}
        <p className="wz-consequence">{mergeConsequence(draft)}</p>
      </>
    );
  }
  const sentence = limitsSentence(draft.limits);
  const dial = (key: keyof Limits, label: string) => (
    <label key={key} className="wz-dial">
      <span>{label}</span>
      <input
        type={key === "wall" ? "text" : "number"}
        min={key === "turns" ? 1 : 0}
        value={draft.limits[key]}
        onChange={(e) =>
          act({ type: "limit", key, value: key === "wall" ? e.target.value : Number(e.target.value) })
        }
      />
    </label>
  );
  return (
    <>
      <div className="wz-dials">
        {dial("turns", "turns")}
        {dial("wall", "wall")}
        {dial("rounds", "rounds")}
        {dial("restarts", "restarts")}
      </div>
      <p className={sentence.ok ? "wz-consequence" : "refusal"}>{sentence.ok ? sentence.sentence : sentence.refusal}</p>
    </>
  );
}

function Tick({
  label,
  on,
  flip,
  disabled,
  title,
}: {
  label: string;
  on: boolean;
  flip: () => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <label className="wz-tick" title={title}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={flip} /> {label}
    </label>
  );
}

function AddLabel({ add, placeholder }: { add: (label: string) => void; placeholder: string }) {
  const [label, setLabel] = useState("");
  return (
    <span className="wz-add">
      <input value={label} placeholder={placeholder} onChange={(e) => setLabel(e.target.value)} />
      <button
        type="button"
        className="btn"
        disabled={label.trim() === ""}
        onClick={() => {
          add(label.trim());
          setLabel("");
        }}
      >
        add
      </button>
    </span>
  );
}
