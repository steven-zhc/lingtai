# 0110 — 花费：每次付费调用追加一个 `RunSpent`，`spend` projection 保存它们，估价在折叠时按运行当天的价格计算

> 中文版，供阅读。以英文原文 [0110](../0110-tokens-on-the-event-money-at-display.md) 为准，两者不一致时按英文。

**状态** 已接受 · 2026-10-01，2026-10-18 和 2026-10-28 修订（§5：projection 存储估价）

每次付费调用返回时追加一个 `RunSpent`，日志上没有别的东西带花费。一次付费调用就是一个进程，也就是一次「运行」。`RunSpent` 记录这次运行消耗了什么，分两部分：一是 runtime 自己上报的美元数（`costUsd`）；二是 token 数，分开记录而不是加总，同时记下给它们定价所需的模型和模式。`costUsd` 一定会写，runtime 没说时写 `null`；每个 token 字段都是可选的，缺失也表示没说。两者都绝不用零来表示「没说」。`spend` projection 为每个 `RunSpent` 折叠出一行。Lingtai 绝不在写入日志的路上计算金额：事件只带 runtime 说了什么，不带任何定价结果。projection 可以存金额，作为它自己的事实，分开存放：一是 runtime 上报的美元数，二是在折叠时根据该行的 token 数、按运行当天生效的价格算出的估价，价格来自 [`doc/rate-card.md`](../../rate-card.md) 和它背后带日期的快照。读者只需对存好的列求和。

## 背景

一遍 pass 可能调度两种 runtime，而只有 Claude Code 上报美元数。Codex 上报 token 用量，不报价格。一个没有记录花费的步骤，在看板上显示为不花钱，这就把未知的花费报成了免费。一个加总后的 token 数也无法定价：缓存读取的价格约为新输入的 0.1 倍，缓存写入约为 1.25 倍，所以同一个总数可以对应 12 倍的价格范围。一个模型 id 也可能有不止一种价格（Claude Opus 5 有标准价，还有快速模式）。票合并后，运行日志会被删除，所以一个只写进运行日志的数字，等到有人问这件工作花了多少钱时，已经没了。

Lingtai 在六个地方启动付费进程，它们结束时的事件种类并不相同。实现者以 `RunFinished` 结束，一轮修复以 `FixApplied` 结束，一次讨论以 `DiscussionAnswered` 结束。冷审查者和设计者在某个步骤的裁决里结束，judge 在某次路由的决定里结束，这些都与钱无关。如果把花费写在调用恰好结束时的那个事件上，花费就没有唯一的归属；而结束事件讲的是别的事情的那三种调用，恰好就是花费没被记录的那三种。

## 决定

1. **`RunSpent { for, runtime, turns, durationMs, usage, costUsd }`，`costUsd` 是 runtime 做出的陈述：`null` 表示它什么也没说。**
   Claude Code 从它的收据里填这个值；Codex 一律记 `null`，绝不记 `0`。`usage` 是第 3 条的五个计数。`runtime` 是 runtime 的 id。没有价格字段：那会是写入日志路上的金额，而第 5 条禁止事件带金额。

2. **每次付费调用一个 `RunSpent`，别的东西都不带花费。** 每个启动付费进程的地方都追加它；其他事件没有花费字段。一个原因可以引用某个数字作为证据（[0120](../0120-a-reason-is-a-type.md) §2 中 `BudgetExhausted` 的 `costUsd`，说明一次运行在被上限停下之前走了多远）；那是关于一次停止的证据，不是花费，没有任何东西会对它求和。

   **一次付费调用就是一个进程。** 一次 `Runtime.run`，就是术语表里的一次「运行」，对应一个 `RunSpent`。一轮修复是一次运行。一个讨论问题如果用了三个进程，就是三次运行、三个 `RunSpent`。

   **返回了结果的运行，不论成败都记录花费；没有结果就被杀掉的进程什么也不记录。** 用完轮数、用完美元、审查不通过、答案无法读取，以及崩溃但仍然返回了 `RunOutcome` 的情况，都会追加 `RunSpent`。在返回任何东西之前就被杀掉的进程（墙钟超时、第二次 Ctrl+C、conductor 自己崩溃）没有可记录的东西，也就什么都不记。**所以日志上的花费是一个下限**，而漏掉的运行正是那些长的。谁读到一个总数，都应该把它读作「至少」。

3. **token 记录为五个计数，跨轮次累加，绝不加总，而且互不重叠。** `usage` 的类型是 `Usage`（`packages/domain/src/spend.ts`）：一个数组，一次调用计费的每个模型一项，每项有自己的 `tokens`：

   | 计数     | claude-code                   | codex                                     |
   | -------- | ----------------------------- | ----------------------------------------- |
   | 新输入   | `input_tokens`                | `input_tokens − cached_input_tokens`      |
   | 来自缓存 | `cache_read_input_tokens`     | `cached_input_tokens`                     |
   | 写入缓存 | `cache_creation_input_tokens` | `cache_write_input_tokens`                |
   | 输出     | `output_tokens`               | `output_tokens − reasoning_output_tokens` |
   | 推理输出 | 不单独上报                    | `reasoning_output_tokens`                 |

   **Codex 自己的计数有重叠，事件里的不能有。** `cached_input_tokens` 是 `input_tokens` 的一部分，`reasoning_output_tokens` 是 `output_tokens` 的一部分。这是对照一次真实的 rollout 测出来的，其中 `total_tokens` 恰好等于 `input_tokens + output_tokens`。如果把 `input_tokens` 整个存成新输入，而缓存部分又被记成缓存读取，缓存部分就会被收两次钱。所以 Codex 适配器做减法，而且只在两个操作数都上报了时才减。`cached_input_tokens` 缺失时没有可减的东西，`input_tokens` 就整个作为新输入保留。如果反过来把它丢掉，就是第 4 条禁止的颠倒：把 runtime 确实说过的 token 报成没人计费的 token。`reasoning_output_tokens` 缺失时，`output_tokens` 也同样整个保留。这时没有需要防范的重叠，而且不论哪种情况，它都按输出价格正确计费。claude-code 的四个计数不需要这种减法：它自己的 `modelUsage` 报出来时就已经互不重叠。

   **只有 cached/reasoning 这一对是测过的；`cache_write_input_tokens` 没有测过。** 本项目见过的 rollout 和 fixture 里，没有一个带这个字段。所以它是否也像 `cached_input_tokens` 那样（已经证实）包含在 `input_tokens` 里，还是未知的。适配器把它整个存下，不从新输入里减掉。如果它是一个独立的量，这样做是对的；如果不是，它就被重复计算了。第一个见到真实 `cache_write_input_tokens` 的人，要像这里确定 cached/reasoning 那一对一样，从那次 rollout 把这件事定下来，并修改这一段，而不是在旁边再加第三条计数规则。

   **每个模型一项，以 `(model, mode)` 为键。** claude-code 的 `modelUsage` 本身就以模型 id 为键，一次调用可能计费不止一个模型。对 claude-code，每项的 `model` 就是那个键，原样照抄，绝不是 recipe 要求的模型。**Codex 正好相反，而且是有意的：它的输出流从不说明实际服务这次调用的是哪个模型，所以它那唯一一项的 `model` 是 `request.model`，也就是 recipe 的要求。这对实际由哪个模型服务什么也说明不了，不论是因为提供方做了替换，还是因为 `request.model` 缺失，运行落到了 `~/.codex/config.toml` 的默认值。** **`request.model` 缺失时，该项的 `model` 取那个文件里的 `model`**：在运行开始时读取，并标明来自配置文件，因为 Codex 落到的正是这个模型；两者都没有时，该项没有模型，无法定价。各项有 token 却没有模型的运行，原因是*缺少模型*而无法定价，绝不能说成没有上报用量。 读者只有对 claude-code 才能安全地把 `usage[].model` 当作 runtime 上报的事实来定价或断言；对 Codex，它只是请求原样回显。两轮的 token 相加时（`addUsage`），各项按 `(model, mode)` 合并；键不同的项是账单上的另一行，不是同一行的第二次计数。`mode` 表示同一模型 id 下的高价速度档，前提是 runtime 有这一档。事件用一个数组，而不是零散的字段，因为没有人手写事件。

4. **每个 token 字段都是可选的，没有一个默认为零；`costUsd` 一定写，没说时为 `null`。** 这些字段里只要有一个 `.default(0)`，就会把未知的花费报成免费。这也是没有 `Reading<T>` 包装的原因：`null` 和缺失的计数本身就表示「没说」，而上报的 `0` 就是 `0`。

5. **事件绝不带价格；projection 可以存估价，与上报的数字分开。** 事件记录 runtime 说了什么。给一次运行定价的折叠只读事件、随代码发布的价格表和带日期的快照，别的都不读：不读时钟，不访问网络。它按运行自己的 `at` 那天生效的价格定价，所以以后价格变了，已经折叠的行不会变，重建也得到同样的数字；有一个已接受的例外，见下。它每行存 `cost_usd`（runtime 自己的 `costUsd`，没说时为 `null`），以及 `estimated_usd` 和是否用到了快照（无法定价时为 `null`）。两者绝不相加成一列，两者都没有的行是未知，绝不是 `0`。

   **一个模型第一次有了价格时，存过估价的内容要重新折叠。** 需要修复的估价过时，只有一种情况：某个模型的运行在折叠时这个模型还没有价格行。所以当快照刷新为一个之前没有价格的模型定了价时，存估价的 projection（`spend` 和 `ticket_report`，0123）都要重建，每一行按它自己的日期重新定价。对已经有价格的模型，价格只是变了的话，什么都不重建。

   **已接受的例外：同一天替换价格。** 同一个 UTC 日的第二次抓取会替换当天那一行（`mergeSnapshot`，`packages/domain/src/rate-card.ts:231`），这只会在「上游当天调价、conductor 又在同一天重启」时发生。已经折叠的行保留之前的估价，重建会得到后来的价格。这种情况不重建：估算不是账单，为它全部重建不值得（0123 §6）。

6. **价格表是一个由人追加的文件。** `doc/rate-card.md` 每个（model、mode、`from` 日期）一行，带每百万 token 的输入、输出、缓存读取和缓存写入价格。推理输出按输出价格收费。价格变动时加一行新的，绝不修改旧行，所以旧的运行仍按它发生时生效的价格定价。没有价格行的模型是「未定价」的，按第 7 条，它的运行是未知。Codex 目前没有价格行。价格表不从 Models API 获取（它不带价格），也不从定价页面抓取。不在随代码发布的价格表里的行，可以来自一份抓取下来的、带日期的快照，它在发布的行之后读取，而且定价时绝不去抓取。

7. **`/spend` 显示 `spend` projection，按用途拆分。**
   `apps/board/src/app/spend/page.tsx` 每个项目显示一行，各用途从 `for` 读出，绝不合并，每个总数都按下面的规则分开。授权这些花费的 recipe 限额显示在账单下方。

   **读者把上报的美元显示为事实，估价显示为估价，未知显示为未知，绝不显示为 $0。** 上报了 `costUsd` 的，就用这个数字。没有上报、但上报了 token，而且价格表在 `at` 时有该模型和模式的生效行的，就用 token 定价，并标为估价。两者都不满足的，这次运行的花费是未知，就显示为未知。**总数把三者分开：上报的总数；估价列在它旁边，绝不加进去；以及未知运行的条数。** 看板、`lingtai status` 和任何报表都读存好的 `cost_usd` 和 `estimated_usd` 并求和；没有一个在显示时定价。

8. **`RunSpent` 追加到它所属运行的事件流上，不带票 id。** pass 内的运行（实现、一轮修复、审查者、设计者、judge）在 pass 事件流上，该流的 `RunStarted` 一次性写明它的票。triage 在票的事件流上。讨论在它的 `chat-…` 事件流上，该流的 `DiscussionRequested` 写明它的票。没有事务 id：事件流已经说明了这次运行属于谁的历史。

9. **`for` 说明这次运行是为了什么**，是一个带标签的联合类型：

   ```ts
   type SpentFor =
     | { _tag: 'Action'; step: Step; name: string; round: number } // a recipe action: implement, a fix round, the reviewer, the designer
     | { _tag: 'Judge'; when: JudgeWhen } // the judge at proposed
     | { _tag: 'Triage'; waitId: WaitId }
     | { _tag: 'Discussion' }
   ```

   一个 action 的花费，就是它的 pass 事件流上 `step`、`name` 和 `round` 相同的那个 `RunSpent`。所以 action 不带对其花费的引用，也没有调用 id：靠 `step`、`name` 和 `round` 就能找到它。只要 action 的 `name` 在其步骤内唯一，这就成立。被上限停下的等待，也是用同样的方式，通过它的 `run` 找到对应运行的花费。

   **声明的 `name` 不能包含 `:`**（`#503`）：`run.steps` 和 `task_view` 用同样的 `step`/`name` 对作为 action 的键，而 conductor 会在停下的那个步骤自己的 `StepEnded` 之后，往这个键空间里追加它自己的签核：`conductor:judge`/`conductor:unfixed`。`:` 被保留下来，好让 `conductor:` 成为一个声明的名字永远不会撞上的命名空间；recipe 校验器拒绝任何包含 `:` 的声明名字。

10. **六种付费调用**就是所有调用 `Runtime.run` 的地方：

    | 运行       | 位置                                                           | `for`                 |
    | ---------- | -------------------------------------------------------------- | --------------------- |
    | 实现       | `packages/conductor/src/conduct.ts`，`implement` 处的调度      | `Action`              |
    | 一轮修复   | `conduct.ts`，修复轮的调度                                     | `Action`，`round` ≥ 1 |
    | judge      | `conduct.ts`，`askTheAgent`                                    | `Judge`               |
    | 冷审查者   | `packages/actions/src/agent-action.ts`，审查的调度             | `Action`              |
    | 设计者     | `agent-action.ts`，设计的调度                                  | `Action`              |
    | 一次讨论   | `apps/cli/src/discuss.ts`，`discussionAsk`                     | `Discussion`          |

    triage 目前还没有调度；有了以后，它就是第七种，追加 `RunSpent { for: Triage }`。新增一个启动付费进程的地方，只追加 `RunSpent`，不改动任何其他事件。

11. **`spend` projection 每个 `RunSpent` 一行**：`seq`、`at`、`ticket`、`pass`（不在 pass 事件流上时为 null）、`for` 及其 `step`、`action` 和 `round`、`runtime`、`turns`、`duration_ms`、`cost_usd` 和 `usage`（jsonb），以及第 5 条的估价：`estimated_usd` 和 `estimate_fetched`，以及 `kind`：折叠这一行时，这次运行所属的领取带的票的类型（0123 §3）。折叠从 pass 事件流的 `RunStarted`、票事件流本身，或者讨论的 `DiscussionRequested` 填入 `ticket`，这些到那时它都已经读过了。卡片上的总数、`/spend` 的各行和任务页上的调用列表，都是对它的查询。它是每次运行一行，而不是每张票一个总数，因为估价（第 5 条）需要每次运行的模型、token 和时间，也因为每天的花费是对它的一个查询。

12. **上限属于 runtime，不读日志上的任何东西。**
    `runtime.limits.usd` 限制一次运行，由 runtime（`--max-budget-usd`）按它自己的计数执行，和 `turns`、`wall` 一样。Lingtai 不对每遍 pass 或每张票执行美元上限。它自己唯一的上限是每日上限，触发时暂停领取新工作，不杀掉任何东西（[0122](../0122-several-passes-share-one-conductor.md) §5）。

13. **除了 `RunSpent`，没有事件带花费。** 旧字段，即 `RunFinished`、`DiscussionAnswered` 和 `DiscussionHeld` 上的 `turns`、`costUsd` 和 `usage`，以及 `task_view` 的 `cost_usd` 和 `repair_costs`，只在改变存储事件的那次重置之前和 `RunSpent` 并存（[0120](../0120-a-reason-is-a-type.md) 的第二阶段，#502），随那次重置一起消失了（#506 删除了这些列）。`TriageAgent` 从来没带过它们：triage agent 的花费是一个 `RunSpent`，别的什么都不是（[0118](../0118-a-hold-explains-itself.md) §3）。`spend` 折叠只读 `RunSpent`，不读其他事件，而卡片、`/spend` 和任务页都读 `spend`。旧字段在重置之前记录的内容不会带进 `spend`：重置把它和日志的其余部分一起忘掉了。

## 后果

- 得有人保持价格表是最新的。一行过时的价格会报出一个看起来可信的错误数字，而缺一行只是什么都不报，所以让一行空着是更安全的失败方式。
- 价格表算出的每个估价都只是估价。提供方自己的账单（对 Claude 来说，是 Admin API 的用量和费用报告）才是权威，与它对账是另一个问题。
- 日志上的花费恰好少算了被杀掉的那些运行，而它们正是长的那些。总数是一个下限，页面上会这样写明。
- judge 的花费和其他运行一样，是一个 `RunSpent`。judge 仍然没有为它的决定单独设一个事件：那就是 `PassRouted`。
- 要重建的 projection 有四个：`task_view`、`finding_backlog`、`spend` 和 `ticket_report`（0123）。
- Lingtai 自己执行的美元上限读 `spend` 存好的数字：每日上限（0122 §5），以及如果加上的话，每张票的上限（#674）。
- 一次为新模型定价的刷新，代价是重建每个存估价的 projection。这种情况很少：每个模型一次，在它第一次被抓取的那天。

## 尚未实现

- **还没有读取 Codex 配置的模型。** 没有 `request.model` 的项没有模型，原因显示为 "no usage reported"，尽管 token 就在事件上（`packages/domain/src/rate-card.ts` 的 `NO_USAGE_REASON`）。

- **第 5 条的存储估价。** `spend` 目前只存 `cost_usd`，`apps/board/src/lib/spend.ts` 和 `packages/conductor/src/day-ceiling.ts` 仍在读取时定价；新模型定价后的重建还没有接上。

- **`Action.call` 和 `CallId` 仍然存在**于 `packages/domain/src/action.ts` 和 `wait.ts` 中，未被设置。
- **价格表只列了一个 Codex 模型，`gpt-5.6-sol`。** `priceRow`（`@lingtai/domain/rate-card`）在读取时用价格表为 `costUsd` 为 null 的运行定价；在任何其他模型上、或者没有记录模型的 Codex 运行，按第 7 条都是未知，直到有人追加它的价格行。

---

_替代 [decisions-archive](../../decisions-archive/) 中归档的 0073、0075。_
