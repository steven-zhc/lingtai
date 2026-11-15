# Comparable products: AI coding-agent orchestrators

**Purpose.** This is the fact base for a public page about products comparable
to Lingtai. It replaces an AI-generated comparison table that nobody had
checked. It records what each product says about itself. It does not rate or
rank them.

**Checked on 2026-11-15.** Every product here ships often. Several of them
released something on the day this was checked, so any claim may have changed
since.

**Method.**

- Only primary sources count: the product's own site and docs, its GitHub
  README, docs in its repository, source files, the license file, and release
  metadata read from the GitHub API. Directory listings, blogs, comparison
  sites and AI summaries were used only to find a product. Nothing is cited
  from them.
- Where a field has no primary source, it says **not stated**. Nothing is
  inferred.
- "Latest release" and "last push" come from
  `gh api repos/<owner>/<repo>` and `.../releases/latest` on the check date.
- Several names belong to more than one product. Each section says how the
  right one was picked.

Neither [market-opportunities.md](market-opportunities.md) nor
[../from-symphony.md](../from-symphony.md) names any of the eight candidates,
so nothing was reused from them. OpenAI Symphony, which `from-symphony.md` is
about, is listed under *Other comparables*.

**Result.** All eight candidates exist and were found. No candidate is missing.

---

## ProPR

*How it was identified:* `segersniels/propr` is a different tool, a CLI that
writes PR descriptions. The orchestrator is `integry/propr`. Its GitHub
description reads "Open source, self-hosted GitHub orchestration for AI coding
agents" ([repo](https://github.com/integry/propr)).

- **URL / repo:** [propr.dev](https://propr.dev) ·
  [github.com/integry/propr](https://github.com/integry/propr)
- **What it is:** "an open-source, self-hosted platform that manages AI coding
  agents the way you manage engineers: through issues, pull requests and code
  review" ([README](https://github.com/integry/propr#what-is-propr)).
- **How work enters:** Add the `AI` label to a GitHub issue. A model label such
  as `llm-claude-opus55` picks the agent. Later work arrives through PR comments
  and the `/review`, `/fix` and `/ultrafix` commands
  ([README](https://github.com/integry/propr#what-is-propr)). Other ways in:
  Planner Studio, an MCP chat client, the CLI
  ([README features](https://github.com/integry/propr#features)), and an API
  ([launching work](https://github.com/integry/propr/blob/HEAD/docs/docs/features/launching-work.md)).
- **Agents driven:** Claude Code, OpenAI Codex, Google Antigravity, OpenCode,
  Mistral Vibe ([README](https://github.com/integry/propr#what-is-propr)).
- **Isolation:** "Every run gets its own branch, Git worktree and Docker
  container" ([README](https://github.com/integry/propr#features)). The agent
  gets a read-only GitHub token. ProPR does the commits and pushes itself
  ([execution safety](https://github.com/integry/propr/blob/HEAD/docs/docs/features/execution-safety.md)).
  The network has two modes, `open` and `restricted`, and **`open` is the
  default**. `restricted` starts the container with `--network none` and lets
  it out only through an allowlist proxy
  ([execution safety, Restricted Network Mode](https://github.com/integry/propr/blob/HEAD/docs/docs/features/execution-safety.md#restricted-network-mode)).
  The README calls the allowlist firewall optional and "off by default"
  ([README FAQ](https://github.com/integry/propr#faq)).
- **Quality gates:**
  - `/review` produces findings and a `Score: N/10`, and can run one review per
    model ([PR commands](https://github.com/integry/propr/blob/HEAD/docs/docs/features/pr-commands.md)).
  - Ultrafix repeats review and repair until the score target is met, then
    "hands it back for a human merge". It waits for blocking CI before it
    reviews again ([README](https://github.com/integry/propr#features);
    [PR commands](https://github.com/integry/propr/blob/HEAD/docs/docs/features/pr-commands.md)).
  - `.propr/workflow.yml` can declare validation commands that run after the
    agent exits
    ([repository workflow](https://github.com/integry/propr/blob/HEAD/docs/docs/features/repository-workflow.md)).
  - "You make the merge decision" is the default. An optional `auto-merge`
    label arms GitHub's native auto-merge, subject to repository policy and
    protected paths
    ([repository workflow, Auto-merge policy](https://github.com/integry/propr/blob/HEAD/docs/docs/features/repository-workflow.md#auto-merge-policy)).
- **Cost tracking / budgets:**
  - Each task records "per-call model cost" ([README](https://github.com/integry/propr#features)).
  - The dashboard and Analytics pages show spend per repository and per model
    ([web UI](https://github.com/integry/propr/blob/HEAD/docs/docs/features/web-ui.md)).
  - A **per-run spend cap** (`max_cost_usd`) stops a run once its estimated cost
    reaches the limit
    ([execution safety, Spend Caps](https://github.com/integry/propr/blob/HEAD/docs/docs/features/execution-safety.md#spend-caps)).
  - A daily or instance-wide ceiling: not stated.
- **Auth:** "a subscription you already have (such as Claude Pro or ChatGPT
  Plus) or a metered API key" ([README FAQ](https://github.com/integry/propr#faq)).
  The agent credential directories (`~/.claude`, `~/.codex`, …) are mounted into
  the container
  ([execution safety](https://github.com/integry/propr/blob/HEAD/docs/docs/features/execution-safety.md)).
- **UI surfaces:** a Web UI at `localhost:5173`, an installable PWA, a desktop
  app (release candidate), chat over MCP, and a CLI
  ([README](https://github.com/integry/propr#quickstart);
  [README features](https://github.com/integry/propr#features)).
- **Storage / hosted service:**
  - It runs as a Docker stack with Redis
    ([docker-compose.yml](https://github.com/integry/propr/blob/HEAD/docker-compose.yml))
    and a SQLite database at `data/propr.sqlite`
    ([knexfile.ts](https://github.com/integry/propr/blob/HEAD/knexfile.ts)).
  - "Self-hosted only. There is no hosted ProPR." The optional ProPR Connect
    relay forwards GitHub events. You can skip it by bringing your own GitHub
    App ([README Status](https://github.com/integry/propr#status)).
  - Linux `amd64` is the native host
    ([README Status](https://github.com/integry/propr#status)).
- **License / maintenance:** Apache-2.0
  ([LICENSE](https://github.com/integry/propr/blob/HEAD/LICENSE)). Latest
  release v0.9.1 on 2026-11-01; last push 2026-11-15
  ([releases](https://github.com/integry/propr/releases)). Described as pre-1.0
  ([README Status](https://github.com/integry/propr#status)).

## Kandev

*How it was identified:* `kdlbs/kandev`, described as "AI Kanban & Development
Environment. Orchestrate multiple agents, review changes, open PRs"
([repo](https://github.com/kdlbs/kandev)). Search also turned up a
`tito/kandev` repository. It was not examined.

- **URL / repo:** [kandev.ai](https://kandev.ai) ·
  [github.com/kdlbs/kandev](https://github.com/kdlbs/kandev)
- **What it is:** a kanban board plus an integrated workspace for running
  multiple coding agents in parallel and reviewing what they produce
  ([README](https://github.com/kdlbs/kandev#what)).
- **How work enters:**
  - Kanban and pipeline boards in the web UI
    ([README](https://github.com/kdlbs/kandev#what)).
  - Issues pulled from GitHub, GitLab, Jira, Linear and Sentry; Bitbucket and
    Azure DevOps through plugins
    ([README Integrations](https://github.com/kdlbs/kandev#integrations)).
  - Automations triggered by schedules or webhooks
    ([README Features](https://github.com/kdlbs/kandev#features)).
- **Agents driven:** 22 CLIs listed, among them Claude Code, Codex, GitHub
  Copilot, Gemini CLI, Amp, OpenCode, Cursor and Devin. Most connect over ACP,
  and any TUI agent can run through CLI passthrough
  ([README Supported Agent CLIs](https://github.com/kdlbs/kandev#supported-agent-clis)).
- **Isolation:** Git worktrees per task. Executors: local process, Docker
  container, Kubernetes Pod, SSH remote server, and sprites.dev cloud
  ([README Supported Executors](https://github.com/kdlbs/kandev#supported-executors)).
  Network restriction: not stated.
- **Quality gates:**
  - Human review of every change is the stated vision
    ([README Vision](https://github.com/kdlbs/kandev#vision)).
  - Built-in workflows include one with Spec → Work → Review (a fresh agent
    reviews the diff) → QA → PR → CI Fixup (the agent polls CI and fixes failures)
    ([workflow tips](https://github.com/kdlbs/kandev/blob/HEAD/docs/workflow-tips.md)).
  - Required human approval before merge: not stated.
- **Cost tracking / budgets:** "Cost tracking, model usage visibility, and
  budget guardrails" belong to Office mode, which is "feature-flagged and not
  documented as a live supported feature yet"
  ([features](https://github.com/kdlbs/kandev/blob/HEAD/docs/features.md)).
  Cost tracking in the shipped product: not stated.
- **Auth:** Each agent signs in to its model provider "on the host and as the
  operating system user that runs the selected executor"
  ([agents and profiles](https://github.com/kdlbs/kandev/blob/HEAD/docs/public/agents-and-profiles.md)).
  Cursor "requires Cursor Pro"
  ([README](https://github.com/kdlbs/kandev#supported-agent-clis)).
  Subscription versus API key in general: not stated.
- **UI surfaces:**
  - A web UI served by the Go binary
    ([README Distribution](https://github.com/kdlbs/kandev#distribution)).
  - A desktop app (Tauri)
    ([README project structure](https://github.com/kdlbs/kandev#readme)).
  - Phone access through a private VPN or tunnel
    ([README](https://github.com/kdlbs/kandev#what)).
  - External MCP ([README Features](https://github.com/kdlbs/kandev#features)).
- **Storage / hosted service:** "The worktrees and sqlite db live in
  `~/.kandev` by default" ([README](https://github.com/kdlbs/kandev#updates)).
  "Open source, multi-provider, no telemetry, not tied to any cloud"
  ([README](https://github.com/kdlbs/kandev#what)).
- **License / maintenance:** AGPL-3.0
  ([LICENSE](https://github.com/kdlbs/kandev/blob/HEAD/LICENSE)). Latest release
  v0.101.0 on 2026-11-11; last push 2026-11-15
  ([releases](https://github.com/kdlbs/kandev/releases)).

## Cline Kanban

*How it was identified:* the `cline/kanban` repository from Cline Bot Inc.,
"Launch a local web app that runs CLI agents in parallel"
([repo](https://github.com/cline/kanban)). Cline announced it on 2026-03-26
([Cline blog](https://cline.bot/blog/announcing-kanban)).

- **URL / repo:** [cline.bot/blog/announcing-kanban](https://cline.bot/blog/announcing-kanban) ·
  [github.com/cline/kanban](https://github.com/cline/kanban) · npm `kanban`
- **What it is:** "A replacement for your IDE better suited for running many
  agents in parallel and reviewing diffs". It is labelled a "research preview"
  ([README](https://github.com/cline/kanban#readme)).
- **How work enters:** You create a task card by hand, or ask the agent in the
  sidebar chat to break work into cards. Linked cards start on their own when
  the card before them completes
  ([README](https://github.com/cline/kanban#readme)). GitHub issue intake: not
  stated.
- **Agents driven:** Launch is currently scoped to `cline`, `claude`, `codex`,
  `droid` and `kiro`. `opencode` and `gemini` are commented out
  ([agent-catalog.ts](https://github.com/cline/kanban/blob/HEAD/src/core/agent-catalog.ts)).
  The announcement names Claude Code and Codex
  ([Cline blog](https://cline.bot/blog/announcing-kanban)).
- **Isolation:** each card gets "its own terminal and worktree", and gitignored
  files such as `node_modules` are symlinked in. The README warns that it "uses
  experimental features of CLI agents like bypassing permissions"
  ([README](https://github.com/cline/kanban#readme)). Container, VM and network
  restriction: not stated.
- **Quality gates:** You review the diff and add line comments, then press
  Commit or Open PR. "Or skip review by enabling auto-commit / auto-PR"
  ([README](https://github.com/cline/kanban#readme)). CI and review agents: not
  stated.
- **Cost tracking / budgets:** not stated.
- **Auth:** It "will detect your installed CLI agent … No account or setup
  required" ([README](https://github.com/cline/kanban#readme)). The source
  defines Cline OAuth providers `cline`, `oca` and `openai-codex`
  ([api-contract.ts](https://github.com/cline/kanban/blob/HEAD/src/core/api-contract.ts)).
  Subscription versus API key: not stated.
- **UI surfaces:** a local web server opened in the browser, with a git
  interface ([README](https://github.com/cline/kanban#readme)).
- **Storage / hosted service:** runtime state lives under `~/.cline/kanban`
  ([task-worktree-path.ts](https://github.com/cline/kanban/blob/HEAD/src/workspace/task-worktree-path.ts)).
  It needs no account, per the README above. It ships Sentry error reporting
  ([sentry-node.ts](https://github.com/cline/kanban/blob/HEAD/src/telemetry/sentry-node.ts)).
- **License / maintenance:** Apache-2.0
  ([LICENSE](https://github.com/cline/kanban/blob/HEAD/LICENSE)). Latest GitHub
  release v0.1.70 on 2026-07-12; last push 2026-11-13
  ([releases](https://github.com/cline/kanban/releases)).

## Agent Orchestrator (Orchestrator.inc)

*How it was identified:* `ComposioHQ/agent-orchestrator` and
`AgentWrapper/agent-orchestrator` both redirect to
**`OrchestratorInc/agent-orchestrator`** on GitHub. The API returns that
`full_name` for all three. It is one project under three names, not three
projects. The product name is now Orchestrator.inc
([repo](https://github.com/OrchestratorInc/agent-orchestrator)).

- **URL / repo:** [orchestrator.inc](https://orchestrator.inc) ·
  [github.com/OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)
- **What it is:** "a local desktop workspace" where "every task gets its own
  agent, branch, and worktree"
  ([README](https://github.com/OrchestratorInc/agent-orchestrator#why-orchestratorinc)).
- **How work enters:** You tell a project's main agent what to build. It plans
  the work and starts a worker for each piece
  ([README](https://github.com/OrchestratorInc/agent-orchestrator#the-orchestrator-runs-the-fleet)).
  Workers can also be started from the mobile app
  ([README](https://github.com/OrchestratorInc/agent-orchestrator#orchestrator-for-mobile)).
  GitHub issue intake: not stated in the current README.
- **Agents driven:** The repo description says "Supports Claude Code, Codex &
  35+ coding agents" ([repo](https://github.com/OrchestratorInc/agent-orchestrator)).
  The README table lists 36, including Claude Code, Codex, Cursor, opencode,
  Aider, GitHub Copilot, Gemini CLI and OpenHands
  ([README](https://github.com/OrchestratorInc/agent-orchestrator#supported-agents)).
- **Isolation:**
  - A worktree per task on the local machine.
  - Optional "Cloud Agents" in hosted workspaces
    ([README](https://github.com/OrchestratorInc/agent-orchestrator#cloud-agents)).
    Cloud use "is gated by build configuration, account entitlement, and a
    reachable control plane"
    ([STATUS.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/STATUS.md)).
  - The project's own status file says: "native modes and prompts are not OS
    or network isolation"
    ([STATUS.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/STATUS.md)).
- **Quality gates:**
  - "Failed checks, review comments, and merge conflicts go back to the worker
    that owns the branch until the PR is approved. A reviewer agent can read
    every PR before a person does"
    ([README](https://github.com/OrchestratorInc/agent-orchestrator#ci-fails-the-right-agent-fixes-it)).
  - The app has a merge action (`POST /prs/{id}/merge`)
    ([STATUS.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/STATUS.md)).
- **Cost tracking / budgets:** not stated.
- **Auth:** "Claude Code and Codex subscription accounts … signed in by the
  CLI's own login; … AO never reads a token"
  ([STATUS.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/STATUS.md)).
- **UI surfaces:** a desktop app for macOS, Windows and Linux, and mobile apps
  for iPhone and Android
  ([README](https://github.com/OrchestratorInc/agent-orchestrator#install);
  [README Mobile](https://github.com/OrchestratorInc/agent-orchestrator#orchestrator-for-mobile)).
- **Storage / hosted service:**
  - A local Go daemon with SQLite
    ([architecture.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/architecture.md)).
  - The local loop needs no hosted service. Cloud Agents need an AO Cloud
    account (STATUS.md, above).
  - Telemetry is on by default and can be switched off. It includes an
    installation ID and your GitHub username
    ([README Product telemetry](https://github.com/OrchestratorInc/agent-orchestrator#product-telemetry)).
- **License / maintenance:** Apache-2.0
  ([LICENSE](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/LICENSE)).
  Latest release v0.15.2 on 2026-11-15; last push 2026-11-15
  ([releases](https://github.com/OrchestratorInc/agent-orchestrator/releases)).

## Orca

*How it was identified:* `stablyai/orca`, "Orca lets you run a fleet of coding
agents (e.g. Claude Code, Codex) with your own subscription"
([repo](https://github.com/stablyai/orca)). Its README says "bare `orca` is an
unrelated Plotly cask" ([README](https://github.com/stablyai/orca#install)).

- **URL / repo:** [orca.dev](https://orca.dev) ·
  [github.com/stablyai/orca](https://github.com/stablyai/orca)
- **What it is:** a desktop app that runs "Claude Code, Codex, and any other
  coding agent in parallel, each in its own worktree … with diffs, a browser,
  and a CLI in one app" ([README](https://github.com/stablyai/orca)).
- **How work enters:**
  - The desktop app, in chat or terminal.
  - One agent that splits a task among worker agents.
  - GitHub and Linear tasks, each of which you can start as a workspace.
  - The Orca CLI and scheduled automations
    ([README Features](https://github.com/stablyai/orca#features)).
- **Agents driven:** "Works with any CLI agent". The README shows 34 agent
  logos, among them Claude Code, Codex, Cursor, GitHub Copilot, OpenCode and Pi
  ([README Supported Agents](https://github.com/stablyai/orca#supported-agents)).
- **Isolation:** Four ways to run it: local, an SSH host, a paired Remote Orca
  Server, or a per-worktree environment described as "a cloud sandbox, VM, or
  local Docker container" that you supply ("You bring the provider") and that
  is not "an Orca-hosted VPS" ([ways to run](https://orca.dev/docs/ways-to-run)).
  Network restriction: not stated.
- **Quality gates:** "Review diffs, leave notes on exact changed lines" and
  "send failing checks or PR review comments back to an agent to fix"
  ([README Features](https://github.com/stablyai/orca#features)). Review agents
  and required approval: not stated.
- **Cost tracking / budgets:** Shows usage against subscription limits and when
  they reset, with a warning at 80 %. It also shows an "estimated cost" taken
  from "a local price table, not a live bill". Spend caps: not stated
  ([usage tracking](https://orca.dev/docs/agents/usage-tracking)).
- **Auth:** "with your own subscription"
  ([repo](https://github.com/stablyai/orca)). It switches accounts "without
  logging out" ([README](https://github.com/stablyai/orca#features)).
- **UI surfaces:** a desktop app for macOS, Windows and Linux, plus an iOS app
  and an Android APK ([README Install](https://github.com/stablyai/orca#install)).
- **Storage / hosted service:** Storage: not stated. Local use needs no hosted
  Orca service or account (not stated otherwise). Anonymous usage telemetry,
  with an opt-out ([README](https://github.com/stablyai/orca#community--support)).
- **License / maintenance:** MIT
  ([LICENSE](https://github.com/stablyai/orca/blob/HEAD/LICENSE)). Latest release
  v1.4.259 on 2026-11-14; last push 2026-11-15
  ([releases](https://github.com/stablyai/orca/releases)).

## Sortie

*How it was identified:* `sortie-ai/sortie`, "Turn tracker tickets into
autonomous agent sessions" ([repo](https://github.com/sortie-ai/sortie)). The
README credits OpenAI Symphony as prior art
([README](https://github.com/sortie-ai/sortie#prior-art)).

- **URL / repo:** [sortie-ai.com](https://sortie-ai.com) ·
  [docs.sortie-ai.com](https://docs.sortie-ai.com) ·
  [github.com/sortie-ai/sortie](https://github.com/sortie-ai/sortie)
- **What it is:** "The open-source coding agent orchestrator. Run the coding
  agents you already use on tasks from your issue tracker"
  ([README](https://github.com/sortie-ai/sortie)).
- **How work enters:** It polls GitHub Issues, GitLab Issues, Gitea Issues,
  Linear or Jira, filtered by a `query_filter` such as `label:agent-ready`, as
  configured in one `WORKFLOW.md`
  ([README](https://github.com/sortie-ai/sortie#how-it-works)). There is also a
  GitHub Action ([README](https://github.com/sortie-ai/sortie)).
- **Agents driven:** Claude Code, Copilot, OpenCode, Codex, Kiro and Gemini
  ([README](https://github.com/sortie-ai/sortie#works-with)).
- **Isolation:**
  - A plain directory per issue, filled by operator hooks (usually a git
    clone). Sortie "chose the simplest model and makes the operator responsible
    for what goes inside it"
    ([isolation](https://github.com/sortie-ai/docs/blob/HEAD/content/concepts/isolation.md)).
  - Optional SSH worker hosts
    ([scale with SSH](https://docs.sortie-ai.com/guides/scale-agents-with-ssh/)).
  - A container image and Kubernetes deployment
    ([README](https://github.com/sortie-ai/sortie#how-it-works)).
  - Agent network restriction: not stated. The restricted-networks guide is
    about running on a host with no public internet, not about limiting what
    the agent can reach
    ([restricted networks](https://docs.sortie-ai.com/guides/run-in-restricted-networks/)).
- **Quality gates:**
  - Optional self-review runs your verification commands and feeds the diff and
    results back to the agent before it pushes
    ([self-review](https://docs.sortie-ai.com/guides/configure-self-review/)).
  - Optional CI feedback: when CI fails on the agent's PR, Sortie starts a
    continuation run to fix it, and "escalates to a human" after repeated
    failures ([CI feedback](https://docs.sortie-ai.com/guides/configure-ci-feedback/)).
  - Review-comment feedback ([README](https://github.com/sortie-ai/sortie#how-it-works)).
  - Merge: the agent hands off to a `handoff_state` such as `review`
    ([README](https://github.com/sortie-ai/sortie#how-it-works)). Whether
    Sortie ever merges: not stated.
- **Cost tracking / budgets:**
  - Per-turn `claude-code.max_budget_usd`.
  - Per-issue `agent.max_tokens` and `agent.max_cost_usd`.
  - "a daily, weekly, or monthly spend limit for the whole instance"
    ([control costs](https://docs.sortie-ai.com/guides/control-costs/)).
  - Costs survive restarts in SQLite
    ([README](https://github.com/sortie-ai/sortie#how-it-works)).
- **Auth:** Both are documented for Claude Code. The adapter reports "the plan
  limits of a Claude subscription", and "a session on an API key" reports none.
  It carries `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` to remote hosts
  ([Claude Code adapter](https://docs.sortie-ai.com/reference/adapter-claude-code/)).
- **UI surfaces:** a built-in dashboard, a JSON API with a live stream, and
  Prometheus metrics ([README](https://github.com/sortie-ai/sortie#how-it-works)).
- **Storage / hosted service:** "a single binary. There's no separate database
  or job queue to deploy, and Sortie itself sends no telemetry". It persists to
  SQLite ([README](https://github.com/sortie-ai/sortie#how-it-works);
  [README Prior Art](https://github.com/sortie-ai/sortie#prior-art)). Needs no
  hosted service (none stated).
- **License / maintenance:** Apache-2.0
  ([LICENSE](https://github.com/sortie-ai/sortie/blob/HEAD/LICENSE)). Latest
  release v1.32.0 on 2026-11-10; last push 2026-11-12
  ([releases](https://github.com/sortie-ai/sortie/releases)).

## Orbi

*How it was identified:* `orbi-build/orbi`, a "self-hostable lights-out
software factory … label a GitHub Issue, get an independently reviewed, merged
PR and a tagged release" ([repo](https://github.com/orbi-build/orbi)). This is
not the Netgear Orbi router line.

- **URL / repo:** [orbi.build](https://orbi.build) ·
  [docs.orbi.build](https://docs.orbi.build/) ·
  [github.com/orbi-build/orbi](https://github.com/orbi-build/orbi)
- **What it is:** "an open-source software dark factory: a software delivery
  system for GitHub" ([README](https://github.com/orbi-build/orbi#orbi)).
- **How work enters:** Label a GitHub Issue `ai-ready`, or run `orbi add`.
  Releases are requested through `ai-release` issues
  ([README](https://github.com/orbi-build/orbi#orbi);
  [workflow](https://github.com/orbi-build/orbi/blob/HEAD/docs/workflow.mdx)).
- **Agents driven:** Pi only. Development is "Pi development: plan → implement →
  test → verify" ([README](https://github.com/orbi-build/orbi#what-it-does)).
  Model providers sit behind Pi
  ([providers](https://github.com/orbi-build/orbi/blob/HEAD/docs/providers.mdx)).
  Claude Code and Codex CLIs as runtimes: not stated.
- **Isolation:** "an isolated worktree" per task
  ([README](https://github.com/orbi-build/orbi#orbi)). A community-maintained,
  unofficial Docker wrapper exists
  ([docker](https://github.com/orbi-build/orbi/blob/HEAD/docs/docker.mdx)).
  Network restriction: not stated.
- **Quality gates:**
  - An independent review session that "fixes findings in the same session".
    "Reviewed code is what merges, and only with CI green on the latest base."
    "AI never merges or pushes protected branches"
    ([README Why Orbi](https://github.com/orbi-build/orbi#why-orbi)).
  - The review may run on a different provider or model
    (`review_pi_provider`, `review_pi_model`)
    ([workflow, Reviewing with a different model](https://github.com/orbi-build/orbi/blob/HEAD/docs/workflow.mdx)).
  - The review and fix loop is bounded at 5 rounds. An optional
    `ai-human-review` human acceptance label exists
    ([workflow](https://github.com/orbi-build/orbi/blob/HEAD/docs/workflow.mdx)).
- **Cost tracking / budgets:** not stated.
- **Auth:** API keys per provider (e.g. `GOOGLE_API_KEY`, `ZAI_API_KEY`,
  `OPENROUTER_API_KEY`). Also "Codex OAuth: use a ChatGPT/Codex subscription"
  through Pi's `openai-codex` provider
  ([providers](https://github.com/orbi-build/orbi/blob/HEAD/docs/providers.mdx)).
- **UI surfaces:** GitHub itself plus a CLI. "Self-hosted Core has no database,
  message queue, or web UI"
  ([security](https://github.com/orbi-build/orbi/blob/HEAD/docs/security.mdx)).
- **Storage / hosted service:** "GitHub Issues are the only state store—no
  database, queue, or daemon". A user timer (systemd or launchd) ticks every 5
  minutes ([README](https://github.com/orbi-build/orbi#orbi)). There is also a
  paid hosted Orbi Cloud ("3 merged deliveries free")
  ([README](https://github.com/orbi-build/orbi#orbi)).
- **License / maintenance:** You may pick either AGPL-3.0 or the Sustainable
  Use License v1.0
  ([README License](https://github.com/orbi-build/orbi#license);
  [LICENSE](https://github.com/orbi-build/orbi/blob/HEAD/LICENSE)). Latest release
  v0.7.43 on 2026-11-15; last push 2026-11-15
  ([releases](https://github.com/orbi-build/orbi/releases)).

## Vibe Kanban

*How it was identified:* `BloopAI/vibe-kanban`, "Get 10X more out of Claude
Code, Codex or any coding agent" ([repo](https://github.com/BloopAI/vibe-kanban)).

- **URL / repo:** [vibekanban.com](https://www.vibekanban.com/) ·
  [github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
- **What it is:** kanban issues for planning, plus workspaces where coding
  agents run, with review of the diffs
  ([README Overview](https://github.com/BloopAI/vibe-kanban#overview)). The
  README headline reads "**Vibe Kanban is sunsetting.**"
  ([README](https://github.com/BloopAI/vibe-kanban)).
- **How work enters:** kanban issues on its board
  ([README](https://github.com/BloopAI/vibe-kanban#overview)). GitHub issue
  intake: not stated.
- **Agents driven:** "Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp,
  Cursor, OpenCode, Droid, CCR, and Qwen Code"
  ([README](https://github.com/BloopAI/vibe-kanban#overview)).
- **Isolation:** each workspace gives an agent "a branch, a terminal, and a dev
  server" ([README](https://github.com/BloopAI/vibe-kanban#overview)). The
  workspaces are git worktrees (`DISABLE_WORKTREE_CLEANUP`, [README env
  vars](https://github.com/BloopAI/vibe-kanban#environment-variables)). Container
  and network restriction: not stated.
- **Quality gates:** You leave inline diff comments, open PRs, "review on
  GitHub, and merge" ([README](https://github.com/BloopAI/vibe-kanban#overview)).
  CI and review agents: not stated.
- **Cost tracking / budgets:** not stated.
- **Auth:** "Make sure you have authenticated with your favourite coding agent"
  ([README Installation](https://github.com/BloopAI/vibe-kanban#installation)).
  Subscription versus API key: not stated.
- **UI surfaces:** a local web app (`npx vibe-kanban`) with a built-in browser
  preview. The README also refers to "the local desktop app"
  ([README](https://github.com/BloopAI/vibe-kanban#overview);
  [env vars](https://github.com/BloopAI/vibe-kanban#environment-variables)).
- **Storage / hosted service:** local SQLite (`sqlx` with the `sqlite` feature,
  [crates/db/Cargo.toml](https://github.com/BloopAI/vibe-kanban/blob/HEAD/crates/db/Cargo.toml)).
  A self-hostable "Vibe Kanban Cloud" exists for teams
  ([README Self-Hosting](https://github.com/BloopAI/vibe-kanban#self-hosting)).
  The vendor's hosted remote services were ended; see the next field.
- **Company status:** On 2026-04-10, "we're shutting down bloop, the company
  behind Vibe Kanban". The project continues "open source and community
  maintained" ([announcement](https://www.vibekanban.com/blog/shutdown)).
  "Remote services will remain available for 30 days". The removed services were
  "kanban issues, comments, projects and organisations". "Local workspaces will
  continue to function" ([shutdown page](https://vibekanban.com/shutdown)).
- **License / maintenance:** Apache-2.0
  ([LICENSE](https://github.com/BloopAI/vibe-kanban/blob/HEAD/LICENSE)).
  Releases: v0.1.44 on 2026-04-24, then nothing until v0.1.46 on 2026-11-15;
  last push 2026-11-15 ([releases](https://github.com/BloopAI/vibe-kanban/releases)).

---

## Summary table

Short cells. The sources are in the sections above. "n/s" means not stated.

| | Work enters | Agents | Isolation | Network limit | Gates | Cost / budget | Auth | UI | Storage / hosted | License | Latest release |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **ProPR** | GitHub issue label, PR comments, chat, CLI | Claude Code, Codex, Antigravity, OpenCode, Mistral Vibe | worktree + Docker | allowlist proxy, opt-in (off by default) | `/review` score, Ultrafix, validation cmds; human merge by default | per-run cost; per-run cap | subscription or API key | web, PWA, desktop RC, MCP chat, CLI | SQLite + Redis; self-hosted; optional relay | Apache-2.0 | v0.9.1, 2026-11-01 |
| **Kandev** | board; GitHub/GitLab/Jira/Linear/Sentry; webhooks | 22 CLIs (ACP + passthrough) | worktree; local/Docker/K8s/SSH/sprites | n/s | review steps, CI-fixup workflow | only in unreleased Office mode | agent's own sign-in | web, desktop | SQLite in `~/.kandev`; no cloud | AGPL-3.0 | v0.101.0, 2026-11-11 |
| **Cline Kanban** | cards on a board | cline, claude, codex, droid, kiro | worktree | n/s | human diff review; auto-commit/PR optional | n/s | installed CLI's own | local web | `~/.cline/kanban`; no account | Apache-2.0 | v0.1.70, 2026-07-12 |
| **Agent Orchestrator** | chat to an orchestrator agent; mobile | "35+" (36 listed) | worktree; hosted cloud workspaces | "not OS or network isolation" | CI/review feedback to agent; reviewer agent | n/s | CLI subscription logins | desktop, iOS, Android | SQLite; cloud needs account | Apache-2.0 | v0.15.2, 2026-11-15 |
| **Orca** | desktop, GitHub/Linear tasks, CLI, automations | any CLI (34 logos) | worktree; SSH; remote server; your cloud VM/container | n/s | diff notes; failing checks to agent | subscription-limit view; estimated cost; no cap | own subscription | desktop, iOS, Android APK | n/s | MIT | v1.4.259, 2026-11-14 |
| **Sortie** | polls GitHub/GitLab/Gitea/Linear/Jira | Claude Code, Copilot, OpenCode, Codex, Kiro, Gemini | directory per issue; SSH hosts; container | n/s | self-review cmds, CI feedback, escalation | per-turn, per-issue, daily/weekly/monthly caps | subscription or API key (Claude) | dashboard, JSON API, Prometheus | SQLite; single binary | Apache-2.0 | v1.32.0, 2026-11-10 |
| **Orbi** | `ai-ready` issue label | Pi only | worktree | n/s | independent review session, CI green, bounded rounds | n/s | API keys; Codex OAuth via Pi | GitHub + CLI | GitHub Issues only; optional paid cloud | AGPL-3.0 or SUL | v0.7.43, 2026-11-15 |
| **Vibe Kanban** | kanban issues | 10 incl. Claude Code, Codex, Gemini CLI | worktree | n/s | human diff review, PR | n/s | agent's own | local web, desktop | SQLite; vendor cloud ended | Apache-2.0 | v0.1.46, 2026-11-15 |

---

## Other comparables

Found along the way. These were checked only against their own repository
metadata, not field by field.

- **OpenAI Symphony.** [github.com/openai/symphony](https://github.com/openai/symphony).
  Its repo description: "Symphony turns project work into isolated, autonomous
  implementation runs". Apache-2.0, last push 2026-09-15. Lingtai's
  [from-symphony.md](../from-symphony.md) already maps it.
- **Baton.** [github.com/mraza007/baton](https://github.com/mraza007/baton).
  Its repo description: "Autonomous coding agent orchestrator — polls GitHub
  Issues, runs agents in isolated worktrees, opens PRs". MIT, last push
  2026-03-27.
- **Kagan.** [github.com/kagan-sh/kagan](https://github.com/kagan-sh/kagan) ·
  [kagan.sh](https://kagan.sh). Its repo description: "Open-source desktop app
  for AI coding agents. Run Claude Code, Codex, and more in terminals, review
  changes, and work in isolated Git worktrees". Apache-2.0, last push
  2026-11-15.
- **Agent Kanban.** [github.com/saltbo/agent-kanban](https://github.com/saltbo/agent-kanban) ·
  [agent-kanban.dev](https://agent-kanban.dev). Its repo description: "An
  agent-first task board, Take human out of the loop". GitHub reports no
  recognised license (`NOASSERTION`). Last push 2026-11-13.

---

## Could not verify: claims from the AI-generated table

Each claim is marked **confirmed**, **contradicted** or **not found**, with the
link that decides it.

| Claim | Verdict | Evidence |
|---|---|---|
| ProPR "runs in Docker with a network allowlist and a read-only GitHub token" | **Confirmed, with a correction.** Docker and the read-only token are always on. The allowlist is opt-in: the default network mode is `open`, and Antigravity falls back to `open` | [execution safety](https://github.com/integry/propr/blob/HEAD/docs/docs/features/execution-safety.md); [README FAQ](https://github.com/integry/propr#faq) ("off by default") |
| ProPR "/review multi-model scoring" | **Confirmed.** One review comment per requested model, each ending `Score: N/10` | [PR commands](https://github.com/integry/propr/blob/HEAD/docs/docs/features/pr-commands.md) |
| ProPR "screenshots pasted into the PR" | **Confirmed, with a correction.** Visual Previews put screenshots or videos into PRs. They are opt-in per repository and need an OAuth App token or a PAT | [visual previews](https://github.com/integry/propr/blob/HEAD/docs/docs/features/visual-previews.md) |
| ProPR "reuses Plus/Pro subscriptions" | **Confirmed.** "such as Claude Pro or ChatGPT Plus" | [README FAQ](https://github.com/integry/propr#faq) |
| Kandev "built-in editor, terminal, browser preview" | **Confirmed.** "file editor, file tree, terminal, browser preview, and git changes in one place" | [README](https://github.com/kdlbs/kandev#what) |
| Cline Kanban "built-in editor, terminal, browser preview" | **Terminal confirmed; editor and browser preview not found.** Each card gets "its own terminal". The README describes a diff view and a Script Shortcut that runs commands such as `npm run dev`, but no editor or browser preview | [README](https://github.com/cline/kanban#readme) |
| Agent Orchestrator "35+ CLI and IDE agents" | **Confirmed.** "Supports Claude Code, Codex & 35+ coding agents"; the README lists 36 | [repo](https://github.com/OrchestratorInc/agent-orchestrator); [README](https://github.com/OrchestratorInc/agent-orchestrator#supported-agents) |
| Orca "35+ CLI and IDE agents" | **Not found.** Orca says "Works with any CLI agent" and shows 34 logos. It gives no "35+" figure | [README](https://github.com/stablyai/orca#supported-agents) |
| Agent Orchestrator "iOS/Android app" | **Confirmed** | [README Mobile](https://github.com/OrchestratorInc/agent-orchestrator#orchestrator-for-mobile) |
| Orca "iOS/Android app" | **Confirmed.** iOS on the App Store; Android as an APK, not a store listing | [README Install](https://github.com/stablyai/orca#install) |
| Orca "dispatch to remote SSH hosts or cloud VMs" | **Confirmed.** The cloud VM is your own provider's, not Orca-hosted | [README](https://github.com/stablyai/orca#features); [ways to run](https://orca.dev/docs/ways-to-run) |
| Agent Orchestrator "dispatch to remote SSH hosts or cloud VMs" | **Cloud confirmed; SSH not found.** "Cloud Agents" run in hosted workspaces, gated by account entitlement. No SSH-host dispatch is stated | [README Cloud Agents](https://github.com/OrchestratorInc/agent-orchestrator#cloud-agents); [STATUS.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/STATUS.md) |
| Sortie "fixes from GitHub Actions CI results" | **Confirmed.** CI feedback is off by default. It works with GitHub Actions or any CI that reports through the forge's status API | [CI feedback](https://docs.sortie-ai.com/guides/configure-ci-feedback/) |
| Orbi "independent review agent" | **Confirmed, with a nuance.** It is a separate Pi review session, which may use a different provider or model. It is not a different agent runtime | [README](https://github.com/orbi-build/orbi#why-orbi); [workflow](https://github.com/orbi-build/orbi/blob/HEAD/docs/workflow.mdx) |
| Vibe Kanban "depended on a cloud service and was shut down" | **Contradicted in part.** The company (bloop) shut down on 2026-04-10, and its hosted remote services ended after 30 days. The open-source app was not shut down: "local workspaces will continue to function", and v0.1.46 was released on 2026-11-15. Whether the local app *depended* on the cloud is not stated | [announcement](https://www.vibekanban.com/blog/shutdown); [shutdown page](https://vibekanban.com/shutdown); [releases](https://github.com/BloopAI/vibe-kanban/releases) |
