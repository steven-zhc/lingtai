# Vibe Kanban 用户最想要什么，Lingtai 接得住多少

**研究快照：2026-11-10** · 版本安排见文末"建议"一节：0.15.0 本地可靠交付，0.16.0 承接 VK 用户。

## 结论先行

Vibe Kanban（[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)）已经宣布 sunset，云服务关停。它的 issue 区里，现在最强的需求信号其实是 **"让我在本机继续用"**。这恰好是 Lingtai 已经做到的：本地运行、不依赖云、GitHub issues 直接当队列、AI 自己循环到检查和审查通过为止，每一步都有记录。

Lingtai 接不住的有四块：

1. **agent 种类**：只有 Claude Code 和 Codex。VK 用户点名要的 Kiro、goose、ACP、Kimi、OpenCode 等合计 50+ 👍，是最大的缺口。
2. **GitLab**：VK 票数第一的需求（26👍）。代码放 GitLab、任务放本地，按设计应该能跑，但没实测过；GitLab issues 不能作为任务来源。
3. **Docker 镜像**：没有官方镜像。
4. **交互式使用**：不能边跑边和 agent 对话；看板上的卡片也不能拖拽改状态。

两者的定位不同。VK 是人坐在前面同时操作很多 agent 的工作台，Lingtai 是无人值守、带检查和审查的流水线。VK 停更后流出的用户里，要"本地 + issue 驱动 + 自动循环 + 依赖链"的那一批和 Lingtai 很对口，而且 Lingtai 还多了 VK 没有的检查、独立审查和花费记账。偏爱拖拽看板和实时对话的那一批，Lingtai 目前接不住，也不一定该去接。

---

## 方法与局限

- 用 GitHub 搜索取 VK 的 open issue，按 reactions 排序看前 100 个，再看最近新开的 40 个。当时 open issue 共 388 个。
- 👍 数整体偏低：最热的一条只有 26。这是一个弱信号，用来排序可以，用来证明市场规模不够。
- 项目停更后，一部分 issue 的真实意思是"请别让它死掉"，而不是功能请求。下面把这一类单独归成"本地 / 自托管"主题。
- Lingtai 一侧的判断都附了代码或 ADR 位置，以写这篇文章时 `main` 上的代码为准。标"推断"的地方没有实际跑过。
- 下文 VK 的 issue 一律写成链接，不用裸的 `#N`：在本仓库里裸的 `#N` 指向的是 Lingtai 自己的 issue。

## 背景：VK 已经停更

- 官网横幅写着 "Vibe Kanban is sunsetting"，说项目会以开源、社区维护的方式继续（[VK#3433](https://github.com/BloopAI/vibe-kanban/issues/3433)）。
- 0.1.44 把 Projects 改成只能导出，自建服务器上的也一样打不开（[VK#3396](https://github.com/BloopAI/vibe-kanban/issues/3396)，19👍）。
- 有人问"能不能把只在本地用的项目还给我们，自建整套服务太重了"（[VK#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)），也有人直接问"这个项目死了吗"（[VK#3408](https://github.com/BloopAI/vibe-kanban/issues/3408)）。

## 需求逐项对照

✅ 已支持　🟡 部分支持　❌ 不支持

| VK 的需求 | 👍 | Lingtai | 依据 |
|---|---|---|---|
| **只在本地用、自托管、不依赖云**（[VK#3396](https://github.com/BloopAI/vibe-kanban/issues/3396)、[VK#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)、[VK#3399](https://github.com/BloopAI/vibe-kanban/issues/3399)） | 19+5+3 | ✅ | `lingtai init --store sqlite --local`，记录存在本机的 SQLite 文件里；任务可以存在本地数据库，不需要 GitHub（`lingtai ticket new`，`packages/conductor/src/db-tickets.ts`）；看板是本地应用（[0111](../../decisions/0111-the-board-is-a-local-app.md)） |
| **AI 自己循环、自我验证**（"Ralph Wiggum mode"，[VK#1946](https://github.com/BloopAI/vibe-kanban/issues/1946)） | 20 | ✅ 核心能力 | 构建检查 → 独立审查（reviewer 不是写代码的那个 agent）→ 不通过就再给 agent 一轮修改（[0103](../../decisions/0103-a-pass-is-ten-fixed-steps.md)、[0108](../../decisions/0108-a-refusal-buys-a-round.md)）；daemon 不停地从队列取任务 |
| **定时心跳 prompt**（[VK#3039](https://github.com/BloopAI/vibe-kanban/issues/3039)：瞬时错误后自动重试、自动整理看板） | 7 | 🟡 | daemon 本身就在循环，有退避后重试，`lingtai now` 可以跳过退避；但不能"每 X 分钟跑一段自定义 prompt" |
| **自动导入 GitHub issues 作为任务、双向同步**（[VK#1677](https://github.com/BloopAI/vibe-kanban/issues/1677)、[VK#479](https://github.com/BloopAI/vibe-kanban/issues/479)） | 9+7 | ✅ | issues 本身就是队列（recipe 的 `source.kinds`，`packages/conductor/src/discover.ts`）；完成后的关 issue、改标签由 `end` 步骤的 `close:`、`labels:` 做 |
| **任务依赖 / 任务链 / 子任务**（[VK#1700](https://github.com/BloopAI/vibe-kanban/issues/1700)、[VK#1922](https://github.com/BloopAI/vibe-kanban/issues/1922)、[VK#876](https://github.com/BloopAI/vibe-kanban/issues/876)） | 8+7+6 | ✅ GitHub 项目 · 🟡 本地项目 | 用 GitHub 原生的 *blocked by*，有未关闭的阻塞就跳过（`discover.ts:155`）；拆分计划会创建子 issue 并自动连成链（`packages/conductor/src/split-ticket.ts`）。**本地数据库里的任务没有依赖**：`dependencies` 恒为 `{ blockedBy: 0 }`（`db-tickets.ts:28`），拆分子任务也只对 GitHub 项目有效。见下面的专题 |
| **自动清理 worktree**（[VK#765](https://github.com/BloopAI/vibe-kanban/issues/765)） | 19 | ✅ | 每次运行一个独立 worktree，结束时自动删除（`packages/conductor/src/run-attempt.ts:931`） |
| **合并后删除分支**（[VK#2680](https://github.com/BloopAI/vibe-kanban/issues/2680)） | 6 | ✅ | recipe 里在 `end:` 写 `refs: true, branch: true`（`packages/recipe/src/recipe.ts:841`），由 `packages/conductor/src/tell.ts:313` 执行 |
| **把 `.env` 等被 git 忽略的文件带进 worktree**（`.worktreeinclude`，[VK#1947](https://github.com/BloopAI/vibe-kanban/issues/1947)） | 9 | 🟡 | 会往 worktree 写一个 env 文件，变量来自 recipe 声明的名字（`packages/repo/src/worktree.ts:215`）；不能拷贝任意被忽略的文件 |
| **规格驱动开发**（spec → plan → tasks，[VK#1848](https://github.com/BloopAI/vibe-kanban/issues/1848)） | 8 | 🟡 | 十个步骤里有 `design`；agent 遇到没定的地方可以停下来问人（`asked`）；能拆分成子任务。没有访谈式生成规格的流程 |
| **支持 Claude Code 的 `AskUserQuestion`**（[VK#1220](https://github.com/BloopAI/vibe-kanban/issues/1220)） | 7 | 🟡 | 只有 `admit`、`design`、`implement` 三个步骤里的 agent 能停下来问人（`asked`，[0103](../../decisions/0103-a-pass-is-ten-fixed-steps.md) §4），问完任务停在 `waiting` 等人处理 |
| **更多 agent**：Kiro、goose、任意 ACP 客户端、Kimi、Mistral、OpenCode、Antigravity…（[VK#1708](https://github.com/BloopAI/vibe-kanban/issues/1708)、[VK#2162](https://github.com/BloopAI/vibe-kanban/issues/2162)、[VK#2365](https://github.com/BloopAI/vibe-kanban/issues/2365)、[VK#2463](https://github.com/BloopAI/vibe-kanban/issues/2463)、[VK#1812](https://github.com/BloopAI/vibe-kanban/issues/1812)、[VK#3492](https://github.com/BloopAI/vibe-kanban/issues/3492)） | 合计 50+ | ❌ **最大差距** | `RuntimeId = z.enum(['claude-code', 'codex'])`（`packages/domain/src/events.ts:140`） |
| **自托管 GitLab**（[VK#1697](https://github.com/BloopAI/vibe-kanban/issues/1697)，**第一名**） | 26 | 🟡 | `repo.remote` 接受任何 git 地址，合并是本地 `git merge` 加 push，不走 PR；任务可以放本地数据库。所以"GitLab 当 remote + 本地任务"按设计应该能跑（推断，未验证）。GitLab issues 不能作为任务来源。见下面的专题 |
| **保留经典看板、拖拽操作、跨项目全局视图**（[VK#2730](https://github.com/BloopAI/vibe-kanban/issues/2730)、[VK#2509](https://github.com/BloopAI/vibe-kanban/issues/2509)、[VK#2021](https://github.com/BloopAI/vibe-kanban/issues/2021)） | 15+15+6 | 🟡 | 有看板，列是 排队 / 运行中 / 等你处理 / 已落地；但列是从记录算出来的状态，不能拖拽改；能在项目间筛选 |
| **任务完成发 webhook 通知**（[VK#1110](https://github.com/BloopAI/vibe-kanban/issues/1110)） | 5 | 🟡 | 有桌面通知和 Telegram（recipe 的 `subscribers:`，`recipe.ts:3212`）；通知方是一个外部命令，所以自己写个 curl 应该能接 webhook（推断，未试） |
| **项目级聊天窗口**（[VK#3038](https://github.com/BloopAI/vibe-kanban/issues/3038)） | 5 | 🟡 | 有针对单个任务的讨论（`lingtai ask` / `discuss:`）和自动分诊（`triage:`）；没有项目级、能直接建任务的聊天 |
| **定时开始某个任务**（[VK#709](https://github.com/BloopAI/vibe-kanban/issues/709)） | 6 | ❌ | |
| **检查点 / 撤销改动**（[VK#2106](https://github.com/BloopAI/vibe-kanban/issues/2106)） | 3 | ❌ | 事件记录可以重放，但没有代码层面的撤销 |
| **官方 Docker 镜像**（[VK#2471](https://github.com/BloopAI/vibe-kanban/issues/2471)、[VK#3440](https://github.com/BloopAI/vibe-kanban/issues/3440)） | 8 | ❌ | 用安装脚本装版本化的二进制（[0113](../../decisions/0113-distribution-is-a-versioned-binary.md)） |

## 两种产品，两类用户

**Vibe Kanban** 的核心是一块交互式看板：人把任务拖到"进行中"，挑一个 agent 开跑，盯着它的输出，随时追加消息，最后自己决定合不合。它的热门反馈里很大一块是 UI 手感：保留经典看板、拖一次就完成（[VK#2730](https://github.com/BloopAI/vibe-kanban/issues/2730)、[VK#2509](https://github.com/BloopAI/vibe-kanban/issues/2509)），以及支持更多 agent。

**Lingtai** 的核心是一条固定的流水线：取任务 → 准备 worktree → 设计 → 实现 → 构建 → 独立审查 → 路由 → 合并 → 收尾。人只在流水线停下来问的时候出现，看板是记录的投影，不是操作台。

VK 的需求因此分成两类：

- **Lingtai 天然覆盖的**：本地运行、issue 驱动、自动循环自我验证、依赖链、worktree 和分支的自动清理。这些在 VK 里是"请加上"，在 Lingtai 里是架构本身。VK 用户反复要的"让 AI 自己测、自己改、直到通过"（[VK#1946](https://github.com/BloopAI/vibe-kanban/issues/1946)），正是 Lingtai 的 build → review → 修改轮次。
- **Lingtai 有意不做或还没做的**：拖拽看板、和运行中的 agent 实时对话、检查点撤销。前两项和"无人值守 + 每步留证据"的方向有张力，不建议为了接 VK 用户去补。

## 专题：Docker 镜像

### VK 用户要的是什么

**票数不高，但背后的场景是真的。** 把 VK 里和 Docker 有关的 issue 都搜出来，直接要镜像的就三条，加起来约 10👍：

- [VK#2471](https://github.com/BloopAI/vibe-kanban/issues/2471)（8👍）：每次发版自动推一个镜像到 ghcr.io，"方便部署到远程服务器"。
- [VK#3440](https://github.com/BloopAI/vibe-kanban/issues/3440)：现在要自己构建、推到私有仓库、再拉到 VPS；提问者只好用一个落后约 10 个版本的社区镜像。
- [VK#1162](https://github.com/BloopAI/vibe-kanban/issues/1162)（已关闭）：加 Docker 支持。

旁边还有一串自己用 Docker 部署时踩坑的 issue：docker compose 跑不起来（[VK#2976](https://github.com/BloopAI/vibe-kanban/issues/2976)、[VK#2895](https://github.com/BloopAI/vibe-kanban/issues/2895)）；容器里 git 推送要手改权限才能用（[VK#3410](https://github.com/BloopAI/vibe-kanban/issues/3410)，配置里有 `privileged: true`，还挂载了 docker.sock）；想要 Helm chart（[VK#3147](https://github.com/BloopAI/vibe-kanban/issues/3147)）。

所以用户要的其实不是"一个镜像"，而是**在一台不关机的远程服务器上长期跑，从浏览器访问**。Docker 只是他们知道的最省事的做法。

### Lingtai 做起来有多难

**打包本身很容易。** Lingtai 已经为 `linux-x64` 和 `linux-arm64` 发布不依赖 Node 的单文件二进制，看板也一起打包了（[0113](../../decisions/0113-distribution-is-a-versioned-binary.md)）。所以镜像就是"基础镜像 + 这个二进制 + git"，在 `.github/workflows/release.yml` 里加一步推到 ghcr.io 就行。

**难的是容器里的几件事。** VK#3410 踩的正是这类坑：

1. **agent 的登录状态。** agent 以你的身份运行，用的是本机已登录的 Claude Code 或 Codex。容器里要么挂载 `~/.claude`，要么在容器里登录一次，所以镜像还得装 Claude Code 或 Codex 的 CLI。
2. **状态目录要持久化。** `~/.lingtai` 里有配置、recipe、SQLite 记录、镜像仓库和 worktree，必须挂成卷。否则容器一重建，记录就没了。
3. **要在前台跑。** `lingtai service` 管的是宿主机上的系统服务，容器里应该直接在前台跑 `lingtai start`。另外，正在跑的 daemon 不会用上新代码，所以换镜像版本时要先停掉排空（`lingtai shutdown`，[0102](../../decisions/0102-one-conductor-holds-the-lock.md)），而不是直接杀容器。
4. **看板没有登录验证。** 看板默认监听 `0.0.0.0:17820`，而且没有认证（[0111](../../decisions/0111-the-board-is-a-local-app.md) §2）：能访问它的人，就能以这台机器的身份批准、重新排队、回答问题。放到 VPS 上必须配反向代理和认证，或者走 VPN / SSH 隧道。这一条要在文档里写在最显眼的位置。
5. **git 和 GitHub 的凭证**：GitHub App 的私钥，以及推送用的凭证，都要用 secret 传进容器。

**反过来，Docker 对 Lingtai 还有一个额外的好处：安全。** [safety.md](../../safety.md) 写明，默认情况下 Claude Code 能读你能读的任何文件，包括 `~/.ssh`，Lingtai 不提供文件系统沙箱。放进容器后，agent 能看到的就只有挂进去的东西。这正好补上了 safety.md 里说的"agent 出不去的沙箱"（#339）还没做完的那块。本机场景该用什么沙箱，另见 [agent-sandbox-options.md](../0.14.0/agent-sandbox-options.md)。

### 判断

单论票数，这个需求排不进前几。但它成本低，又和"VK 停更后想在自己服务器上继续跑的用户"直接对口，还能顺带在隔离上有实际收益，值得做。建议分两步：

1. **先写一篇部署文档**：Docker 或 VPS 部署 Lingtai，把上面五个坑讲清楚，尤其是看板必须放在认证后面。
2. **再在 release workflow 里加镜像发布**，每个 tag 推 `ghcr.io/…/lingtai:vX.Y.Z` 和 `:latest`。

## 专题：更多 agent

### VK 用户要的是什么

点名要的 agent 一长串：

- Kiro（[VK#1708](https://github.com/BloopAI/vibe-kanban/issues/1708)，11👍）
- goose（[VK#2162](https://github.com/BloopAI/vibe-kanban/issues/2162)，11👍）
- 任意 ACP 客户端（[VK#2365](https://github.com/BloopAI/vibe-kanban/issues/2365)，9👍）
- 其他：Kimi、Mistral Vibe、OpenClaw、Antigravity、Muse、Copilot CLI、Warp…
- 还有一个 RFC 要"通用的自定义执行器"（[VK#2775](https://github.com/BloopAI/vibe-kanban/issues/2775)）

关键是 [VK#2365](https://github.com/BloopAI/vibe-kanban/issues/2365)。它要的是 Zed 那种做法：在配置里写一条命令就能接上任何讲 ACP（Agent Client Protocol）的 agent。用户真正想要的是"我自己选 agent"，而不是"你再多加一个"。

### Lingtai 现在的状况

只有两个运行时：`RuntimeId` 只有 `claude-code` 和 `codex`（`packages/domain/src/events.ts:140`）。

**加一个运行时的门槛比 VK 高**，因为 Lingtai 对运行时有几条硬要求，都写在 `packages/agent/src/runtime.ts:37` 的 `RuntimeCapabilities` 里：

- **能报回轮数、花费和 token**（`RunOutcome` 里的 `turns`、`costUsd`、`usage`）。没有这些，花费记账和单日花费上限就失效了。
- **能限制轮数和时长**（`enforces`）。#84 就吃过亏：只有时长生效，结果跑了 172 轮，而上限是 150。
- **能输出结构化结果**（`acceptsOutputSchema`）。审查和判断要靠它返回固定格式的结论。
- **能运行一个完全没有工具的 agent**（`tools: 'none'`）。做不到的会被拒绝（`ToolsCannotBeDenied`，`packages/agent/src/runtimes.ts:64`），不会退而求其次。
- **`guarded` 这一档**要求 agent 自带的 hook 在连不上 Lingtai 时能让运行失败，而不是悄悄继续（`canFailClosed`）。

[0106](../../decisions/0106-a-role-keeps-its-powers-across-runtimes.md) 还规定，一个角色换了运行时也要保持同样的权限。

### ACP 可能是一条近路

在 ACP 里，Lingtai 自己就是客户端：

- prompt 是 Lingtai 发的；
- 每个工具调用都会通知客户端，需要授权的由客户端批准或拒绝；
- 运行由客户端发起，也由客户端终止。

所以"agent 的 hook 连不上 Lingtai 怎么办"这个问题在 ACP 下基本不存在。

**卡点在于 ACP 是否规定了 token 和花费的上报**，这一点没有核实。如果没规定，就要按模型自己算价，或者把这类运行时标为"花费不可知"，并且不允许它跑在有花费上限的步骤上。

### 判断

先做一个 ACP 运行时，而不是逐个接 Kiro、goose。一个适配器能覆盖 50+ 👍 的需求。第一步是核实 ACP 的花费上报。

## 专题：GitLab

### VK 用户要的是什么

[VK#1697](https://github.com/BloopAI/vibe-kanban/issues/1697)（26👍，VK 票数第一）的原话是：公司代码在自托管 GitLab 上，diff、建 PR 都用不了。另外还有人用 Bitbucket（[VK#3410](https://github.com/BloopAI/vibe-kanban/issues/3410)），有人想从 Azure DevOps 导入（[VK#1932](https://github.com/BloopAI/vibe-kanban/issues/1932)）。

### Lingtai 这边比看上去乐观

代码放在哪、任务放在哪，在设计上本来就是两件独立的事：

- **代码这一侧**：`repo.remote` 接受任何 git 地址，包括 `git@gitlab.公司:组/项目.git`，不做 URL 校验（`packages/recipe/src/recipe.ts:3029-3062`，#394）。合并也不开 PR，而是本地 `git merge --no-edit` 之后 push（`packages/actions/src/merge-action.ts:47`）。所以"不支持 GitLab 的 MR"对 Lingtai 根本不构成障碍，它就不走 PR。
- **任务这一侧**：`source.tickets: db` 把任务放在本地数据库（`recipe.ts:1080`，#381）。
- **组合起来**：GitLab 当 remote + 本地任务，按设计应该能直接跑。但没实测过，push 用哪份 git 凭证也要确认。

### 真正缺的是"GitLab issues 作为任务来源"

任务来源的接口 `Tickets` 大约十个方法（`packages/conductor/src/ticket-store.ts:73`），现在有 GitHub 和 db 两个实现，GitLab 会是第三个。顺带一提，Jira、Linear 的需求（[VK#2159](https://github.com/BloopAI/vibe-kanban/issues/2159) 7👍、[VK#2424](https://github.com/BloopAI/vibe-kanban/issues/2424) 5👍）也是走这同一个接口。

要注意：GitLab 的"阻塞"类 issue 关联，印象中是付费版功能，需要核实。

### 判断

第一步只做一件事：实测并写出"GitLab / Bitbucket 当 remote + 本地任务"的部署说明，几乎零代码。是否接 GitLab issues，等有人真正用起来再说。

## 专题：本地任务的依赖链

### VK 用户要的是什么

任务依赖和任务链（[VK#1700](https://github.com/BloopAI/vibe-kanban/issues/1700)、[VK#1922](https://github.com/BloopAI/vibe-kanban/issues/1922)、[VK#876](https://github.com/BloopAI/vibe-kanban/issues/876)），合计 21👍。

### Lingtai 的缺口

- 本地任务的 `dependencies` 写死为 `{ blockedBy: 0 }`（`packages/conductor/src/db-tickets.ts:28`），永远不会被阻塞。
- **拆分子任务也只对 GitHub 项目有效**：建子任务和连成链都直接调 GitHub 的 `addBlockedBy`（`packages/conductor/src/split-ticket.ts:41`、`:343`）。注释里写着 #599 有意没有把依赖关系放进 `Tickets` 接口。所以本地项目上，"拆分"这一功能整个用不了，不只是依赖。

### 改起来不难

判断"能不能跑"的那一侧已经现成：`discover.ts` 只看 `blockedBy` 这个数字。需要补的是：

1. 加一张 `ticket_dependencies` 表；`listOpenIssues` 时数出还没关闭的阻塞任务有几个。
2. 加一条命令，比如 `lingtai ticket block <n> --by <m>`。
3. 让拆分在本地项目上也能写依赖。这一步要重新审视 #599 当初的决定：是把依赖关系加进 `Tickets` 接口，还是给本地任务单独做一个写入方。

### 判断

先做第 1、2 步，这是 VK 流出用户最直接需要的。第 3 步牵涉 #599 的决定，单独开票讨论。

## 专题：从 VK 迁移过来

### VK 用户要的是什么

[VK#3396](https://github.com/BloopAI/vibe-kanban/issues/3396)（19👍）的用户已经把数据从 Bloop Cloud 导出来了，但抱怨导出不完整：缺少 issue 和 workspace 的关联，也缺项目设置（比如颜色），他只好自己写爬虫补数据。这类用户手里有数据，在找新去处。

### Lingtai 这边的落脚点

本地任务表，加上 `lingtai ticket new` 和 `createIssue`。一个导入器要做的是：

- 读 VK 导出的数据；
- 未完成的任务转成 Lingtai 任务，打上 kind 标签，默认加 `agent:hold`，免得一导入就被 agent 领走；
- 已完成的跳过，或者只作为历史记录保留；
- VK 里的依赖和子任务关系，要等上面的本地依赖做完才能带过来。

卡点：没有见过 VK 导出文件的实际格式，需要拿一份真实导出来确认。

### 判断

放在本地依赖之后做。先写一页迁移说明，给出"VK 概念 → Lingtai 概念"的对照，比如 workspace 对应一次运行，task 对应一个任务，这比导入工具更早见效。

## 建议

如果目标是接住 VK 停更后流出的用户：

| | 成本 | 收益 | 先做什么 | 版本 |
|---|---|---|---|---|
| 本地任务依赖 | 低 | 中，21👍，是本地项目的基础 | 加依赖表和 `ticket block` 命令 | 0.15.0 |
| GitLab | 第一步几乎为零 | 最高的单项（26👍） | 实测 GitLab remote + 本地任务，写部署说明 | 0.15.0 |
| ACP 运行时 | 中到高，卡在花费上报 | 最高，50+ 👍 | 先只用于 `implement`，审查仍用 Claude Code / Codex；花费按"可能未知"处理 | 0.16.0 |
| VK 迁移 | 低到中 | 中，用户在找去处 | 先写概念对照，等依赖做完再做导入 | 0.16.0 |
| Docker | 低 | 中，还能隔离 agent | 先写部署文档，再发布镜像 | 不在 0.14.0–0.16.0 之内 |

版本安排：0.14.0 是安全（见 [agent-sandbox-options.md](../0.14.0/agent-sandbox-options.md)），0.15.0 是本地可靠交付（见 [roadmap-reliable-agent-delivery.md](../0.15.0/roadmap-reliable-agent-delivery.md)），0.16.0 是承接 VK 用户。VK 最热的三样（只在本地用、GitLab、任务依赖）在 0.15.0 就齐了，所以引流可以从 0.15.0 开始，0.16.0 再补 ACP、导入和看板拖拽。

另外两项也放进 0.16.0：看板拖拽映射成已有操作（拖到"已落地"是批准，拖回"排队"是重新排队，拖到一边是挂起），以及官网的"从 Vibe Kanban 过来"页面。

不建议跟进的：拖拽看板、项目级聊天、检查点撤销。它们服务的是"人在前面操作"的用法，和 Lingtai"人只在被问到时出现"的定位相反。

## 相关

- [market-opportunities.md](../../research/market-opportunities.md)：2026-09-03 的市场研究。它的结论是"更多模型、更多入口、更漂亮的任务板"会让 Lingtai 变成功能更少的同类品。本文建议的 ACP 运行时（更多 agent）和那条判断有张力：这里的理由是 VK 用户的明确需求，而不是追赶同类品，两者应一起权衡。
