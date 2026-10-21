# 适合灵台的工作流框架与库

> 调研日期：2026-10-20  
> 范围：只使用项目官方文档、官方代码仓库和仓库内 ADR；不以营销对比文章或第三方评测作为依据。

## 结论

**在灵台现有约束不变的前提下，不建议用任何完整工作流平台替换 conductor。**

原因不是这些平台不能表达循环。Temporal、Restate、DBOS、LangGraph 和 XState 都能表达循环；Restate 甚至有官方的“生成—评估—带反馈重试”示例。真正的冲突是：完整的 durable-execution 平台都需要自己的 history、journal 或 checkpoint 作为恢复依据，而灵台已经明确规定自己的 append-only event log 是唯一真相。若两套记录都不可丢，系统会出现两个执行权威；若平台记录可丢，平台也无法兑现其恢复保证。

当前最合理的选择是：

1. **继续保留定制 conductor、事件日志和插件 seam。** 灵台的固定十步、typed refusal、round/restart 预算、SHA 绑定和 worktree 生命周期已经是领域模型，不是通用工作流样板代码。
2. **若想让状态转换更显式，可小范围试验 XState v5，但只把它当纯 transition/可视化/模型测试库。** 事件仍先写灵台日志，projection 仍从灵台事件重建；不要启用 XState snapshot 作为另一个权威状态。
3. **暂不采用 Emmett。** 它的 event-sourced `decide/evolve` 模型与灵台最接近，并同时提供 SQLite/Postgres backend，但替换现有 event store 的收益有限；更重要的是，其仓库目前明确没有正式 license，workflow 文档也标注为由生成式 AI 辅助撰写且仍在核验。
4. **把 Restate 作为“如果未来有意识地重建核心”的首选 POC。** 它在 TypeScript、循环、durable signal、人工审批和单机部署上最接近灵台。采用它意味着明确推翻“灵台 event log 是唯一执行真相”，并重新设计本地存储、worktree 亲和性和插件事务边界。
5. **Temporal、DBOS 和 LangGraph 不作为当前核心依赖。** Temporal 更适合已有平台团队的分布式长流程；DBOS 是较轻的 Postgres-only durable execution；LangGraph 适合 agent 内部推理图，而不是 repository lifecycle 的最终权威。

简化成一句话：

> **现在选“无框架 + 可选 XState 建模”；将来若愿意更换系统真相，优先验证 Restate。**

---

## 1. 灵台究竟需要什么

框架不能只按“支持循环”“支持重试”筛选。灵台当前的不可忽略约束是：

- **TypeScript/Node 单仓库，并已使用 Effect。** 当前 ADR 固定 TypeScript、Node `>=26`、源码直接运行；Effect 只出现在 ports 及其外侧，而不是吞掉领域核心（[ADR 0101](../decisions/0101-typescript-packages-effect-unbuilt.md)）。
- **append-only event log 是唯一真相。** 状态、历史和 telemetry 都必须能从同一事件流恢复；其他表只是 projection，外部行为来自 subscriber（[ADR 0100](../decisions/0100-one-append-only-log.md)）。存储必须同时支持本地 SQLite 和显式选择的 Postgres。
- **流程有环，但不是任意图。** 一个 pass 固定十步，只有四步可以 refuse，只有 `proposed` 可以路由，且 workflow 先计算合法目的地，judge 只能在集合中选择（[ADR 0103](../decisions/0103-a-pass-is-ten-fixed-steps.md)）。
- **循环有领域预算。** refusal 回到同一 worktree 的 `implement` 消耗 round；只有特定 judgement 才允许从 base restart；上限耗尽后交给人（[ADR 0108](../decisions/0108-a-refusal-buys-a-round.md)）。这不是“任务异常后重试 N 次”。
- **worktree 是一次 pass 的资源边界。** 从创建到 merge lane 都要保留；fix round 必须继续使用它，而 restart 才建立新的 attempt/worktree（[ADR 0108](../decisions/0108-a-refusal-buys-a-round.md)）。
- **人工等待是持久领域状态。** `waiting` 不是一个步骤；每次等待都要携带可行动的 typed reason（[ADR 0118](../decisions/0118-a-hold-explains-itself.md)）。
- **一台机器上只有一个 conductor。** daemon 持有 pass、agent process、worktree 和 file lock；控制命令通过日志进入（[ADR 0102](../decisions/0102-one-conductor-holds-the-lock.md)）。
- **扩展面是 plugin，不是开放拓扑。** 插件给出 verdict/effect，但核心决定 verdict 的后果，且大结果通过 locator 传递（[ADR 0105](../decisions/0105-a-plugin-is-a-declaration-and-an-implementation.md)）。

因此，候选方案必须分别回答三个问题：

1. 它能否表达灵台状态机？
2. 它会不会建立第二个恢复真相？
3. 它恢复后能否重新找到**同一个本地 worktree 和正确的外部副作用边界**？

第二、第三问比第一问更重要。

---

## 2. 快速比较

评分是针对“保持灵台现有约束”的适合度，而不是产品质量。

| 候选 | 循环 | durable recovery | Signal / HITL | 持久化权威 | 本地运维 | 同 worktree 适配 | 当前适合度 |
|---|---|---|---|---|---|---|---|
| **现有 conductor** | 原生领域循环 | 事件回放 + reconcile | 原生 typed wait | 灵台 event log | SQLite 单机 / Postgres | 原生 | **最高** |
| **XState v5** | 原生 statechart | 需宿主自己持久化 | 事件可表达，durability 自建 | 可继续使用灵台日志 | 纯库，无服务 | 好 | **可选建模层** |
| **Emmett** | event-sourced workflow | stream replay | 通过 input event 建模 | 可与 event log 合一 | SQLite / Postgres 库 | 好 | **理论匹配，暂缓** |
| **Restate TS** | 普通代码循环 | journal replay | signal / awakeable / workflow promise | Restate durable log | 单 binary + 持久卷 | 需额外亲和设计 | **重建核心时首选 POC** |
| **DBOS TS** | 普通代码循环 | step checkpoint | send/recv/event/sleep | DBOS system DB | 应用 + Postgres | 需额外亲和设计 | Postgres-only 备选 |
| **Temporal TS** | 普通代码循环 | Event History replay | Signal / Update / Query | Temporal History | dev 单 binary；生产平台较重 | 需 worker/workspace 亲和设计 | 未来平台化备选 |
| **LangGraph JS** | 原生循环图 | graph checkpoints | interrupt/resume | LangGraph checkpointer | 库；SQLite/Postgres saver | 单机可做但节点会重跑 | agent 内部适合，core 不适合 |
| **KurrentDB** | 不负责 | 事件存储可靠 | 订阅，不是 HITL runtime | KurrentDB log | 独立数据库服务 | 中性 | 仅存储替换，不解决 conductor |
| **BullMQ** | job retry/树，不是领域环 | Redis job state | 需自建 | Redis queue state | Redis 服务 | worker 漂移风险 | 只适合作为未来派发层 |

“支持循环”一列几乎全是肯定，说明它没有区分力；**source of truth 和 worktree affinity 才是淘汰项。**

---

## 3. Library-only 方案

### 3.1 XState v5：最安全的可选增量，但不要让 actor snapshot 成为真相

XState 是 JavaScript/TypeScript state machine、statechart 和 actor 库；v5 要求 TypeScript 5.0+（[官方 quick start](https://stately.ai/docs/quick-start)）。它支持普通 transition、自循环和 re-entering self-transition（[transitions](https://stately.ai/docs/transitions)），所以表达 `proposed → implement → build → review → proposed` 没有问题。

它对灵台的真正价值不是 durable execution，而是：

- 把合法状态与 transition 集合集中成可检查的机器定义；
- 用 guards 表达 round/restart ceiling；
- 用纯 `transition(machine, state, event)` 跑模型测试；
- 生成状态图，检查 unreachable state 和意外回边。

但 XState 自己的持久化是 actor snapshot：`getPersistedSnapshot()` 后由宿主写入 storage，再用 snapshot 恢复。官方同时说明 snapshot 与机器版本可能不兼容、恢复时已执行 action 不会重跑；event sourcing 只是通过 inspection API 收集并重放输入事件的一种可选做法（[persistence](https://stately.ai/docs/persistence)）。也就是说，XState v5 不是开箱即用的 durable workflow server。

**适合灵台的用法：**

```text
lingtai events ──fold──► domain state
                         │
                         └── XState pure transition / guard
                                   │
                                   ▼
                              domain events to append
```

不要持久化 XState actor snapshot；不要把 entry/exit action 直接绑定到 git、agent 或 GitHub I/O。I/O 仍由现有 Effect ports 和 plugin actions 执行，结果先落灵台事件。这样 XState 是一个“合法转换计算器”，删除它后日志语义不变。

**限制：**灵台已经有 `nextOf`、`offerFor`、`routeNext`、typed ending 和大量 exhaustive tests。把它们改写成 statechart 可能只是换一种语法，并不会删除事件存储、恢复、插件、worktree 或 judge 代码。因此建议只做一个隔离 prototype：用当前事件序列重放验证 XState machine 是否给出完全相同的 next/offer；不能显著减少状态转换重复，就不引入。

**判断：可试验，不应承担 durability。迁移成本低到中，潜在收益中等。**

### 3.2 Emmett：概念上最贴近，产品成熟度与替换收益不足

Emmett 是 TypeScript/Node event-sourcing library。官方 repository 列出 Postgres、EventStoreDB、MongoDB、SQLite 和 memory stores、projections、command handling 与 TypeScript support（[官方仓库](https://github.com/event-driven-io/emmett)）。其 workflow 核心恰好是三个纯函数：`decide(input, state)`、`evolve(state, event)`、`initialState()`；每个 workflow stream 同时记录 inbox 和 outbox，恢复靠重放 stream（[workflow docs](https://event-driven-io.github.io/emmett/guides/workflows.html)）。这与灵台“事件为真、projection 可重建”的哲学最接近。

它还支持灵台需要的两种存储形态；官方选择指南把 SQLite 定位为 embedded/serverless，把 Postgres 定位为多数生产应用的推荐方案（[event store guide](https://event-driven-io.github.io/emmett/guides/choosing-event-store.html)）。

但仍不建议现在采用：

- 灵台已有经过领域约束强化的 append/read/subscribe、expected version、schema catalogue/upcaster、projection checkpoint 和双 store contract。Emmett 会替换大量已完成代码，而不是填补缺失能力。
- 它的 workflow 是消息决策/投递模式，不自动拥有本地 agent process、worktree scope、git merge lane 或插件 verdict 语义；这些仍需灵台实现。
- 官方 workflow 与 store-selection 页面明确标注由 GenAI 辅助生成、仍在核验，不能把文档承诺直接当作成熟保障（[workflow docs](https://event-driven-io.github.io/emmett/guides/workflows.html)）。
- 官方仓库 FAQ 当前明确写着“没有 license”，仅讨论未来可能采用 AGPLv3/SSPL/open-core。没有明确 license 时不应把它引入可分发产品（[官方仓库 FAQ](https://github.com/event-driven-io/emmett)）。

**判断：架构思想最相近，但现在不引入。等 license 明确、文档核验完成，并且现有 event-store 出现具体维护痛点后再评估。迁移成本高。**

### 3.3 KurrentDB（原 EventStoreDB）：优秀的 event database，不是 conductor

KurrentDB 是专用 immutable append-only event database，提供 streams、subscriptions、projections、optimistic concurrency 和官方 Node.js client；可 self-host，也可使用 managed cloud（[介绍](https://docs.kurrent.io/getting-started/introduction)、[功能列表](https://docs.kurrent.io/getting-started/features)、[Node client](https://docs.kurrent.io/clients/node/)）。

它可能替换灵台的 `event-store` package，但不会替代 pass loop、HITL、worktree lifecycle 或插件协议。它还会把默认单文件 SQLite 变成一个独立数据库服务；当前单节点免费、multi-node 需要 license（[server quick start](https://docs.kurrent.io/server/v26.2/quick-start/)）。

只有在出现以下证据后才值得考虑：

- 单机 SQLite/Postgres subscription 或 projection 吞吐成为实际瓶颈；
- 需要多个 competing subscriber、server-managed checkpoint/parking；
- 愿意放弃“安装后只有一个 SQLite 文件”的产品体验。

**判断：当前没有解决灵台尚未解决的问题。迁移成本高。**

---

## 4. Durable-execution 平台

这类平台的共同优势是：执行函数可以在 crash 后从已记录的 step/command 继续，timer 与外部输入也是 durable 的。共同代价是：平台自己的执行日志必须成为权威。

### 4.1 Restate TypeScript：最贴合灵台行为，但只能作为重建选择

Restate 提供 service、virtual object 和 workflow 三种抽象。Workflow 按 ID 执行一次，支持 concurrent signal/query；官方直接把 approval、onboarding 和 multi-step orchestration 列为用途（[services](https://docs.restate.dev/concepts/services/)）。

它对灵台的匹配度很高：

- 普通 `while`/`for` 可以形成有界循环；官方提供 evaluator feedback loop，每轮都 checkpoint，crash 后从上次完成的 evaluation 继续（[evaluation loop](https://docs.restate.dev/ai/patterns/workflow-evaluator)）。
- Signal 可重复接收，awakeable 是一次性外部 callback，workflow promise 可由同一 workflow 的 handler 完成；三者都跨 retry/process restart，并能在等待时 suspend（[TypeScript external events](https://docs.restate.dev/develop/ts/external-events)）。
- 外部 I/O 用 `ctx.run` 包裹，结果进入 execution log；随机数、UUID 与时间有 deterministic helper（[durable steps](https://docs.restate.dev/develop/ts/durable-steps)）。
- Self-hosted server 是单 binary；单节点使用本地持久卷，内部 durable log 是主要 durability 层，RocksDB materialized state 可以从 log 重建（[self-host overview](https://docs.restate.dev/server/overview)）。

但这些优点恰好揭示核心冲突：Restate journal 记录 invocation、step result、signal 和 state update，并靠它恢复。灵台日志若只记录一个较粗的 `StepPassed`，便无法独立恢复 Restate 尚未完成的细节；若把 Restate journal 的每个事实再镜像到灵台日志，就要解决跨两个 log 的原子性。两者不能同时自然地成为“唯一真相”。

另一个冲突是 worktree：Restate 可以把 invocation 恢复到服务的新 process/endpoint；本地 worktree 则属于某台机器和某次 pass。采用 Restate 必须新增 execution placement：按 project/pass 固定 endpoint，或把 workspace 改造成可重建/可挂载的 durable artifact。这是产品架构变化，不是 SDK 接入。

**什么时候选它：**未来明确需要多进程/多机器 failover、长时间 durable signals、大量并发 agent，并愿意让 Restate log 成为执行真相、灵台 log 降为 domain/audit projection 时。

**判断：若重建核心，Restate 是首选 POC；当前直接迁移不合适。迁移成本很高。**

### 4.2 DBOS TypeScript：实现简单，但 Postgres 与第二状态库是硬条件

DBOS 把普通 TypeScript function 注册为 workflow，把有副作用的函数包成 step。Workflow crash 后从最后完成 step 恢复；step 至少尝试一次，但完成后不再执行；transaction 只 commit 一次（[workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)）。

它也具备灵台需要的基础原语：background workflow、durable sleep、queue concurrency、workflow send/recv 与 event（[methods](https://docs.dbos.dev/typescript/reference/methods)、[queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)）。普通循环可以表达 rounds/restarts，人工决定可以通过 message/event 唤醒。

主要问题：

- DBOS 明确要求 Postgres system database，并把 workflow/step checkpoint 存在那里（[TypeScript programming guide](https://docs.dbos.dev/typescript/programming-guide)）。这直接取消 SQLite 默认。
- 长流程代码的 step 顺序变化可能使 recovery 失败；官方要求用 patch 或 application version 管理（[upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)）。
- system DB 是恢复权威，与灵台事件日志重复。
- 多 executor recovery 同样需要解决本地 worktree placement。官方说明单机 restart 会自动恢复 pending workflow；分布式环境则要用 executor ID 或 Conductor 管理 recovery（[workflow recovery](https://docs.dbos.dev/production/workflow-recovery)）。

相比 Restate，DBOS 的优势是 TypeScript 代码形态直接、Postgres 运维熟悉；劣势是灵台很重视的 repeated signal/HITL 和 agent patterns 不如 Restate 原生，且没有 SQLite 路线。

**判断：若团队接受 Postgres-only，并希望最小化平台组件，可作为 Restate 的备选。当前迁移成本高。**

### 4.3 Temporal TypeScript：能力最成熟，和“个人本机工具”的距离也最大

Temporal 的 workflow 是 durable function，Event History 记录每一步，Worker crash 或 Temporal Service outage 后通过 replay 恢复（[What is Temporal](https://docs.temporal.io/temporal)）。Workflow 能写循环；Signal 是异步写，Update 是同步且可等待结果的写，Query 是不写 history 的读取（[message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)），足以表达人工审批和运行中控制。

代价是严格 replay 模型：workflow code 必须 deterministic，数据库、HTTP、LLM 等非确定性操作必须放进 Activity；长生命周期 workflow 的代码变更要用 Worker Versioning 或 patching（[workflow definition](https://docs.temporal.io/workflow-definition)）。对灵台而言，git、agent process、hook、plugin、GitHub 的每个 I/O 都需要重新划分为 Activities，并设计 idempotency、heartbeat、cancellation 和 workspace locator。

本地开发并不重：`temporal server start-dev` 是无外部依赖的单 binary 并带 Web UI。但生产 self-host 需要 Temporal Service、database、visibility、升级与运维；官方 production checklist 也明确列出基础设施、升级、可用性和专业运维成本（[self-host guide](https://docs.temporal.io/self-hosted-guide)、[production checklist](https://docs.temporal.io/self-hosted-guide/production-checklist)）。

Temporal 最适合组织已经把它当公共基础设施，或者灵台要升级为跨节点、多租户、高可用平台的情形。为当前单机 daemon 单独引入，平台成本大于删除的代码。

**判断：未来 enterprise/platform 化备选，不适合当前产品。迁移成本最高。**

---

## 5. Agent-specific framework

### 5.1 LangGraph JS：图循环与 HITL 很自然，但它解决的是 agent graph

LangGraph JS 把 workflow 建成 state、nodes 和 edges；官方明确支持 looping stateful workflow（[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)）。Checkpointer 在每个 graph step 保存 thread state，用于恢复、time travel、fault tolerance；官方提供 Postgres saver，SQLite saver 定位为本地开发（[persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)）。

HITL 是其强项：`interrupt()` 保存 graph state、无限等待外部输入，并用同一 `thread_id` 和 `Command({ resume })` 恢复（[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)）。这与灵台 `waiting` 表面相似。

但语义差异很关键：

- LangGraph checkpoint 是 shared graph state snapshot，不是灵台的 domain event catalogue。
- Interrupt 恢复时节点从头执行，interrupt 前的代码会再次执行；官方要求相关 side effect 幂等（[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)）。灵台的 git/agent/plugin effects 不能未经重新设计就放进 node。
- Graph state、memory、time travel 面向 agent/conversation；灵台还要维护 commit SHA、claim、merge lane、worktree 与 GitHub external truth。
- 使用 LangGraph 后依旧需要灵台事件日志来回答“为什么没有 merge”，于是形成 checkpoint 与 audit log 双状态。

LangGraph 可以用在**某个 agent runtime 内部**：例如实现 design/review agent 的工具循环、人工 review tool call，最后通过现有 `AgentRuntime` 或 plugin seam 返回 typed verdict。它不应成为 pass lifecycle 的权威。

**判断：适合作为 agent adapter 内部实现，不适合 conductor。迁移 core 的成本高且收益低。**

---

## 6. Queue-only 对照：BullMQ 不能替代工作流语义

BullMQ 是 TypeScript/Node job queue。它提供 retry、delayed jobs、worker concurrency 和 parent/child Flow；Flow 是依赖树，parent 等待 children（[flows](https://docs.bullmq.io/guide/flows/)）。它依赖 Redis，官方也要求生产 Redis 使用 `noeviction`（[connections](https://docs.bullmq.io/guide/connections)）。

它可以在未来把“可运行的 plugin/agent job”分发给多个 worker，但不能决定：

- refusal 是否买 round；
- round 还是 restart；
- 哪些 route 合法；
- 人工回答绑定哪个 SHA；
- crash、red build 与 judgement failure 的区别。

此外，BullMQ 的 `QueueEvents` 使用 Redis Streams，但事件流默认会自动 trim 到约 10,000 条，显然不能充当灵台 append-only audit log（[events](https://docs.bullmq.io/guide/events/)）。分布式 worker 也会立刻触发 worktree locality 问题。

**判断：只有将来需要多 worker 派发时才放在 plugin seam 后面；永远不作为 conductor 或 event log。**

---

## 7. 与现有 Effect 栈的关系

灵台已经使用 Effect 3.22.x。Effect 现在也有 durable workflow/cluster 模块；官方 API 包含 typed Workflow、suspend/resume 和 DurableDeferred，但这些 API 在当前文档中仍标记为 `unstable`，并位于 Effect 4（[Workflow API](https://effect.website/docs/v4/api/effect/workflow/Workflow)、[DurableDeferred](https://effect.website/docs/v4/api/effect/workflow/DurableDeferred)）。

它在语法和依赖注入上可能最自然，但当前有三个阻断：

1. 灵台仍在 Effect 3，采纳会和一次大版本迁移绑定；
2. API 明确 unstable；
3. durable engine 仍然要拥有自己的 execution record，source-of-truth 问题没有消失。

**判断：列入观察清单，不做近期设计基础。** 等 Effect 4 workflow 稳定、存储契约明确后，再以同一套 invariants 重新评估。

---

## 8. 推荐路线

### 路线 A：保持当前产品原则（推荐）

```text
                    append / expectedVersion
commands ──► conductor ─────────────────────► Lingtai event log
                  │                                  │
                  │ Effect ports / plugins           ├──► projection / board
                  ▼                                  └──► subscribers
          git · agent · GitHub

可选：domain fold ─► XState pure transition（只计算，不持久化、不做 I/O）
```

具体行动：

1. 不迁移 durable platform。
2. 先把 crash recovery 的缺口写成 failure matrix：每个 I/O 前后 crash 时，日志是否足以 reconcile；这比框架选型更直接。
3. 若 transition 维护成本已真实出现，做一个最多 2—3 天的 XState spike，只覆盖 `StepOutcome → RouteOffer → next Step`，用现有 tests 做 equivalence oracle。
4. spike 的删除标准：若没有减少分支重复、没有生成更有用的图、或需要 XState snapshot 才能工作，就删除。
5. 外部昂贵执行系统继续从 plugin seam 接入，只返回 typed verdict + evidence + locator。

### 路线 B：未来需要分布式 durable execution

只有以下需求至少出现两项，才值得重开平台选择：

- conductor 必须在另一台机器自动接管 in-flight pass；
- 人工等待要持续数周且不能依赖当前 daemon；
- 多个 agent worker 需要水平扩展；
- durable timer/signal/outbox 的自研维护成本已高于平台运维；
- 愿意取消 SQLite 默认，并重新定义“唯一真相”。

届时建议按顺序做：

1. **Restate POC**：实现一个最小 `implement → evaluate → round → human signal`，验证 crash、signal-before-wait、版本升级和 endpoint 切换。
2. 把 worktree 变成显式 resource locator，并验证恢复到另一 process 后是否仍可安全操作；不能解决则停止。
3. 选择一个且只有一个权威：
   - Restate journal 是 execution truth，灵台 event log 是可重建 domain/audit projection；或
   - 放弃 Restate 的 recovery，只当普通 RPC，此时没有引入价值。
4. 与 **DBOS/Postgres** 做同场 crash test；只有已有 Temporal 平台团队时才把 **Temporal** 加入决赛。

不要尝试用 dual-write 把两个 log 都称为唯一真相。没有共同 transaction 时，这只是把 recovery bug 延后到最坏的故障窗口。

---

## 9. 最终选型表

| 目标 | 建议 |
|---|---|
| 保持当前本地优先、SQLite、单日志 | **继续定制 conductor** |
| 改善状态转换可读性、可视化、模型测试 | **隔离试验 XState v5 pure transition** |
| 减少 event-sourcing boilerplate | 关注 **Emmett**，但 license 明确前不采用 |
| 把某个 reviewer/designer 做成内部 agent graph | 在 agent adapter 内用 **LangGraph JS** |
| 未来重建为分布式、durable、signal-heavy 平台 | **先验证 Restate TS** |
| 接受 Postgres-only，偏好应用内 durable functions | **DBOS TS** |
| 组织已有成熟 Temporal 平台与运维团队 | **Temporal TS** |
| 仅需要跨进程 job queue | **BullMQ 放在 plugin 后** |
| 仅需要高吞吐专用 event database | 需求出现后再评估 **KurrentDB** |

最终建议不是“永远不用框架”，而是不要为了获得已经拥有的循环能力，引入一套会改变系统真相和资源边界的平台。灵台当前最稀缺的不是 generic durability primitive，而是把 **Git、agent、evidence、SHA、人工决定和有界成本**放进同一个可解释领域模型；这部分恰好是通用框架无法替它提供的。

