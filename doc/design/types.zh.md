# Lingtai 的类型：一张票从"一步结束"到"等人处理"

> 草稿，定义中。**主干（第 1–4 节和第 8、9 节）按第二轮评审重写，待 review**；review 通过后，类型以本文为准：所有类型定完之前，[0118](../decisions/0118-a-hold-explains-itself.md) 和 [0120](../decisions/0120-a-reason-is-a-type.md) 里和本文不一致的地方都按本文读；定完后一次写回这两个 ADR。这里用代码讲清楚每个类型为什么存在。代码用 TypeScript 写成判别联合（`_tag`），实现时用 zod 定义在 `@lingtai/domain`。

## 原则

1. **原因是类型，不是字符串。** 代码只要按某个值分支，那个值就该是一个变体。
2. **证据跟着变体走。** `BuildRed` 带红的输出，`MergeConflict` 带冲突路径。不存在"某个字段只在某种情况下有值"。
3. **存事实，派生类别。** 类别（"要人拍板"还是"机器坏了"）由函数从事实算出来，不另外存。
4. **一个名字只表示一件事。** 看到变体名就知道它属于哪一层、说的是什么。不单独用 Held、Failure、Continue 这类通用词。
5. **页面词 = 列 id = 类型名。** 看板的列叫 _Waiting on you_，id 是 `waiting`，所以类型是 `WaitReason`、`WaitOnPerson`，事件是 `WaitStarted`。_you_ 只留在页面上，日志和 CLI 没有固定的读者。**hold 只指 `agent:hold`**：人在领取前按住一张票，票还在 Queued。方向相反，是人让机器等。代码里现在的 `Hold`、`HoldTriaged`、`Held` 由 #450 改名。同理，`proposed` 这一步只叫 `proposed`，不再叫 router：到达它的是 `Proposal`。它做的事叫 route（动词），选出的是 `PassNext`，和其他 step 结束后的下一步同一个类型。
6. **决策是纯函数，副作用在外层。** 纯函数不读数据库、时钟、git 或进程；外层调用纯函数，再按结果行动。
7. **互斥的用判别联合，能同时发生的用列表。** 一次 agent 运行可以既提交了改动又提了问题，这两件事不能做成一个联合里的两个变体，否则其中一件就丢了。也不能反过来，为了用上判别联合把正交的事实硬拼成互斥。

## 一张票的流程

```mermaid
flowchart LR
  X["Action<br/>一次与外界的操作<br/>execution + products"] -->|"一步的所有 action"| A["StepOutcome<br/>这一步怎么结束<br/>（日志：StepEnded）"]
  A -->|proposalOf| B["Proposal<br/>为什么到 proposed"]
  B -->|offerFor| O["RouteOffer<br/>候选去向"]
  O -->|"route（decideRoute）"| R["RouteDecision<br/>（日志：PassRouted）"]
  R --> D["PassNext<br/>下一步"]
  A -->|nextOf| D
  D --> E["WaitReason<br/>为什么等人"]
  E --> F["Resolution<br/>这次等待怎么了结"]
  E --> G["Triage<br/>agent 的分析"]
```

调用方看不到这张图里的任何一个函数，只调 `runPass`（第 9 节）。这些类型定义的是日志里存的事实和 `runPass` 内部的纯函数。

---

## 1. `Action` 与 `StepOutcome`：一步结束，一条事件，带上它的每个 action

**目的**：pass 跑完一步，要知道接下来是继续、到 proposed，还是停下。一个 step 下可以有好几个 action：build 下跑 `pnpm test`、`pnpm typecheck`、`pnpm lint`，每个都是一次与外界的操作。所以分两个类型：**`Action` 是一次操作，`StepOutcome` 是一步的结束，`StepOutcome` 包含这一步的所有 action**。日志里只有 step 结束的事件，action 不单独成事件。

**一个 action 的结果分两部分**（原则 7）：执行本身怎么结束（`execution`，互斥，只有一个），和它产出了什么（`products`，可以有零个或多个）。

```ts
// 执行怎么结束：互斥
type Execution =
  | { _tag: 'Completed'; said: string | null } // 跑完了；said 是 agent 最后说的话，命令为 null
  | { _tag: 'AnswerUnreadable'; raw: string } // agent 跑完了，但它的回答解析失败，是机器弄丢了
  | { _tag: 'Interrupted'; kind: 'crash' | 'timeout' | 'out-of-turns' | 'out-of-usd'; detail: string }
  | { _tag: 'NeverStarted'; scope: 'conductor' | 'work-item'; why: string } // 账号额度、环境不满足
  | { _tag: 'NotReached' } // 前面的 action 没通过，这个没轮到跑

// 产出了什么：可以同时有多个
type Product =
  | { _tag: 'Assessment'; verdict: 'accepted' | 'refused'; evidence: string; findings: Finding[] } // 命令或 reviewer 的结论
  | { _tag: 'TreeAdvanced'; from: string; to: string } // agent 提交了改动，分支从 from 走到 to
  | { _tag: 'DesignProduced'; design: string }
  | { _tag: 'QuestionAsked'; question: string }
  | { _tag: 'SignoffRequested'; source: 'declared' | 'injected'; question: string } // human: 或 watch:
  | { _tag: 'Integrated'; mergeSha: string } // merge：已合进 main
  | { _tag: 'IntegrationRefused'; reason: RefusalReason; paths: string[] | null; baseSha: string; headSha: string; raw: string | null }

// 一次与外界的操作：一条 shell 命令、一次 agent 运行、一次人签字、一次合并
type Action = {
  name: string // recipe 里写的那个：'pnpm test'、'reviewer'、'implement'
  onSha: string | null // 这个结论针对哪个 diff；没跑的是 null
  execution: Execution
  products: Product[]
  usage?: Usage // 计量以后改按调用记，另开票，见下文
  costUsd: number | null
}

// 一步的结束：这一步声明的每个 action，按声明顺序，没跑的也在
type StepOutcome = { step: Step; round: number; actions: Action[] }

// 日志：一个 step 跑完一次，一条
StepEnded { runId, outcome: StepOutcome }
```

**"没通过"是派生的**：一个 action 通过，当且仅当 `execution` 是 `Completed`，并且 `products` 里没有 `Assessment{refused}`、`QuestionAsked`、`SignoffRequested`、`IntegrationRefused`。`passed(action)` 是一个纯函数，不存。

**一步最多一个没通过，不用挑。** 同一个 step 里，一个 action 没通过，后面的就不再跑（`pass-steps.ts:719`："pipeline stops at the first action that did not pass"），后面的都记成 `NotReached`。所以让这一步停下的就是最后一个不是 `NotReached` 的 action；全部通过时这一步就是通过；这一步没有声明任何 action 时 `actions` 为空，按通过处理。fold 和 `nextOf`、`proposalOf` 都直接读，不需要另存一个 `decisive` 字段。声明了几个、跑了几个、哪个没通过，都能从 `actions` 直接数出来。

**"没改东西"不是事实，是解读**：fix 轮次里 agent 跑完了但没有提交，记成 `Completed{said}` 加空的 `products`。"fix agent 不同意 reviewer"是 `nextOf` 对 implement 这个操作的解读，它据此给出 `FixerDisagrees`，日志里不另造一个 `AgentChangedNothing`。

**`onSha` 跟着 action 走，不跟着 step 走**：现在的 `Step*` 事件每个 action 一条，带 `{step, action, runId, onSha}`（`events.ts:629`）。`onSha` 说明结论针对哪个 diff，force-push 之后旧结论自动失效，不会被继承。implement 中途会 commit，同一 step 里 sha 可能变，所以每个 `Action` 自己带。

**中途崩溃不补事件**：conductor 死在一个 step 中间时，这一步没有 `StepEnded`。下一个 conductor 从日志里最后一条 `StepEnded` 接着走，也就是把被打断的这一步整步重跑。已跑完的 action 的结论和花费不进日志，这一点按 action 记事件也一样：死在 action 中间的那一个照样什么都没留下，所以不为它多一种事件或变体。

**计量不在这里定**：`usage`、`costUsd` 暂时留在 `Action` 上。更对的单位是一次付费调用：action、judge、triage 都会花钱，每次调用一张收据，`Reported(0)` 和 `NotReported` 分开，run、step、轮次的花费都由投影求和。这属于 spend，另开票处理，不在本文定义。

**例子**：#500 的一个 pass。build 声明了 `pnpm test`、`pnpm typecheck` 两个。

| 第几次 | `StepEnded.outcome`                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1      | implement, round 0：`implement` `Completed` + `[TreeAdvanced{a0→a1}]`                                                       |
| 2      | build, round 0：`pnpm test` `Completed` + `[Assessment{refused, 2 个失败}]`；`pnpm typecheck` `NotReached`                  |
| 3      | implement, round 1：`implement` `Completed` + `[TreeAdvanced{a1→b2}]`                                                       |
| 4      | build, round 1：`pnpm test` `Completed` + `[Assessment{accepted}]`；`pnpm typecheck` `Completed` + `[Assessment{accepted}]` |
| 5      | review, round 1：`reviewer` `Completed` + `[Assessment{refused, findings}]`                                                 |
| 6      | implement, round 2：`implement` `Completed{said: "ticket 写明只支持 ISO"}` + `[]`                                           |

另一个 pass：agent 提交了一半改动，然后对剩下的部分提问：`implement` `Completed` + `[TreeAdvanced{c1→c2}, QuestionAsked{…}]`。旧的 `ActionOutcome` 只能在 `AgentCommitted` 和 `AgentAsked` 里选一个，丢掉另一个。

**每种 action 能产出什么，是一张表加一条测试，不是类型。** 按插件分类型能让编译器挡住 reviewer 产出 `TreeAdvanced`，但 `nextOf`、`proposalOf` 的签名都要变成泛型，不值。所以 `PRODUCTS_OF: Record<PluginKind, Product['_tag'][]>` 写在 domain 里，一条单元测试要求每个 `Action` 的 products 都在它插件的那一行里。按插件而不是按 step 列，因为能产出什么由 action 是什么决定：

| 插件                 | 能产出                             | 能有的 `execution`（除 `NotReached` 外，它由 conductor 写） |
| -------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `run:`（命令）       | `Assessment`                       | `Completed`、`Interrupted{timeout}`、`NeverStarted`         |
| `agent:`（reviewer） | `Assessment`                       | 全部                                                        |
| implement            | `TreeAdvanced`、`QuestionAsked`    | 全部                                                        |
| design               | `DesignProduced`、`QuestionAsked`  | 全部                                                        |
| `human:`、`watch:`   | `SignoffRequested`                 | `Completed`                                                 |
| merge                | `Integrated`、`IntegrationRefused` | `Completed`、`NeverStarted`                                 |

实现时这张表以 `packages/recipe/src/recipe.ts` 里的插件定义为准，上表是起点，不是定稿。

**`StepEnded` 替换哪些事件**：见第 8 节。证据在变体里（原则 2），事件上不再另放 `evidence`。`StepFailed.unreadable` 变成 `AnswerUnreadable` 这个变体，不再是一个"只在某种失败时有值"的字段。事件名不加 `Event` 后缀：`EVENTS`（`events.ts:2185`）里约 70 个事件都是不带后缀的过去时，只给一个加会不一致，全加是一次全日志改名；过去时本身就说明它是事件。

**审视：合并，并拆开正交的事实。** 现在有两个类型描述同一件事：conductor 的 `StepEnding`，以及 0120 草稿里的 `FixOutcome`。"agent 跑完但没提交"在第一次派发时记成 `RunFailed{kind: 'no-commits'}`，在修复轮次里记成 `FixApplied{headSha: null, failure: null}`，两种写法表达同一个事实。现在都是 implement 这一步的一条 `StepEnded`，修复轮次只是 `round` 大于 0。上一版的 `ActionOutcome` 有 9 个互斥变体，把"执行怎么结束"和"产出了什么"拼在一起，违反原则 7，所以拆成 `execution` 和 `products`。

---

## 2. `Proposal`：改动为什么到 proposed

**目的**：`proposed` 要根据"从哪一步来、为什么来"决定给哪些候选去向。`InputNeeded` 要回到发问的那一步，`MergeConflict` 只可能来自 merge。

**相关联合，不是 `{from, reason}`**：上一版的 `{from: Step; reason}` 允许 `from: 'design'` 配 `BuildRed` 这种不可能的组合。现在每个变体自己写死它能来自哪一步：

```ts
type Proposal =
  | { _tag: 'BuildRed'; from: 'build'; output: string }
  | { _tag: 'ReviewFindings'; from: 'review'; findings: Finding[] }
  | { _tag: 'ReviewEmpty'; from: 'review'; said: string } // reviewer 拒绝了，但没有可执行的意见
  | { _tag: 'ReviewUnreadable'; from: 'review'; raw: string } // 回答解析失败，是机器弄丢了
  | { _tag: 'InputNeeded'; from: 'design' | 'implement'; question: string }
  | { _tag: 'MergeConflict'; from: 'merge'; paths: string[]; baseSha: string; headSha: string }
  | { _tag: 'VerifyRed'; from: 'merge'; output: string } // base 动了，在新 base 上重跑检查红了

const proposalOf: (outcome: StepOutcome) => Option<Proposal>
```

五个 `JudgeWhen`（`hold.ts:58`）与它对应：`red` 是 `BuildRed`，`verify-failed` 是 `VerifyRed`，`conflict` 是 `MergeConflict`，`needs-input` 是 `InputNeeded`，`findings` 是三个 `Review*`。

**`proposalOf` 的构造后条件**（不是类型保证）：给出 `ReviewFindings` 时，`findings` 里至少一条带失败场景；一条都没有的拒绝给出 `ReviewEmpty`。这条由 `proposalOf` 的单元测试固定。

**实现时核对**：`ARRIVE_AT_THE_ROUTER`（`pass.ts:1012`）里还有 `admit` 和 `prepared`。上表没有给它们 Proposal 变体：prepared 的拒绝现在按 `SetupRefused` 直接交给人。如果它们确实会到 proposed，要补变体，而不是放宽 `from`。

**例子**：build 跑 `pnpm test`，2 个测试失败，得到 `BuildRed{from: 'build', output}`。

**审视：保留，改成相关联合，补 `ReviewEmpty`。** `ReviewEmpty` 和 `ReviewUnreadable` 必须分开（`pass-steps.ts:837`）：前者是"reviewer 没话说"，后者是"机器把回答弄丢了"，人面对两者的处理不同。`ProposalReason` 这个类型删掉，它的变体直接成为 `Proposal`。

**改名**：0120 草稿叫 `Arrived` / `Arrival` / `arrivalOf`，再早叫 `RouterVisit`。WaitReason 里的 `RouterEscalated` 相应改为 `ProposedEscalated`。

---

## 3. route：proposed 怎么选下一步

**route 是动词，不是类型**：指 `proposed` 做选择这件事，只在 `proposed` 发生。

**目的**：judge 只能在 workflow 给的候选里选，日志要能分清"judge 选的"和"judge 选不了、交给人"以及为什么。

```ts
type CandidateId = string // 比如 'fix-lines'、'restart'、'hand-to-person'

type RouteCandidate = { id: CandidateId; next: PassNext } // next 已经带好要花的那一轮
type ExcludedCandidate = { id: CandidateId; because: { _tag: 'CeilingReached'; ceiling: 'rounds' | 'restarts' } } // 只有这两个是 route 的上限（pass.ts:973-974）

type RouteOffer = { proposal: Proposal; available: RouteCandidate[]; unavailable: ExcludedCandidate[] }

type JudgeReply =
  { _tag: 'Selected'; candidate: CandidateId; why: string } | { _tag: 'Unreadable'; raw: string } | { _tag: 'NoJudge' } // 没声明 judge，由外层合成

type RouteDecision =
  | { _tag: 'Selected'; candidate: CandidateId; next: PassNext }
  | {
      _tag: 'Escalated'
      because:
        | { _tag: 'NoJudge' }
        | { _tag: 'UnreadableReply'; raw: string }
        | { _tag: 'UnknownCandidate'; candidate: string } // judge 选了一个 offer 里没有的 id
        | { _tag: 'CandidateUnavailable'; excluded: ExcludedCandidate } // judge 选了被上限挡掉的那个
      next: Extract<PassNext, { _tag: 'WaitOnPerson' }>
    }

const offerFor: (proposal: Proposal, policy: RoutingPolicy, spent: Spent) => RouteOffer
const decideRoute: (offer: RouteOffer, reply: JudgeReply) => RouteDecision
```

**为什么这样**：

- judge 从候选 id 里选，不返回任意一个 Step。"回答不在选项里"变成 `UnknownCandidate`，不需要拿回答和两个数组比对。
- 预算在 `offerFor` 里算完：可用的候选已经带着 `FixRound{round: 3}`，被上限挡掉的进 `unavailable`。`decideRoute` 只需要 offer 和回答，不再需要 `RunContext`，也不会再解释一遍上限。
- `Escalated` 的 `next` 只能是 `WaitOnPerson`，由类型保证。原因一般是 `ProposedEscalated{proposal, why}`；`InputNeeded` 没有 judge 时是 `AgentQuestion`，比 `ProposedEscalated` 更具体。
- 上一版的 `{next: PassNext; basis: RouteBasis}` 是笛卡尔积，可以拼出 `JudgeChose` 配一个 offer 里根本没有的 `next`。现在不可能了。

**例子**：

- reviewer 提了 major，judge 选 `fix-lines`，还剩轮次：`Selected{candidate: 'fix-lines', next: FixRound{round: 2}}`。
- 3 轮已经用完，judge 仍选 `fix-lines`：`Escalated{because: CandidateUnavailable{excluded: {id: 'fix-lines', because: CeilingReached{rounds}}}, next: WaitOnPerson{reason: ProposedEscalated{…}}}`。
- build 红了，没有声明 judge，内置规则 `same-worktree`（`judge.ts:466`）作为 judge 回答 `Selected{candidate: 'fix-lines'}`。

`JudgeReply` 的来源：内置规则是纯函数；agent 是副作用（要花钱）；没有声明 judge 时，外层合成 `NoJudge`。人不是 judge，人是 `WaitOnPerson` 的去向。offer、回答和决定都是发生过的事实，三者一起存进 `PassRouted`（第 8 节）。

**审视：删掉 `Route` 和 `RouteBasis`。** `Route` 的三个变体里两个和 `PassNext` 重复，`HandToPerson` 只是还没补上原因的 `WaitOnPerson`。`RouteBasis` 和 `next` 组成的笛卡尔积允许非法组合，由 `RouteDecision` 的两个变体取代。`RouteOffer` 已经存在（`pass.ts:837`），这里把它从"两个 Step 数组"改成"带 id 的候选"。

---

## 4. `PassNext`：下一步，花了什么一起写明

**目的**：pass 接下来做什么，只有这一个类型，包括终态。**它是完整的状态转换，不只是目的地**：会花预算的走法是单独的变体，花了哪一轮写在值里。

```ts
type PassNext =
  | { _tag: 'Advance'; to: Step } // 沿主线往前，不花预算：去下一步、去 proposed、去 merge
  | { _tag: 'FixRound'; round: number } // 回 implement，花掉第 round 轮修复
  | { _tag: 'Requeued'; cause: RequeueCause } // 释放领取，票回队列：终态
  | { _tag: 'WaitOnPerson'; reason: WaitReason } // 票进 Waiting：终态
  | { _tag: 'Landed'; integrated: string } // 合进 main：终态；mergeSha 必须来自同一 pass 的 Integrated 产出

type RequeueCause =
  | { _tag: 'Restart'; restart: number } // proposed 决定思路错了，从 base 重来，花掉第 restart 次重开
  | { _tag: 'NeverStarted'; scope: 'conductor' | 'work-item'; why: string } // 和 diff 无关；scope 为 conductor 时 conductor 同时暂停

const nextOf: (
  outcome: StepOutcome,
  run: RunRef,
) => Extract<PassNext, { _tag: 'Advance' | 'WaitOnPerson' | 'Requeued' | 'Landed' }>
const spentAfter: (spent: Spent, next: PassNext) => Spent // FixRound、Requeued{Restart} 各加一，其余不变
```

**`nextOf` 收窄**：普通 step 结束后不会直接花预算。build 红了是 `Advance{to: 'proposed'}`，回 implement 修是 `proposed` 选出来的。所以 `FixRound` 和 `Requeued{Restart}` 只由 `decideRoute` 产出（经由 offer 里的候选），`nextOf` 的返回类型不含 `FixRound`，由类型保证。

**重开就是重新排队**：现在的 restart 会释放领取、把票放回队列，和"没开始就撞上账号额度"走的是同一个终态（`pass.ts:1245` 的 `outcomeOf`：`rested === 'requeued'` 和 `never-ran` 都是 `failed`）。所以上一版的 `RestartFromBase` 并进 `Requeued`，重开次数写在 `cause` 里。

**不变量**（由测试固定，不是类型保证）：

- `Advance.to` 只能是主线上更靠后的 step。往回走只有 `FixRound` 一种。
- `Landed` 只在 merge 的 action 产出 `Integrated` 时给出，`integrated` 就是那个 `mergeSha`，不能从"前面都通过了"推出来。
- 终态（`Requeued`、`WaitOnPerson`、`Landed`）之后，这个 pass 不再有 `StepStarted`。
- `round` 和 `restart` 等于已花的数加一，由 `offerFor` 算，`spentAfter` 照着值更新，不再判断。

**例子**：

- build 结束，全部通过：`Advance{to: 'review'}`。
- build 结束，`pnpm test` 红了：`Advance{to: 'proposed'}`，由 `proposed` 去 route。
- `proposed` 决定再修一轮，这是第 2 轮：`FixRound{round: 2}`。
- `proposed` 决定思路错了要重来：`Requeued{cause: Restart{restart: 1}}`。
- implement 里 agent 提问：`Advance{to: 'proposed'}`，`Proposal` 是 `InputNeeded`；没有 judge 时 route 给出 `WaitOnPerson{reason: AgentQuestion{…}}`。
- fix 轮次里 agent 跑完没提交：`WaitOnPerson{reason: FixerDisagrees{said}}`。
- merge 产出 `Integrated{mergeSha: m1}`：`Landed{integrated: m1}`。

**审视：保留，补上终态，替代 0120 草稿里的 `transitionOf` 和现在的 `outcomeOf`。** 上一版的 `GoToStep{to}` 只是目的地，conductor 要拿 `to` 和当前 step 比较才知道花了一轮，这正是原则 1 反对的"靠组合推出含义"。现在花了什么、是不是终态，都直接写在值里。"谁把票交给人"这条分类规则分在两处：`Escalated` 在 `decideRoute` 里生成，其余的在 `nextOf` 里生成。两个函数各有穷举测试，合起来覆盖 `WaitReason` 的每个变体。

---

## 5. `WaitReason`：为什么等你

**目的**：卡片、允许的处理、默认推荐、要不要跑 triage，全都由它决定。

```ts
type WaitReason =
  // 有人在问问题
  | { _tag: 'OwnQuestion'; question: string; by: string } // 人自己用 lingtai ask 提的
  | { _tag: 'AgentQuestion'; run: RunRef; step: Step; question: string }
  // 要人拍板
  | { _tag: 'SignoffRequired'; run: RunRef; step: Step; source: 'declared' | 'injected'; question: string }
  | { _tag: 'FixerDisagrees'; run: RunRef; step: Step; said: string | null }
  | { _tag: 'ProposedEscalated'; run: RunRef; proposal: Proposal; why: string }
  // 机器出了问题，没有人做过判断
  | {
      _tag: 'MergeRefused'
      run: RunRef
      reason: RefusalReason
      paths: string[] | null
      baseSha: string | null
      headSha: string | null
      afterApproval: boolean
      raw: string | null
    }
  | {
      _tag: 'BudgetExhausted'
      run: RunRef
      kind: 'out-of-turns' | 'out-of-usd'
      detail: string // runtime 自己说的停止原因，原样保留
      turns: number | null
      costUsd: number | null
    }
  | { _tag: 'AgentCrashed'; run: RunRef; step: Step; kind: 'crash' | 'timeout'; detail: string }
  | { _tag: 'SetupRefused'; run: RunRef; step: Step; lifts: 'by-itself' | 'person'; why: string }

type WaitKind = 'question' | 'decision' | 'fault'
const waitKind: (reason: WaitReason) => WaitKind // 派生，不存
```

**例子**：

- 测试修了 3 轮还是红的：`ProposedEscalated{proposal: BuildRed{from: 'build', …}}`
- agent 撞到 250 轮上限：`BudgetExhausted{kind: 'out-of-turns', turns: 251}`
- 有人批准了合并，合并仍然冲突：`MergeRefused{reason: 'conflict', afterApproval: true}`

**`waitKind` 分三类**，只给卡片文案和看板分组用，没有逻辑按它分支：

| `WaitKind` | 变体                                                              | 卡片上说     |
| ---------- | ----------------------------------------------------------------- | ------------ |
| `question` | `OwnQuestion`、`AgentQuestion`                                    | 有人在问你   |
| `decision` | `SignoffRequired`、`FixerDisagrees`、`ProposedEscalated`          | 要你拍板     |
| `fault`    | `MergeRefused`、`BudgetExhausted`、`AgentCrashed`、`SetupRefused` | 机器出了问题 |

`question` 单独一类，因为人面对它要做的是回答，不是在几个去向里选。评审建议在有行为按它分支之前不加；但 `waitKind` 本身只服务卡片文案，`decision` 和 `fault` 同样没有行为按它们分支，按那个标准三类都该删。卡片上"有人在问你"和"要你拍板"是两种不同的提示，所以保留。注意两种问题的回答方式不同：`OwnQuestion` 用 `AnswerQuestion`，`AgentQuestion` 用 `EditBodyAndRequeue`，因为 agent 只读得到正文（`prompt.ts:275`）。所以"能不能 `AnswerQuestion`"由 `allowedResolutions` 按变体决定，不按 `waitKind`。

**审视：三处调整。**

1. **已经是平的，只删分组 schema。** 日志里的 `Hold` 已经是一层 `_tag` 联合：`hold.ts:263` 把 `Judgement.options` 和 `Failure.options` 展开进去，没有 `{_tag: 'Failure', failure: …}` 这层包装。`Judgement`、`Failure` 只是构造时用的分组 schema，没有代码按它们分支，卡片文案改由 `waitKind` 派生（原则 3）。所以要做的只是：`Hold` → `WaitReason`、变体改名、删掉这两个分组 schema。变体名会写进日志（`WorkItemBlocked`），放进 0120 第二期那一次重置一起做。
2. **删掉 `CheckRed`。** 按方案 B，build 红了、轮次用完归 `ProposedEscalated{BuildRed}`；合并时的检查红了归 `MergeRefused{reason: 'verify-failed'}`。剩下没有地方会产生它，由 #452 确认后删除。
3. **`DidNotFinish` 拆开。** 现在一个变体装了崩溃和撞上限两种情况。两者的处理不同：崩溃一般重跑，撞上限要先把票拆小。所以撞上限归 `BudgetExhausted`，崩溃归 `AgentCrashed`，"选择不改"归 `FixerDisagrees`。

---

## 6. `Resolution`：这次等待怎么了结

**目的**：卡片上的按钮。由 `allowedResolutions(reason)` 决定有哪些，`recommendedResolution` 决定先推荐哪个。

```ts
type Resolution =
  | { _tag: 'Approve' } // 合进 main
  | { _tag: 'Requeue' } // 从 base 重新做
  | { _tag: 'EditBodyAndRequeue' } // 先改正文，再重新做
  | { _tag: 'AnswerQuestion'; choice: string } // 只对 OwnQuestion 有效
  | { _tag: 'Close' }

const allowedResolutions: (reason: WaitReason) => Resolution[]
const recommendedResolution: (reason: WaitReason, triage: TriageStatus) => Resolution | null
```

**例子**：`FixerDisagrees` 允许 `[Approve, Requeue, EditBodyAndRequeue, Close]`。Approve 表示站 fix agent 这边，EditBodyAndRequeue 表示站 reviewer 这边。

**审视：改名为 `Resolution`。** `Move` 只说"走一步"，看不出谁走、往哪走，还和 route、看板拖卡片撞词。`Resolution` 说的是这次等待怎么了结，每个变体都是结束等待的一种方式。另外 `BodyAndRequeue` 改为 `EditBodyAndRequeue`，让名字说清先做什么；`Answer` 改为 `AnswerQuestion`，它只对 `OwnQuestion` 有效。`Approve`、`Requeue`、`Close` 不变，和 CLI 命令、看板按钮同名。

---

## 7. Triage：agent 对等待原因的分析

**目的**：花钱请 agent 读等待原因，指出根本原因，推荐一个处理。它只给建议，不会移动票。

```ts
type RootCause =
  | { _tag: 'UndecidedQuestion'; questions: Question[] } // 票里有没定的问题
  | { _tag: 'FixableLines'; fixes: LineFix[] } // 改几行就好
  | { _tag: 'WrongApproach' } // 思路错了，要重来
  | { _tag: 'ConflictingHunks'; hunks: Hunk[]; total: number }
  | { _tag: 'TicketTooBig' } // 要拆票
  | { _tag: 'SetupBroken' }

type TriageResult =
  | { _tag: 'TriageFailed'; why: string }
  | { _tag: 'TriageAdvised'; cause: RootCause; resolution: Resolution; summary: string }

type TriageStatus =
  // 读取时推导，不存
  | { _tag: 'NotDeclared' }
  | { _tag: 'Queued' }
  | { _tag: 'Running' }
  | { _tag: 'Interrupted' }
  | { _tag: 'Done'; result: TriageResult }

const triageRuns: (reason: WaitReason) => boolean
```

**例子**：`MergeRefused{reason: 'conflict'}` 有 3 个冲突块，triage 返回 `TriageAdvised{cause: ConflictingHunks{hunks, total: 3}, resolution: Requeue}`。

**审视：保留，只改名。** `Cause` 的变体现在叫 `Decision`、`Lines`、`Narrower`，单独看不出意思，按原则 4 改成上面的名字。

---

## 8. 事件：日志里记什么

**目的**：上面的类型定了，记录它们的事件跟着重新定义。原则：**只记从日志算不出来的事实**。纯函数从已有事件能推出的结果不再单独存（原则 3）；取决于外界（命令、agent、judge、人）的结果必须存。

```ts
// 一步的开始和结束：每步一条，不再每个 action 一条
StepStarted { runId, step, round }
StepEnded { runId, outcome: StepOutcome }

// proposed 的选择：offer 取决于当时的 recipe 和已花预算，回答取决于 judge，重放时都算不出来，所以三者都存
PassRouted { runId, offer: RouteOffer, reply: JudgeReply, decision: RouteDecision }

// 等人和了结
WaitStarted { reason: WaitReason }
WaitResolved { by: string; resolution: Resolution; note: string }
WaitTriaged { … } // 只改名，形状不变
```

**替换关系**：

| 现在                                                                                                               | 改成                      | 理由                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `StepPassed`、`StepFailed`、`StepAsked`、`StepDidNotFinish`、`StepNeverRan`、`FixApplied`、`RunFailed{no-commits}` | `StepEnded`               | 第 1 节                                                                                                                                     |
| `StepStarted`（每个 action 一条，`events.ts:736`）                                                                 | `StepStarted`（每步一条） | 和 `StepEnded` 同一粒度                                                                                                                     |
| `FixRequested`、`PassRestarted`、`FixDeclined`                                                                     | `PassRouted`              | 分别是 `decision` 为 `Selected{next: FixRound}`、`Selected{next: Requeued{Restart}}`、`Escalated{CandidateUnavailable}`；轮次写在 `next` 里 |
| `WorkItemBlocked{hold}`                                                                                            | `WaitStarted`             | 旧名和 GitHub 的 _blocked by_（票之间的依赖）撞词；原则 5                                                                                   |
| `WorkItemUnblocked{by, note, withdrawn}`                                                                           | `WaitResolved`            | 一个事件，带 `Resolution`，不按了结方式各开一个事件                                                                                         |
| `ApprovalRequested`                                                                                                | 删除                      | 就是带 `SignoffRequested` 产出的 `StepEnded` 加 `WaitStarted{SignoffRequired}`                                                              |
| `ApprovalGranted`                                                                                                  | 删除                      | 就是 `WaitResolved{resolution: Approve}`                                                                                                    |
| `HoldTriaged`                                                                                                      | `WaitTriaged`             | 原则 5                                                                                                                                      |

**不记的**：`Advance` 不单独成事件，下一步的 `StepStarted` 已经说明走到哪了。`nextOf` 给出的其余结果（`WaitOnPerson`、`Requeued{NeverStarted}`、`Landed`）是 `StepEnded` 的纯函数，由各自已有的事件落地：`WaitStarted`、`WorkItemReleased`、`WorkItemLanded`。花预算的只有 `FixRound` 和 `Requeued{Restart}`，都只经由 `PassRouted` 出现，所以 `spentAfter` 只从 `PassRouted` 折叠。

**实现时核对**（没有逐行验证，不在这里假装定了）：

- `StepRequested`：和 `StepStarted` 同形状（`events.ts:735`），没有读者就删。
- `RepairRequested` / `RepairDeclined`：带旧的 `RefusalReason`，像是更早的修复机制，确认已不再产生就删。
- `ApprovalRevoked`：确认还有没有用处。
- `RunAwaitingInput`：和 `QuestionAsked` 产出可能重复。
- `WorkItemUnblocked.withdrawn`：确认它对应哪种 `Resolution`，还是需要保留成单独字段。
- `WorkItemLanded`、`WorkItemReleased`：确认它们的形状能承载 `Landed{integrated}` 和 `Requeued{cause}`。

**不动的**：其余约 50 个事件（WorkItem 的领取、释放和关闭，Run 的遥测，Conductor、Project、Discussion、Finding、Outbox 等）和这些类型无关。改形状要重置日志，所以和 `StepEnded` 一起属于 0120 第二期。

---

## 9. Seam：调用方看到什么

**目的**：上面第 1–4 节的函数都是一个 pass 内部的事，调用方不该一个一个去调。seam 只有两处，各有各的调用方。

```ts
// conductor：跑一个已领取的 pass，直到终态
const runPass: (command: { run: RunRef; item: ClaimedItemRef; recipe: ResolvedRecipe }) => Effect<PassEnd>
type PassEnd = Extract<PassNext, { _tag: 'Requeued' | 'WaitOnPerson' | 'Landed' }>

// CLI 和看板：了结一次等待
const resolveWait: (command: {
  item: WorkItemRef
  resolution: Resolution
  by: string
  note: string
}) => Effect<ResolveResult>
```

**`runPass` 返回时，终态已经落盘。** 调用方不再调 `proposalOf`、`offerFor`、`decideRoute`、`nextOf`、`spentAfter`，也不再用 `outcomeOf` 把结果翻译一遍，`PassEnd` 本身就是终态。这些函数是 `runPass` 内部的纯函数，单元测试直接测它们；它们的类型写在本文，是因为它们产出的值会写进日志。

**这个 seam 已经大体存在**：`conduct.ts` 解析 recipe、环境和 tier，然后把其余的交给 `runPass`，后者返回 `PassResult`，再由 `outcomeOf`（`pass.ts:1245`）映射成 landed / failed / blocked。要改的是返回值：`PassResult.stoppedAt` 加 `rested` 加 `outcomeOf` 三样，换成一个 `PassEnd`。

**`resolveWait` 是另一个调用方的事**：现在由 `approve.ts`、`close.ts` 等各自处理，按 `allowedResolutions` 校验，写一条 `WaitResolved`。把它和 `runPass` 放进同一个接口没有好处，跑 pass 的和处理等待的不是同一个调用方。

**查询不是 seam**：看板和 CLI 读的是投影（`task_view`），不调这两个函数。

---

## 第一性审视：结论

| 类型                                                                         | 结论                                                                                                             | 理由                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `StepEnding` + `FixOutcome` + `ActionOutcome`                                | **合并并拆开**：一步一条 `StepEnded`，带这一步的每个 `Action`；`Action` 的结果拆成 `execution` 和 `products`     | 修复轮次就是 implement 再跑一次；一步最多一个没通过，fold 不用挑；提交和提问可以同时发生（原则 7） |
| `Arrival` / `Arrived` / `ProposalReason`                                     | 改成相关联合 `Proposal`，每个变体写死 `from`，并加 `ReviewEmpty`                                                 | `{from, reason}` 能拼出不可能的组合；"没话说"和"弄丢了"要分开                                      |
| `Route` + `RouteDecision`（旧）+ `RouteBasis`                                | **删掉** `Route`、`RouteBasis`；新的 `RouteDecision` = `Selected` \| `Escalated`，judge 按候选 id 选             | `{next, basis}` 是允许非法组合的笛卡尔积；上限在 `offerFor` 里算完                                 |
| `transitionOf`、`outcomeOf` 的结果                                           | **替换**为 `PassNext`（`Advance`、`FixRound`、`Requeued`、`WaitOnPerson`、`Landed`）；`nextOf` 不产出 `FixRound` | 下一步和终态只有这一个类型，花了什么写在值里；重开就是重新排队                                     |
| `Hold` / `HoldTriaged` / `Held`                                              | **改名**为 `WaitReason` / `WaitTriaged` / `Waiting`                                                              | 和看板的 _Waiting on you_ 列对上；hold 只留给 `agent:hold`                                         |
| `Judgement`、`Failure` 分组 schema                                           | **删除**，卡片分类由 `waitKind` 派生                                                                             | 日志里已经是平的，没有代码按分组分支                                                               |
| `CheckRed`                                                                   | **删除**（等 #452 确认）                                                                                         | 方案 B 之后没有地方会产生它                                                                        |
| `DidNotFinish`                                                               | **拆开**为 `AgentCrashed` / `BudgetExhausted` / `FixerDisagrees`                                                 | 三种情况，三种不同的处理                                                                           |
| `Move`                                                                       | **改名**为 `Resolution`，变体 `EditBodyAndRequeue`、`AnswerQuestion`                                             | 名字要说清是"等待怎么了结"，不和 route 撞词                                                        |
| `Step*`、`Fix*`、`PassRestarted`、`WorkItemBlocked`/`Unblocked`、`Approval*` | **重新定义**为 `StepStarted`/`StepEnded`、`PassRouted`、`WaitStarted`/`WaitResolved`（第 8 节）                  | 只记从日志算不出来的事实                                                                           |
| `TriageResult`、`TriageStatus`                                               | 保留                                                                                                             | 已经是该有的形状                                                                                   |
| `Cause`                                                                      | 保留，改名为 `RootCause`，变体也改名                                                                             | 现在的名字单独看不出意思                                                                           |

## 待你决定

暂无。新的问题出现时加在这里。
