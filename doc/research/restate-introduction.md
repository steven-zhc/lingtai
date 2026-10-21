# Restate：面向持久执行的应用运行时

> 调研日期：2026-10-21
> 资料范围：仅使用 Restate 官方网站、官方文档、官方 GitHub，以及用于概念对照的 Temporal 官方文档。

## 一句话结论

**Restate 不是一个“画 DAG 的工作流编排器”，也不只是任务队列；它是在应用与调用方之间加入一个持久化运行时，把普通异步代码中的步骤、调用、状态、计时器和外部输入记录下来，使代码在进程崩溃后能够重放并继续。**

它特别适合：跨服务业务流程、按实体串行的状态机、长时间等待人工输入的流程、需要恢复能力的 AI agent，以及事件处理。官方把它描述为位于服务前面的、类似 reverse proxy 或 message broker 的 Restate Server；业务代码仍运行在自己的服务进程里，并通过 SDK 与 Server 协作（[Key Concepts](https://docs.restate.dev/foundations/key-concepts)）。

对灵台而言，Restate 的行为能力很匹配——循环、持久等待、人工输入、按 pass ID 串行、崩溃恢复都能表达——但它不能作为一个“透明 library”叠在现有 conductor 下面。Restate 自己的 durable log/journal 必须成为恢复依据，这会与灵台“append-only event log 是唯一真相”的原则发生直接重叠。

---

## 1. 它解决什么问题

假设有一段付款流程：

```ts
const payment = await chargeCard(order);
await reserveInventory(order);
await sendReceipt(order, payment);
```

普通进程若在第二步以后崩溃，重启者通常不知道：

- 第一、二步究竟成功没有；
- 哪一步可以安全重试；
- 是否会重复扣款；
- 一个等待数小时的人工作业应该如何恢复；
- 原来的 timer、callback 和跨服务调用由谁继续追踪。

传统做法会逐渐堆出 job table、retry worker、幂等键、outbox、状态机、定时任务和人工恢复工具。Restate 的目标，是把这些恢复机制收进统一运行时，让业务逻辑仍然写成顺序的 `async/await` 代码。

它的核心不是“代码只执行一次”，而是：

1. 请求先被持久化，为 invocation 建立 journal；
2. SDK 执行业务 handler；
3. 每次使用 Restate Context 的操作都写入 journal；
4. 进程失败后，handler 从头重放；
5. 已有 journal 结果的操作被跳过，并直接返回之前的结果；
6. 从尚未完成的操作继续。

这是官方 [Request Lifecycle](https://docs.restate.dev/guides/request-lifecycle) 描述的恢复模型。可以把它理解成：

```text
请求
  │
  ▼
Restate Server ──持久化──► durable log / invocation journal
  │                                   │
  │ 调用 handler                      │ crash 后提供历史
  ▼                                   ▼
你的 TypeScript 服务 ◄────────── replay / resume
  │
  └── DB、HTTP、Git、LLM、其他 Restate service
```

注意，Restate 恢复的是**由 journal 描述的控制流进度**，不是任意进程内存、子进程或本地文件系统的快照。

---

## 2. Durable execution 如何工作

### 2.1 Journal 是 invocation 的恢复记录

Restate 会记录 invocation 中的 Restate 操作及其结果，包括 service call、state update、timer、signal 等。失败重放时，SDK 依次把代码产生的操作与 journal 对齐：已有结果就复用，没有结果才真正执行（[Key Concepts](https://docs.restate.dev/foundations/key-concepts)、[Request Lifecycle](https://docs.restate.dev/guides/request-lifecycle)）。

因此代码可以包含普通的条件和循环；它不要求把流程画成 DAG。循环每轮产生的 durable operations 都会进入 journal。

### 2.2 非确定性操作必须经过 Context

HTTP、数据库、LLM、随机数和时间都会在重放时产生不同结果。外部 I/O 要用 `ctx.run` 包住，Restate 才会记录结果：

```ts
const review = await ctx.run("review-round-3", () => callReviewer(diff));
const id = ctx.rand.uuidv4();
const now = await ctx.date.now();
```

Restate 还提供可重放的 UUID、随机数和时间。`ctx.run` 内不能再调用 `ctx.get`、`ctx.sleep` 或嵌套的 `ctx.run`（[Durable Steps](https://docs.restate.dev/develop/ts/durable-steps)）。

### 2.3 恢复依赖操作序列稳定

重放时，新代码应产生与 journal 兼容的 Restate 操作序列。若顺序或分支发生不兼容变化，会产生 journal mismatch；可以配置为 retry、pause 或 fail（[Error Handling](https://docs.restate.dev/develop/ts/error-handling)）。

Restate 用 immutable deployment 处理版本：新 invocation 路由到新部署，已有 invocation 继续使用原来的部署直至完成（[Services](https://docs.restate.dev/foundations/services)）。这也意味着一个休眠数月的 invocation 可能要求旧版本继续可用；官方因此建议长期调度优先使用 delayed message，而不是让一个 handler 长期 sleep（[Scheduling & Timers](https://docs.restate.dev/develop/ts/durable-timers)）。

### 2.4 Retry 默认很积极

普通异常默认会无限重试并指数退避；明确不可恢复的业务错误应使用 `TerminalError`，需要运维修复后再继续的情况可以 pause invocation（[Error Handling](https://docs.restate.dev/develop/ts/error-handling)）。因此“失败”必须分类：

- **transient error**：重试；
- **terminal business outcome**：停止并向调用方返回失败；
- **operator intervention**：暂停，修复后 resume；
- **业务循环中的拒绝**：应建模为正常数据/分支，不能简单等同于异常 retry。

这一点与灵台的 typed refusal 很相似：review 拒绝并不是基础设施异常。

---

## 3. 三种服务抽象

Restate 提供的不是一种万能 workflow，而是三种具有不同并发与状态语义的服务（[Services](https://docs.restate.dev/foundations/services)）：

| 抽象 | 身份与并发 | 状态 | 适合场景 |
|---|---|---|---|
| **Basic Service** | 每次请求独立，可高并发 | 无共享 Restate state | API、后台任务、ETL、saga、并行任务 |
| **Virtual Object** | 每个 object key 最多一个写 handler；不同 key 并发 | 每个 key 独立、长期保留的 K/V | 账户、购物车、agent session、状态机、按 key 事件处理 |
| **Workflow** | 每个 workflow ID 的 `run` 只启动一次；shared handler 可并发交互 | 每个 workflow 实例独立，受 retention 限制 | 审批、onboarding、长业务流程、复杂编排 |

### Basic Service

它最接近“durable function”：没有共享状态，只让一次 handler 调用具备 journal、retry、durable call 等能力。

### Virtual Object

它像一个按 key 寻址的 durable actor。例如 `ProjectPass/{passId}`：

- 同一 `passId` 的写操作串行；
- 不同 pass 可并行；
- read-only shared handler 可并发；
- K/V state 与执行 journal 使用同一套 Restate durability。

这非常适合“每个实体只能有一个 writer”的状态机，但有一个容易踩的坑：exclusive handler 之间形成同步调用环时可能死锁；官方明确列出 `A → B → A` 和更长 cycle 的风险（[Service Communication](https://docs.restate.dev/develop/ts/service-communication)）。在 exclusive Virtual Object handler 内长期等待，也会让同 key 的其他调用排队。

### Workflow

Workflow 适合“一次业务实例”。`run` 按 workflow ID 只执行一个逻辑实例，其他 shared handlers 可以查询状态、提交人工决定或 resolve workflow promise。

“只执行一次”需要正确理解：它保证一个 workflow ID 不会启动两个独立的逻辑 workflow；并不自动保证所有外部 HTTP/数据库/Git 副作用在物理世界里绝不重复。

---

## 4. 关键原语

### 4.1 持久状态

Virtual Object 和 Workflow 可以使用内置 K/V state。Virtual Object state 按 object key 隔离并一直保留；Workflow state 按 workflow ID 隔离，并在 retention 期内保留（[State](https://docs.restate.dev/develop/ts/state)）。

官方同时说明它不是通用关系数据库：主要是 K/V 与单 key 事务，不支持用 SQL 做业务写入，修改必须通过相应 Virtual Object；复杂查询、全文检索和核心共享业务数据仍适合放数据库（[Databases and Restate](https://docs.restate.dev/guides/databases)）。

### 4.2 持久调用与消息

服务之间支持：

- request-response call；
- one-way message；
- delayed message；
- idempotency key；
- 对同一 Virtual Object key 的顺序处理。

这些调用经过 Restate，而不是服务之间直接调用，因此能与 caller journal 建立端到端的可恢复关系（[Service Communication](https://docs.restate.dev/develop/ts/service-communication)、[Request Lifecycle](https://docs.restate.dev/guides/request-lifecycle)）。

### 4.3 持久 timer

`ctx.sleep`、delayed message 和 timeout 都由 Restate 管理；进程重启不会让计时器从头开始。官方例子是睡眠 12 小时、8 小时后失败，恢复时只再等待剩余 4 小时（[Scheduling & Timers](https://docs.restate.dev/develop/ts/durable-timers)）。

### 4.4 外部输入与人工等待

TypeScript SDK 提供三种 durable coordination primitive（[Signals and external events](https://docs.restate.dev/develop/ts/external-events)）：

| 原语 | 定位方式 | 次数 | 典型用途 |
|---|---|---:|---|
| **Signal** | invocation ID + signal name | 可重复；每次 await 取下一个值 | agent steering、连续人工指令、运行中控制 |
| **Awakeable** | 自动生成的 token/ID | 一次 | 外部 callback、task token |
| **Workflow promise** | workflow key + promise name | resolve/reject 一次，可多次读取结果 | 同一 workflow 的 handler 间协调、审批结果 |

三者都跨 retry 与进程重启；没有其他工作时 invocation 可以 suspend，等输入到达再恢复。

下面是一个简化的“循环修复，预算耗尽后等待人工决定”：

```ts
const passWorkflow = restate.workflow({
  name: "PassWorkflow",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: PassInput) => {
      for (let round = 0; round < input.maxRounds; round++) {
        const result = await ctx.run(`agent-round-${round}`, () =>
          runAgent(input.workItem, round),
        );

        const verdict = await ctx.run(`review-round-${round}`, () =>
          review(result),
        );

        if (verdict === "pass") return { outcome: "passed" };
      }

      return await ctx.promise<HumanDecision>("human-decision");
    },

    decide: async (
      ctx: restate.WorkflowSharedContext,
      decision: HumanDecision,
    ) => {
      await ctx.promise<HumanDecision>("human-decision").resolve(decision);
    },
  },
});
```

这段代码可以有环，也可以等待数天；恢复时已完成 round 的 `ctx.run` 结果不会因为 handler 重放而重新计算。但真正的 agent/Git 副作用仍需要下面一节的安全设计。

---

## 5. “Exactly once”的真实边界

Restate 官方文档会使用 exactly-once 描述 invocation、workflow ID 和由 Restate 负责的通信。对工程选型而言，需要把边界说得更精确：

### Restate 能直接约束的部分

- invocation、journal entry、Restate state update、timer、signal；
- Restate service 之间的 durable call/message；
- 带 idempotency key 的请求去重；
- Workflow `run` 按 ID 的单一逻辑执行；
- Virtual Object 按 key 的 single-writer/linearizable state 语义。

### Restate 不能单方面原子化的部分

`ctx.run` 里的外部副作用和“把其成功结果写进 Restate journal”分属两个系统。存在很小但真实的窗口：数据库/Git/API 已成功，服务却在 Restate 记录完成之前失联，于是该 `ctx.run` 可能重试。

Restate 官方数据库指南明确演示了这个重复窗口，并用以下方式获得真正的外部 exactly-once 效果（[Databases and Restate](https://docs.restate.dev/guides/databases)）：

- 外部 API 接收幂等键；
- conditional update / version fencing；
- 在数据库事务里保存 idempotency token；
- 必要时使用 2PC；
- 把可重复操作设计成幂等操作。

因此，`ctx.run(() => gitPush())` 不等于“Git push 永远只发生一次”。应让 Git 操作以 expected SHA、branch head、commit ID 等条件变成可判定、可 reconcile 的效果。

---

## 6. 部署与运行形态

应用服务和 Restate 环境是分开的：服务可以运行在 container、VM、Kubernetes、AWS Lambda、Cloud Run、Vercel、Cloudflare Workers 等平台；Restate 环境负责 durable log、调度、journal、state 和 timer（[Key Concepts](https://docs.restate.dev/foundations/key-concepts)、[Hosting](https://docs.restate.dev/hosting/overview)）。

可选择：

- **Restate Cloud**：托管环境；
- **Restate BYOC**：Restate 运维，但运行在自己的 cloud account/VPC；
- **Self-hosted**：自己承担扩容、升级、备份、安全和监控。

本地开发很轻：Server 是一个无外部依赖的自包含 binary，可通过 Homebrew、npm、Docker 或直接下载启动，并自带 UI（[Installation](https://docs.restate.dev/installation)）。生产 self-host 并不等于“无状态”：

- 单节点需要 persistent volume；磁盘的 durability 就是系统的 durability；
- 集群需要 replicated log，并用 object store 保存 snapshot；
- 多节点的日志条目经 quorum 提交；
- RocksDB 保存 journal、idempotency metadata、key state 与 timer index 的 materialized cache，可从 log/snapshot 重建。

官方架构把 replicated durable log 明确称为 ground truth，RocksDB 是派生缓存而非第二真相（[Architecture](https://docs.restate.dev/references/architecture)、[Self-hosted Overview](https://docs.restate.dev/server/overview)）。

官方当前列出的 SDK 语言包括 TypeScript、Java/Kotlin、Python、Go、Rust 和 Ruby；TypeScript SDK 仓库采用 MIT License（[Key Concepts](https://docs.restate.dev/foundations/key-concepts)、[TypeScript SDK](https://github.com/restatedev/sdk-typescript)）。

---

## 7. 与任务队列、Temporal 的直觉比较

| | 普通任务队列 | Restate | Temporal |
|---|---|---|---|
| 核心单位 | job/message | durable service invocation、keyed object、workflow | workflow execution + activity |
| 恢复粒度 | 通常整 job 重试 | journal 中的 context operation | event history 中的 workflow command/activity |
| 长期状态 | 应用自己保存 | 内置 keyed K/V，尤其 Virtual Object | 通常由 workflow history/search attributes/外部 DB 配合 |
| 人工输入 | 自建 correlation + 状态表 | signal、awakeable、workflow promise | Signal/Update |
| keyed concurrency | 通常需自己设计 | Virtual Object 原生 single writer per key | 可由 Workflow ID 建模 |
| 本地启动 | broker/DB 取决于队列 | 单 binary 可启动 | 开发服务器可启动，生产是独立平台 |

最重要的直觉是：

- **队列保证“工作会再次被领取”，Restate 试图保证“程序从已确认的那一步继续”。**
- **Restate 和 Temporal 属于同一 durable-execution 大类。** Temporal 把 deterministic Workflow 与有副作用的 Activity 区分得更显式；Restate 用普通 service handler 加 `ctx.run`/context actions 表达边界，并额外提供 Virtual Object 的 keyed state/single-writer 模型。Temporal 的基本恢复模型见其官方 [What is Temporal](https://docs.temporal.io/temporal)。
- Restate 的 single-binary 起步体验更接近应用基础设施，但上生产后它依然是一个需要持久化、备份、升级和监控的有状态系统。

---

## 8. 适合与不适合的场景

### 适合

- 支付、订单、开户、审批等跨系统多步流程；
- 等待小时、天甚至更久的 callback/HITL；
- 需要按 customer/order/session key 串行更新的状态实体；
- agent 的 LLM 调用、工具调用、路由决定和人工批准需要 crash recovery；
- 至少一次消息来源上的幂等事件处理；
- 团队愿意把 Restate durable log 视为执行事实，并接受它的部署与版本模型。

### 不适合，或要谨慎

- 只是几个短小、天然幂等的后台 job；队列已经足够；
- 需要任意 SQL、复杂查询或跨实体大事务；Restate K/V 不是关系数据库；
- 外部副作用无法加幂等键、版本 fence 或 reconcile；
- 需要随意热改长流程代码，却不愿保留旧 deployment 或处理 journal mismatch；
- 本地文件、子进程或硬件资源无法在恢复节点重建/重新定位；
- 系统已经有一套不可替换的 authoritative execution log，且不能容忍第二套 journal。

---

## 9. 对灵台的具体含义

Restate 与灵台在形态上高度相似：两者都是 log-first，materialized state 可从日志恢复；两者都强调 durable state、可观察的决策和单 writer。Restate 的架构文档甚至明确使用“durable log 是 ground truth，RocksDB 是 derivative”的表述（[Architecture](https://docs.restate.dev/references/architecture)）。

但“相似”不代表能无代价叠加。

### 9.1 最大冲突：两套真相

灵台规定自己的 append-only event log 是唯一真相；Restate 要兑现恢复保证，则 Restate durable log/journal 必须记录更细的 invocation progress、step result、signal、timer 和 state update。

若两者并存：

```text
Lingtai event log        Restate durable log
        │                         │
        └──── 谁决定下一步？ ─────┘
```

一次 crash 可能发生在两边写入之间。除非建立额外的原子提交或严格的单向派生关系，否则会出现：灵台认为步骤未完成，Restate 已跳过；或灵台认为完成，Restate 仍要重试。

真正采用 Restate core，需要明确改成：

```text
Restate durable log = 执行恢复的权威
          │
          └──► Lingtai domain/audit events = 可查询的领域投影或可靠订阅输出
```

这不是加一个 library，而是修改 source-of-truth 设计。

### 9.2 Worktree 不在 journal 里

Restate 可以把 invocation 重新送到另一个兼容 service instance；它不会复制某台机器上的 Git worktree，也不会恢复原 agent 子进程。

灵台若用 Restate，需要额外设计：

- 用 repository + base SHA + patch/commit 重建 workspace；或
- 按 project/pass 把 invocation 固定到持有 worktree 的 endpoint；
- 把 worktree locator、lease、expected HEAD 写入 durable state；
- 所有 Git 操作按 SHA/branch condition 幂等并可 reconcile；
- agent 进程失败后，是续接 session、重新启动 round，还是 terminal outcome。

否则 Restate 只能恢复“应该调用 agent”，不能恢复“原 agent 正站在哪个 worktree 里”。

### 9.3 最合理的验证方式

如果未来灵台明确需要多进程/多机器接管、海量并发 pass 或长时间 durable signal，可以做一个隔离 POC：

1. 一个 Workflow 对应一个 pass ID；
2. round/restart 是正常 workflow 分支，不使用基础设施 retry 表示；
3. human decision 使用 signal 或 workflow promise；
4. Git/agent/plugin 都通过可幂等、带 expected SHA 的 `ctx.run` adapter；
5. 故意在每个外部副作用前后 kill service/server；
6. 验证 worktree、event log、journal 三者能否一致恢复；
7. 最后必须选择谁是唯一执行权威，不能以“双写以后再说”收尾。

**当前判断：Restate 是灵台若要重建为分布式 durable runtime 时很值得优先验证的方案；在现有单机、event-log-authoritative 架构中，它更像替代 conductor/event-store 职责的候选，而不是可直接塞进某个 adapter 的小型 library。**
