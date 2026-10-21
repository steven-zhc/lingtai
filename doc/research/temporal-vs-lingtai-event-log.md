# Temporal 与灵台 Event Log

> 调研日期：2026-10-21  
> 范围：Temporal 官方文档，以及灵台仓库内已经接受的 ADR。

## 结论

**Temporal 本质上也是 event-log 架构，但它记录的是“工作流执行历史”，并在日志之上交付了一套完整的分布式执行运行时。**

所以 Temporal 与灵台的区别不是：

> Temporal 可以跨机器、重试，event log 不可以。

而是：

> 灵台选择自己定义领域事件、fold、ownership 和 reconcile；Temporal 预先实现 Event History、确定性回放、任务派发、timer、signal、retry、worker 接管、版本路由和运维工具。

对当前灵台，**不建议把 Temporal 叠在现有 conductor 下面**。这会同时保留 Temporal Event History 和灵台 event log 两个恢复依据，并且仍然解决不了本地 worktree 的迁移。只有当灵台要变成大规模、多租户、跨节点的平台，而且团队希望购买现成的调度、接管和运维能力时，Temporal 才值得作为“替换 conductor 执行核心”的候选。

---

## 1. Temporal 怎样工作

Temporal Platform 由两部分组成：Temporal Service（server + persistence database）和运行用户代码的 Worker Process；可以使用 Temporal Cloud，也可以 self-host（[What is Temporal](https://docs.temporal.io/temporal)、[Persistence](https://docs.temporal.io/temporal-service/persistence)）。

```text
Client
  │ start / signal / update / query
  ▼
Temporal Service + persistence
  ├── Event History
  ├── Task Queues
  ├── durable timers / retries
  └── visibility
          │ poll
          ▼
Workers on machine A / B / C
  ├── Workflow code: deterministic decisions
  └── Activity code: Git / HTTP / DB / agent / filesystem
```

### Workflow 与 Activity

- **Workflow** 是确定性的协调代码，可以使用普通条件、循环和等待，但不能直接依赖网络、数据库、文件系统、真实时钟或随机值。
- **Activity** 承担外部 I/O 和非确定性工作，例如 Git、LLM、HTTP、数据库或文件操作。Activity 的结果会写入 Workflow Event History，之后 replay 直接复用结果，不会因为 replay 再执行已经完成的 Activity（[Workflows and replay](https://docs.temporal.io/workflows)）。

当 Workflow Task 被 Worker 取走时，Worker 从头执行 Workflow 代码，并按 Event History 重建内存状态；到达 history 尚未覆盖的位置后，才产生新的 Command。Worker 崩溃时，另一台机器上的 Worker 可以取得后续 Task、重放同一 history 并继续（[Tasks](https://docs.temporal.io/tasks)、[Event History](https://docs.temporal.io/encyclopedia/event-history)）。

这不是内存快照，而是：

```text
Event History + 相同 Workflow 代码
              ↓ replay
        恢复 Workflow 内存状态
              ↓
        产生下一个 Command
```

### Task Queue 与跨机器执行

Temporal Service 把 Workflow Task 和 Activity Task 放入 Task Queue，Worker 通过长轮询取得工作。多个 Worker 可以轮询同一个队列，因而可以横向扩展和在某个 Worker 消失后继续处理；队列也可以按 workload 分开部署（[Tasks](https://docs.temporal.io/tasks)、[Worker performance](https://docs.temporal.io/develop/worker-performance)）。

Task Queue 解决的是**代码与执行容量的路由**，不是本地文件资源复制。另一个 Worker 能接管 Workflow，不代表它自动拥有前一台机器的 worktree。

### 外部交互

Temporal 把运行中的 Workflow 当成有状态服务：

- **Signal**：异步写入，不等待业务结果；
- **Update**：有响应、可追踪的同步写入；
- **Query**：只读当前 Workflow 状态，不写 Event History。

它们适合人工审批、暂停/恢复、补充输入和读取状态（[Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)、[TypeScript message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing)）。Timer、Activity 完成、Signal、Update 和子 Workflow 完成都会触发新的 Workflow Task；timer 本身由 Temporal 持久化，不要求 Worker 在等待期间一直存活（[Tasks](https://docs.temporal.io/tasks)）。

### 长历史与升级

Event History 会增长。`Continue-As-New` 结束当前 run，在相同 Workflow ID 下创建新 Run ID 和一份新的 Event History，并由应用把当前状态传给新 run（[TypeScript Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new)）。

因为 replay 要求相同 history 产生相同 Command，Workflow 代码必须 deterministic；改变控制流可能让旧 history 与新代码不匹配。Temporal 推荐 Worker Versioning，把运行中的 Workflow 绑定到兼容代码版本；不能使用它时才考虑 patching（[Workflow Definition](https://docs.temporal.io/workflow-definition)、[Worker deployment](https://docs.temporal.io/best-practices/worker)）。

### Activity 不是外部 exactly-once

已经记录为 completed 的 Activity 在 replay 时不会重做，但一个 Activity 可能已经完成外部副作用、却在 Worker 把结果交给 Temporal 前崩溃。此时 Temporal 看不到完成事件，会重试 Activity。因此 Git push、GitHub mutation、付款或 LLM 调用仍应使用 idempotency key、expected SHA/version 或查询后 reconcile。Temporal 官方示例也明确说明 Activity 可以执行多次，并要求有副作用的操作幂等（[Temporal MCP integration](https://docs.temporal.io/develop/python/integrations/mcp)、[Agent memory and state](https://docs.temporal.io/ai/featured/memory-state-stripe)）。

---

## 2. Temporal Event History 和灵台 event log 的差别

二者都是 append-only log，也都可以跨机器；差别在日志的语言和谁负责解释它。

| | Temporal Event History | 灵台 event log |
|---|---|---|
| 主要内容 | Workflow/Activity 被调度、完成、失败，timer、signal、command | `StepPassed`、`FixRequested`、`PassRestarted` 等领域事实 |
| 重建目标 | 重新执行 Workflow 代码，恢复控制流和内存状态 | fold 领域状态，重建所有 projection，并决定下一动作 |
| 外部 I/O | 必须放入 Activity | plugin/port 执行，结果追加领域事件 |
| 并发/派发 | Service、Task Queue、Worker 协议内建 | expected stream version；ownership/lease/waker 由灵台定义 |
| 代码升级 | deterministic replay + Worker Versioning/patching | event schema version、upcaster、新 fold 解释旧事件 |
| 长日志 | Continue-As-New 切出新 history | 当前保留完整领域流，projection 可重建 |

Temporal 官方也把 Event History 定义为 Workflow Execution 的完整、持久日志和 replay 的依据（[Event History](https://docs.temporal.io/encyclopedia/event-history)）。灵台则明确规定：状态、历史和 telemetry 都在一个领域事件流里，其他表只是 projection；通过 `(stream_id, version)` 的 optimistic concurrency 竞争追加（[ADR 0100](../decisions/0100-one-append-only-log.md)）。

因此，Temporal 不是比 event log 更高级的另一种原理。更准确地说：

> **Temporal = 一种通用 Event History 格式 + deterministic replay SDK + 分布式 task/runtime + 运维产品。**

灵台正在选择另一条路：

> **Lingtai = 领域 Event Log + 显式 fold/reconcile + Git/agent 专用 conductor。**

---

## 3. Temporal 比共享 event log 多提供什么

共享 Postgres event log 加 CAS 足以成为跨机器架构；但要达到 Temporal 已有的运行能力，灵台还要自行实现和长期维护：

1. 每个 pass/work item 的 ownership、lease/fencing 与失联接管；
2. durable task dispatch、队列 backlog、限流与 worker capacity；
3. retry policy、timeout、heartbeat、cancellation 与长 Activity checkpoint；
4. durable timer、等待与唤醒，以及 Signal/Update 的投递和去重语义；
5. Worker 版本路由，确保旧执行由兼容代码 replay；
6. 搜索、可视化、CLI、执行历史和操作性诊断；
7. Temporal Service 自身的持久化、高可用和可选跨集群能力。

Temporal 的价值是这些能力已经形成协议和产品，而不是 event log 做不到它们。相应代价是引入 Temporal Service、数据库、Worker fleet、Workflow 代码约束和另一套升级模型。

---

## 4. 把灵台映射到 Temporal 会是什么样

最自然的映射大致是：

```text
一个 ticket/pass = 一个 Workflow

Workflow:
  claim → admit → prepared → design → implement
      ↑                              │
      └──── proposed ← review ← build┘
                       │
                     merge → end

Activities:
  createWorktree / runAgent / build / review / push / merge / GitHub write-back

Signals or Updates:
  human decision / pause / resume / answer / steering
```

Temporal 完全能表达灵台的环，因为 Workflow 是普通代码，不是 DAG。round/restart ceiling 也可以作为 Workflow 状态检查。

但落地会遇到三个实质问题。

### 4.1 两个恢复权威

灵台要求自己的 log 是唯一真相（[ADR 0100](../decisions/0100-one-append-only-log.md)）；Temporal 必须依赖自己的 Event History 才能兑现 replay 和接管。

- 让 Temporal history 做执行真相，会推翻 ADR 0100；灵台日志最多退化为 domain/audit projection。
- 让灵台日志继续做唯一真相，Temporal history 就成为重复状态；两边出现差异时仍需灵台 reconcile。
- Activity 内先追加灵台事件、再返回 Temporal，若回包丢失会重试追加；必须给每次 append 稳定 operation ID 或 expected version，并处理“日志已写、Temporal 未确认”的窗口。

这不是不能做，而是已经不再是“一份日志解释全部事实”。

### 4.2 worktree 有机器亲和性

灵台的 worktree 是整个 pass 的资源边界，同一 worktree 中进行实现、修复、build、review 和 merge lane（[ADR 0108](../decisions/0108-a-refusal-buys-a-round.md)）。Temporal 只会把 Activity Task 路由给可用 Worker，不会复制该目录或仍在运行的 agent process。

采用 Temporal 必须另选一种策略：

- 把同一 pass 的 filesystem Activity 路由到 host-specific Task Queue；这样 host 故障时仍无法自动接管本地 worktree；
- 把 worktree 放到可移动的持久卷；
- 每一步从 commit/patch/artifact 重建 workspace；
- 把 agent/worktree 封成远程、可寻址的执行服务。

后三种都改变了当前“worktree 是 pass”的产品语义；第一种只获得控制流接管，没有获得工作空间接管。

### 4.3 灵台的 retry 是领域决定，不只是 Activity retry

灵台只有四个 step 可以 refuse，refusal 购买的是带证据、继续使用同一 worktree 的 fix round；restart 则从 base 开始，并受另一套预算约束（[ADR 0103](../decisions/0103-a-pass-is-ten-fixed-steps.md)、[ADR 0108](../decisions/0108-a-refusal-buys-a-round.md)）。

这些仍然必须写在 Workflow 代码里。Temporal 自动 retry 适合基础设施瞬时失败；它不会理解 `BuildRefused` 为什么可以买一轮 agent、`findings` 为什么才可以买 restart。因此 Temporal 能删除的是通用 runtime plumbing，不会删除灵台最有价值的领域 conductor 规则。

---

## 5. 何时值得用 Temporal

Temporal 对下面这种“未来灵台”有吸引力：

- 大量项目和并发 pass，需要独立扩缩 Worker；
- pass 跨小时、天甚至更久，并频繁等待人工/外部系统；
- 必须自动处理机器丢失、worker rollout、retry/backoff、timer 和 cancellation；
- 团队愿意运营 Temporal Cloud 或 self-hosted Temporal；
- 工作空间已经能从远程 artifact/commit 重建，或者本身是远程执行服务；
- 愿意让 Temporal Event History 成为执行层权威，并重新定义灵台领域日志的职责。

当前灵台则已经有：固定十步、typed refusal、round/restart、event schema/upcaster、SQLite/Postgres store、projection、waker、单机 ownership 和启动 reconcile。它还是明确的开发 pipeline，而不是通用 workflow builder（[ADR 0103](../decisions/0103-a-pass-is-ten-fixed-steps.md)）。此时加入 Temporal，新增的平台概念多于能删除的领域代码。

## 最终判断

> **Temporal 很强，但它并不证明灵台应该放弃 event log；Temporal 自己正是靠 event log 工作。**

对灵台更合适的路线是先继续深化自己的 log-driven runtime：Postgres 共享日志、per-pass ownership/fencing、幂等副作用和 reconcile。等到 task dispatch、worker fleet、durable timers、版本路由和多机运维成为主要成本时，再比较：

1. 继续把这些能力做成灵台内部的深模块；或者
2. 让 Temporal 替换 conductor runtime，并明确接受新的执行真相和 workspace 模型。

不要把 Temporal 当作现有 event log 下面的“重试库”。它要么成为执行核心，要么大概率只是第二套日志。
