# Vibe Kanban 用户最想要什么，Lingtai 接得住多少

**研究快照：2026-11-10**

## 结论先行

Vibe Kanban（[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)）已经宣布 sunset，云服务关停。它的 issue 区里，现在最强的需求信号其实是 **"让我在本机继续用"**。这恰好是 Lingtai 已经做到的：本地运行、不依赖云、GitHub issues 直接当队列、AI 自己循环到检查和审查通过为止，每一步都有记录。

Lingtai 接不住的有四块：

1. **agent 种类**：只有 Claude Code 和 Codex。VK 用户点名要的 Kiro、goose、ACP、Kimi、OpenCode 等合计 50+ 👍，是最大的缺口。
2. **GitLab**：VK 票数第一的需求（26👍），Lingtai 的托管代码只走 GitHub App。
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
| **只在本地用、自托管、不依赖云**（[VK#3396](https://github.com/BloopAI/vibe-kanban/issues/3396)、[VK#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)、[VK#3399](https://github.com/BloopAI/vibe-kanban/issues/3399)） | 19+5+3 | ✅ | `lingtai init --store sqlite --local`，记录存在本机的 SQLite 文件里；任务可以存在本地数据库，不需要 GitHub（`lingtai ticket new`，`packages/conductor/src/db-tickets.ts`）；看板是本地应用（[0111](../decisions/0111-the-board-is-a-local-app.md)） |
| **AI 自己循环、自我验证**（"Ralph Wiggum mode"，[VK#1946](https://github.com/BloopAI/vibe-kanban/issues/1946)） | 20 | ✅ 核心能力 | 构建检查 → 独立审查（reviewer 不是写代码的那个 agent）→ 不通过就再给 agent 一轮修改（[0103](../decisions/0103-a-pass-is-ten-fixed-steps.md)、[0108](../decisions/0108-a-refusal-buys-a-round.md)）；daemon 不停地从队列取任务 |
| **定时心跳 prompt**（[VK#3039](https://github.com/BloopAI/vibe-kanban/issues/3039)：瞬时错误后自动重试、自动整理看板） | 7 | 🟡 | daemon 本身就在循环，有退避后重试，`lingtai now` 可以跳过退避；但不能"每 X 分钟跑一段自定义 prompt" |
| **自动导入 GitHub issues 作为任务、双向同步**（[VK#1677](https://github.com/BloopAI/vibe-kanban/issues/1677)、[VK#479](https://github.com/BloopAI/vibe-kanban/issues/479)） | 9+7 | ✅ | issues 本身就是队列（recipe 的 `source.kinds`，`packages/conductor/src/discover.ts`）；完成后的关 issue、改标签由 `end` 步骤的 `close:`、`labels:` 做 |
| **任务依赖 / 任务链 / 子任务**（[VK#1700](https://github.com/BloopAI/vibe-kanban/issues/1700)、[VK#1922](https://github.com/BloopAI/vibe-kanban/issues/1922)、[VK#876](https://github.com/BloopAI/vibe-kanban/issues/876)） | 8+7+6 | ✅ GitHub 项目 · 🟡 本地项目 | 用 GitHub 原生的 *blocked by*，有未关闭的阻塞就跳过（`discover.ts:155`）；拆分计划会创建子 issue 并自动连成链（`packages/conductor/src/split-ticket.ts`）。**本地数据库里的任务没有依赖**：`dependencies` 恒为 `{ blockedBy: 0 }`（`db-tickets.ts:28`） |
| **自动清理 worktree**（[VK#765](https://github.com/BloopAI/vibe-kanban/issues/765)） | 19 | ✅ | 每次运行一个独立 worktree，结束时自动删除（`packages/conductor/src/run-attempt.ts:931`） |
| **合并后删除分支**（[VK#2680](https://github.com/BloopAI/vibe-kanban/issues/2680)） | 6 | ✅ | recipe 里在 `end:` 写 `refs: true, branch: true`（`packages/recipe/src/recipe.ts:841`），由 `packages/conductor/src/tell.ts:313` 执行 |
| **把 `.env` 等被 git 忽略的文件带进 worktree**（`.worktreeinclude`，[VK#1947](https://github.com/BloopAI/vibe-kanban/issues/1947)） | 9 | 🟡 | 会往 worktree 写一个 env 文件，变量来自 recipe 声明的名字（`packages/repo/src/worktree.ts:215`）；不能拷贝任意被忽略的文件 |
| **规格驱动开发**（spec → plan → tasks，[VK#1848](https://github.com/BloopAI/vibe-kanban/issues/1848)） | 8 | 🟡 | 十个步骤里有 `design`；agent 遇到没定的地方可以停下来问人（`asked`）；能拆分成子任务。没有访谈式生成规格的流程 |
| **支持 Claude Code 的 `AskUserQuestion`**（[VK#1220](https://github.com/BloopAI/vibe-kanban/issues/1220)） | 7 | 🟡 | 只有 `admit`、`design`、`implement` 三个步骤里的 agent 能停下来问人（`asked`，[0103](../decisions/0103-a-pass-is-ten-fixed-steps.md) §4），问完任务停在 `waiting` 等人处理 |
| **更多 agent**：Kiro、goose、任意 ACP 客户端、Kimi、Mistral、OpenCode、Antigravity…（[VK#1708](https://github.com/BloopAI/vibe-kanban/issues/1708)、[VK#2162](https://github.com/BloopAI/vibe-kanban/issues/2162)、[VK#2365](https://github.com/BloopAI/vibe-kanban/issues/2365)、[VK#2463](https://github.com/BloopAI/vibe-kanban/issues/2463)、[VK#1812](https://github.com/BloopAI/vibe-kanban/issues/1812)、[VK#3492](https://github.com/BloopAI/vibe-kanban/issues/3492)） | 合计 50+ | ❌ **最大差距** | `RuntimeId = z.enum(['claude-code', 'codex'])`（`packages/domain/src/events.ts:140`） |
| **自托管 GitLab**（[VK#1697](https://github.com/BloopAI/vibe-kanban/issues/1697)，**第一名**） | 26 | ❌ | 托管代码只走 GitHub App（[0114](../decisions/0114-a-github-app-not-a-token.md)）。合并和删分支走的是普通 git 命令（`packages/conductor/src/git-refs.ts`），所以理论上可以把 GitLab 当普通 git remote 用、任务放本地（推断，未验证）；GitLab MR 和 GitLab issues 都不支持 |
| **保留经典看板、拖拽操作、跨项目全局视图**（[VK#2730](https://github.com/BloopAI/vibe-kanban/issues/2730)、[VK#2509](https://github.com/BloopAI/vibe-kanban/issues/2509)、[VK#2021](https://github.com/BloopAI/vibe-kanban/issues/2021)） | 15+15+6 | 🟡 | 有看板，列是 排队 / 运行中 / 等你处理 / 已落地；但列是从记录算出来的状态，不能拖拽改；能在项目间筛选 |
| **任务完成发 webhook 通知**（[VK#1110](https://github.com/BloopAI/vibe-kanban/issues/1110)） | 5 | 🟡 | 有桌面通知和 Telegram（recipe 的 `subscribers:`，`recipe.ts:3212`）；通知方是一个外部命令，所以自己写个 curl 应该能接 webhook（推断，未试） |
| **项目级聊天窗口**（[VK#3038](https://github.com/BloopAI/vibe-kanban/issues/3038)） | 5 | 🟡 | 有针对单个任务的讨论（`lingtai ask` / `discuss:`）和自动分诊（`triage:`）；没有项目级、能直接建任务的聊天 |
| **定时开始某个任务**（[VK#709](https://github.com/BloopAI/vibe-kanban/issues/709)） | 6 | ❌ | |
| **检查点 / 撤销改动**（[VK#2106](https://github.com/BloopAI/vibe-kanban/issues/2106)） | 3 | ❌ | 事件记录可以重放，但没有代码层面的撤销 |
| **官方 Docker 镜像**（[VK#2471](https://github.com/BloopAI/vibe-kanban/issues/2471)、[VK#3440](https://github.com/BloopAI/vibe-kanban/issues/3440)） | 8 | ❌ | 用安装脚本装版本化的二进制（[0113](../decisions/0113-distribution-is-a-versioned-binary.md)） |

## 两种产品，两类用户

**Vibe Kanban** 的核心是一块交互式看板：人把任务拖到"进行中"，挑一个 agent 开跑，盯着它的输出，随时追加消息，最后自己决定合不合。它的热门反馈里很大一块是 UI 手感：保留经典看板、拖一次就完成（[VK#2730](https://github.com/BloopAI/vibe-kanban/issues/2730)、[VK#2509](https://github.com/BloopAI/vibe-kanban/issues/2509)），以及支持更多 agent。

**Lingtai** 的核心是一条固定的流水线：取任务 → 准备 worktree → 设计 → 实现 → 构建 → 独立审查 → 路由 → 合并 → 收尾。人只在流水线停下来问的时候出现，看板是记录的投影，不是操作台。

VK 的需求因此分成两类：

- **Lingtai 天然覆盖的**：本地运行、issue 驱动、自动循环自我验证、依赖链、worktree 和分支的自动清理。这些在 VK 里是"请加上"，在 Lingtai 里是架构本身。VK 用户反复要的"让 AI 自己测、自己改、直到通过"（[VK#1946](https://github.com/BloopAI/vibe-kanban/issues/1946)），正是 Lingtai 的 build → review → 修改轮次。
- **Lingtai 有意不做或还没做的**：拖拽看板、和运行中的 agent 实时对话、检查点撤销。前两项和"无人值守 + 每步留证据"的方向有张力，不建议为了接 VK 用户去补。

## 建议

如果目标是接住 VK 停更后流出的用户，按收益排序：

1. **加更多 agent，优先做一个通用的 ACP 适配**（[VK#2365](https://github.com/BloopAI/vibe-kanban/issues/2365)）。一个适配器就能覆盖 Kiro、goose、Kimi、OpenCode 等一大串需求，总票数最高。难点是 Lingtai 要求运行时能禁用工具，做不到的会报 `ToolsCannotBeDenied`（`packages/agent/src/runtimes.ts:123`），新运行时都得过这一关；[0106](../decisions/0106-a-role-keeps-its-powers-across-runtimes.md) 规定一个角色换了运行时也要保持同样的权限。
2. **让本地数据库里的任务也能设依赖**。现在依赖链只在 GitHub 项目里有效（`db-tickets.ts:28`），而本地项目正是 VK 流出用户最需要的场景。
3. **GitLab / 普通 git 远程**：先验证并写清楚"GitLab 当普通 remote + 本地任务"这条路能不能走通，再考虑完整支持 GitLab。
4. **Docker 镜像**：成本低，VK 用户点名要过。
5. **从 VK 迁移的指南或导入工具**：[VK#3396](https://github.com/BloopAI/vibe-kanban/issues/3396) 的用户手上有导出的数据，在找地方去。

不建议跟进的：拖拽看板、项目级聊天、检查点撤销。它们服务的是"人在前面操作"的用法，和 Lingtai"人只在被问到时出现"的定位相反。

## 相关

- [market-opportunities.md](market-opportunities.md)：2026-09-03 的市场研究。它的结论是"更多模型、更多入口、更漂亮的任务板"会让 Lingtai 变成功能更少的同类品。本文建议的第 1 项（更多 agent）和那条判断有张力：这里的理由是 VK 用户的明确需求，而不是追赶同类品，两者应一起权衡。
