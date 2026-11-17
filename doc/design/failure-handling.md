# 失败怎么处理：方案（讨论稿）

2026-11-17 起草，operator 与 Claude 逐条讨论中。依据：ADR [0108](../decisions/0108-a-refusal-buys-a-round.md)、[0118](../decisions/0118-a-hold-explains-itself.md) §12、`packages/domain/src/wait.ts` 里 triage 的六种原因，以及 #1201、#1205 两张票的教训。

全部定下来之后，改写进 0108（失败与恢复）和 0118（triage 与拆票），再切票。
每条后面标着 **（已定）** 或 **【待定】**；【待定】的内容是目前的建议，还要 operator 确认。

---

## 一、原则

1. **机器处理是默认，人是兜底。**（已定）机器能处理的都交给机器。人只在两种情况介入：
   - **防止死循环**：程序必须有出口、会终止，并且留下结束标识，不能无休止地循环下去。出口就是第 5 条的上限。
   - **需求本身不清楚**：只有人能回答。
2. **triage 只给建议，不动手；系统读它的建议去执行。**（已定）以前 triage 的建议写给人看，人照着去点按钮；现在改成系统照着去点。triage 只调用一次，给出一个结构化回答：机器读 `action`，人读 `summary`，页面直接显示这个回答（格式见第六节）。
3. **从已经提交的东西接着做。**（已定）失败不扔掉已有的 commit。只有判定方向错了，才从 base 重来。
4. **没提交的丢了很正常。**（已定）不为保住没提交的东西写复杂逻辑；丢了顶多再多一轮修复，花不了多少 token。唯一的例外是 implement 的 agent 异常退出时留下的代码，由灵台替它提交（第三节）。
5. **每条自动路径都有上限**，用完才交给人。（已定）这就是第 1 条里"程序必须有出口"的落实：每条路径都有计数和上限，用完时留下结束标识，写明是哪个上限、用了几次。
6. **开票时把不了关，所以在 design 阶段把关。**（已定）票可能是人在 GitHub 上手工开的，系统现在也没有开票功能，开票时的质量我们限制不了。所以：
   - **design 阶段是系统唯一能把关的地方**：发现业务规则不清楚，就提问，进 Waiting 页面等人回答（`AgentQuestion`，#649）。
   - **系统自己开的票**（自动拆出来的子票，以及以后 0.18 在看板上生成的票）**必须按 write-ticket 的规范写**。
   - 失败处理只管怎么恢复，不负责替票补需求。

---

## 二、处理分三层

```
失败
 │
 ├─ 第一层：规则（不花钱，不跑 agent）
 │    认得出是什么错，就按规则直接处理：瞬时错误、flaky、base 红、base 动了、push 失败……
 │
 ├─ 第二层：triage（判断一次，花少量钱）
 │    规则答不了的，交给 triage 判断原因；系统按原因自动执行对应的动作（第六节）
 │
 └─ 第三层：人
      只在上限用完，或者需求不清楚 / 环境坏了的时候
```

---

## 三、WIP 的定义（已定）

> **WIP 只有一种来源：implement 这一步的 agent（首次实现，或修复轮里的 fixer）异常结束或撞到上限时，worktree 里还没提交的代码。灵台把它作为一个普通 commit 直接提交到这个 attempt 的工作分支 `agent/<n>`，再 push。**

- **会产生 WIP 的情况**：crash、timeout、turns 用完、`usd` 用完，以及 agent 还在跑时 pass 被停掉（`interrupted`）。
- **不产生 WIP 的情况**：
  - design、review、merge 这几步：它们不写代码。现在的代码也只在 implement 里设置 `stoppedBy`（`conduct.ts:4684-4812`、`4931-5085`）。
  - **冲突轮**：重做时会重新 merge，重新拿到冲突标记，存下来没有意义。
  - **`no-commits`**：agent 正常结束，只是一个 commit 都没提交。这不算异常，也没有可存的信息。
  - agent 根本没启动（never-started）：它什么都没碰过。
- **内容**：`git add -A` 能收进去的改动，不包括被 `.gitignore` 忽略的文件，也不包括种进去的 env 文件。commit message 用固定前缀，例如 `wip: implement cut off by <原因>`。日志里记一条 `RunKeptUncommitted`。
- **为什么直接提交到工作分支，不再另放 arm**：
  - lane 原本拒绝带 `wip:` commit 的分支（`packages/repo/src/integrate.ts:520-536`），理由是"做到一半的 commit 不能落到 main"。现在落地的永远是 build 和 review 检查过的那个 head（#1209）。
  - implement 本来就要求分块提交，agent 自己的中间 commit 也不保证每个都能编译通过，WIP commit 和它们没区别。
  - lane 用 merge commit 合进 main，main 的 first-parent 链上每个点都是检查过的。
- **配套要改的**：
  - 删掉 lane 的 `wip-commit` 拒绝。
  - implement 判断"有没有产出 commit"时，**不算灵台自己提交的 WIP commit**（按 message 前缀识别）。
  - `keepUncommittedWork` 改为提交到工作分支，冲突轮和 `no-commits` 时不提交。
  - **删掉 #1170**（把 WIP 打到下一个 attempt 的新 worktree 上）。同一个 attempt 内重做时直接从 head 接着做，换 attempt 只剩 S（方向错了），而 S 不该带上旧改动，所以它已经用不上了。

---

## 三点五、implement 的五种结果（已定 2026-11-17）

agent 在最终回答里**明确声明**属于哪一种，系统再核对一次：**有 commit 就算成功**（灵台提交的 WIP commit 不算），直接进 build，做得对不对交给 build 和 review 去查；**零提交时按 agent 声明的类型处理**；没有声明，或者声明成功却零提交，都按 agent 异常处理。

| 类型 | 意思 | 判定 | 下一步 |
|---|---|---|---|
| **成功** `Implemented` | 做完了 | 正常结束，有至少 1 个 agent 自己的 commit | 直接进 build（不经过路由） |
| **agent 异常** `AgentFailed` | 没做完 | 崩溃、超时、turns/`usd` 用完、被打断、没有回执；或者零提交、又没说明原因 | 灵台把 WIP 作为 commit 提交到工作分支 → **R** |
| **有异议** `Disputed` | 修复轮里 fixer 认为 finding 不成立 | 零提交，说明不同意哪条、为什么 | 路由（`fixer-disagrees`）→ judge 裁定：fixer 对 → 这条 finding 作废并记进 backlog，往下走；reviewer 对 → 带着 judge 的理由走 **F** |
| **票已实现** `AlreadyDone` | 要做的事 base 上已经有了 | 零提交，逐条说明每项 Done when 由什么满足 | 路由（新原因 `already-done`）→ 不走 build/review/merge，直接到 end，终态记为 **已实现（`satisfied`）**。拆过票的母票（所有子票都已落地）由系统自动关闭；其他情况（重复票、被别的票顺手修了）交给人确认后再关 |
| **需求不明确** `Unclear` | 照着票写的做不下去 | 零提交，按下面的格式列出问题 | 路由（`needs-input`，现有的 `InputNeeded{from: 'implement'}`）→ **H**（unclear）→ 人回答，答案写进正文 → **R** |

**票的终态因此有三种**：`landed`（合进 main）、`satisfied`（已实现，这次没有合入代码）、被人 `Close`。

### 需求不明确时的输出格式（已定）

design 阶段提问（`agent-action.ts:1407-1440`）、implement 声明 `Unclear`、triage 判定 `UndecidedQuestion`，这三处统一用同一个格式，也就是现在 triage 的 `TriageQuestion`（`packages/domain/src/triage.ts`）：

```
questions: 最多 5 个
  - id
    text:        一句话问题
    answers:     2–4 个选项，每个 {id, text}，text 写明选了它会怎么做
    recommended: 推荐的那个选项的 id
```

页面把问题按 1、2、3 列出来，每个问题下列选项，推荐项排第一、带标记，人也可以不选选项、自己写答案。回答完，系统把"问题 → 答案"写进正文的一个固定小节，然后重做这一步。这些现有的 triage 已经在做（`triageAnswersText`，#921），三处只是共用它。

### implement 之后怎么走：不需要新加一步（已定）

现在的流程是：
- **成功**：implement 之后直接进 build → review → proposed。
- **不成功**：带着原因（`when:`）先到 `proposed` 的路由，由路由决定去哪（`packages/domain/src/proposal.ts` 的 `JudgeWhen`，十四种原因）。`nothing-produced`、`fixer-disagrees`、`needs-input` 现在已经这样走。

所以不用新加一步，只需要：
1. 把五种结果对应到路由的原因：`Disputed` → `fixer-disagrees`（已有）；`Unclear` → `needs-input`（已有）；`AlreadyDone` → 新加 `already-done`；`AgentFailed` 由规则直接处理成 R，不经过路由；`nothing-produced` 去掉，并入 `AgentFailed`。
2. 路由加一个新去向 **end（以 `satisfied` 关闭）**：不走 build、review、merge，直接到 end。

## 四、五个处理动作

所有失败最后都落到这五个动作之一。

| 动作 | 做什么 | 从哪里出发 | 计入哪个上限 |
|---|---|---|---|
| **R 重做这一步** | 只重做出错的这一步，不重走整个流程 | 工作分支的 head，包括灵台提交的 WIP commit。其他没提交的改动丢掉（复位到 head） | `TRANSIENT_RETRIES_LIMIT`（每个 attempt 3 次） |
| **F 修复轮** | 带着拒绝的证据（findings、命令输出、冲突文件）回到 implement 去修，修完再走 build 和 review | 同一个 worktree，当前 head | `rounds`；冲突轮单独计数 |
| **S 从头重来** | 方向错了，开一个新 attempt | base。旧方案推到 arm 分支留档，旧改动一律不带 | `restarts` |
| **P 拆票** | 票太大：开子票，用 blocked-by 串起来；母票按方案关闭，或等子票落地后重做 | 子票从 base 开始；母票重做时也从 base 开始 | 只拆一层 |
| **H 交给人** | 停在 Waiting 页面，页面显示 triage 的回答，或者是哪个上限用完了 | — | — |

**R 的细节**（已定）：
- 这一步从第一个动作开始重跑，不从"被打断的那个动作"接着跑。#1201 里那套逻辑（`ranBefore`、按动作区分的重跑标记、`startedAt`/`fixDiffSeen`）要换掉。
- agent 的 brief 末尾加一段：

  > 这一步被打断过（原因）。这一步开始时在 `<起点>`，现在已经提交到 `<head>`，其中包括灵台替你保存的未完成改动（如果有）。接着做，已经提交的不要重做。

- review 也走 R，但不加这段说明：review 只读已经提交的东西，不会丢任何东西。
- implement 判断"有没有产出 commit"时，拿这一步**最初**开始时的 sha 来比，并且不算 WIP commit。
- **implement 的 brief 要求分块提交**：每完成一块能跑通的部分就提交一次，被打断时丢得最少。
- 触发 R 的入口有三个：瞬时错误和普通崩溃（自动）；wall/turns 用完时 triage 判断"只是没做完"（自动）；人在页面上点"在保存的工作上重跑这一步"（#1218、#1219，改成走 R）。

---

## 五、失败分六类

### 第 1 类：Lingtai 自己或环境的问题（这时还没有 agent 在跑）

| 情况 | 处理 |
|---|---|
| recipe 解析不了、没配 App、数据库连不上 | 认领之前就挡掉，不认领、不花钱（0108 §1） |
| prepared 失败，原因是瞬时错误（registry 5xx） | 规则 → **R** |
| prepared 失败，其他原因 | triage 判定 `SetupBroken` → **H**（environment） |
| agent 根本没启动（账户额度用完） | 规则：锁住这个账户，额度重置后自动解锁；解锁后从保存的 head 接着做（#1205） |

### 第 2 类：一步没跑完（agent 退出了）

| 情况 | 处理 |
|---|---|
| 瞬时 API 错误（5xx、529、429、Cloudflare） | 规则 → **R** |
| 不认识的崩溃、没有回执 | 规则 → **R** |
| 回答读不懂 | 规则 → **R**（不再单独记"重问一次"，并入 R 的上限） |
| wall 或 turns 用完 | triage：`TicketTooBig` 并附拆票方案 → **P**；`TicketTooBig` 没有方案 → 把耗时点写进正文，然后 **R**（算进 `rounds`）；只是没做完 → **R**（算进 `rounds`） |
| R 的次数用完 | **H**（limit） |

### 第 3 类：对代码的判断不通过

| 情况 | 处理 |
|---|---|
| build 红 | 规则：先重跑一次（§17）；红了又绿，且满足 flaky 的三个条件 → 放行，在 backlog 记一条 minor。base 上也红 → 放回队列，保留 head（§13）。否则 → **F** |
| review 有 findings | triage：`FixableLines` → **F**；`WrongApproach` → **S** |
| review 的 diff 太大，读不完 | triage：`TicketTooBig` 并附方案 → **P**；否则 → **H** |
| 修复轮没有提交（fixer 不同意 reviewer） | judge 裁定：fixer 对 → 放行，在 backlog 记一条；reviewer 对 → **F** |
| implement 第一次就没产出 commit | judge：票写得不清楚 → **H**（unclear）；只是没做完 → **R** |
| 合并冲突 | triage `ConflictingHunks`：冲突块少（≤5）→ **F**（冲突轮）；冲突块多且两边逻辑矛盾 → **S**；有只能由人判断的冲突块 → **H** |
| `rounds` 用完 | **H**（limit）；triage 判定 `WrongApproach` → **S** |

### 第 4 类：票本身的问题

| 情况 | 处理 |
|---|---|
| design 阶段提问（`AgentQuestion`） | **H**（unclear） |
| triage 判定 `UndecidedQuestion` | **H**（unclear） |
| triage 判定 `TicketTooBig` | **P** |
| triage 判定 `WrongApproach` | **S** |

### 第 5 类：落地时的问题

| 情况 | 处理 |
|---|---|
| base 动了 | 规则：把 base 合进来，重新 build；只有 base 的改动碰到分支改过的文件，review 才重新做（#1210）。每个 attempt 最多 10 次 |
| push 遇到瞬时错误 | 规则：从保存的 head 重新落地（#1221），计入 `TRANSIENT_RETRIES_LIMIT` |
| push 被拒且重试也没用 | **H**（environment） |
| 分支已经不在了 | **S** |

### 第 6 类：triage 自己失败

| 情况 | 处理 |
|---|---|
| triage 崩溃，或回答读不懂 | 规则：再问一次 |
| 还是失败 | **H**，页面写明"triage 没有给出建议" |

---

## 六、triage 的回答 → 系统执行的动作（已定）

### 回答的格式

```
action:  R | F | S | P | H
cause:   triage 判断的原因（现有六种之一）
附带的内容：
  R  →  正文要补的一句（可选，比如"turns 主要耗在 X 上"）
  F  →  要改的行：[{path, line, what}]
  S  →  一句话：旧方案哪里错了（写进下一个 attempt 的 brief）
  P  →  拆票方案：子票列表，以及母票还有没有剩余部分
  H  →  unclear（问题和选项） | environment（哪里坏了、怎么修）
summary: 给人读的一句话
```

- **页面直接读这个回答。** H 时，按种类显示"需要你做什么"：unclear 显示问题和选项，人在页面上作答，答案写进正文后接着跑；environment 显示哪里坏了、用什么命令修。R、F、S、P 时，页面只显示一行"系统做了什么、为什么"，不开 wait。
- **上限用完导致的 H 由系统给出，不来自 triage**：`limit`，写明是哪个上限、用了几次。
- **`Approve`（跳过拒绝直接落地）和 `Close`（关票）只留给人**，不在 triage 能选的动作里。
- 所有自动执行都在日志里记成 `by: triage`。

### 原因 → 动作

| triage 判断的原因 | 系统执行 | 前提 | 前提不满足时 |
|---|---|---|---|
| `FixableLines` | **F** | 还有 `rounds` | **H**（limit） |
| `WrongApproach` | **S** | 还有 `restarts` | **H**（limit） |
| `TicketTooBig` 并附拆票方案 | **P** | 这张票本身不是自动拆出来的 | **H**（limit） |
| `TicketTooBig` 没有方案 | 把耗时点写进正文，然后 **R** | 还有 `rounds` | **H**（limit） |
| `ConflictingHunks` | 冲突块少 **F**，多 **S** | 没有只能由人判断的冲突块 | **H**（unclear） |
| `SetupBroken` | **H**（environment） | — | — |
| `UndecidedQuestion` | **H**（unclear） | — | — |

---

## 七、拆票（P）

1. triage 写拆票方案：最多 8 张子票，每张有标题、正文、kind，以及子票之间的先后关系。
2. 系统直接开票，**不加 `agent:hold`**，用 blocked-by 串起来，子票按顺序进队列。写入过程沿用 0118 §12 已经做好的部分（标记、对账、中断后可以重试）。
3. **母票一律放回队列，等子票全部落地后再做一次。**（已定）母票被所有子票 blocked-by，子票没落地之前队列会一直跳过它。等它再被取出来，这次 attempt 从 base 开始（此时 base 已经包含所有子票），只做两件事：
   - **验收**：对照母票正文的 Done when，逐条检查是否已经满足。
   - **补完**：子票没覆盖到的部分，在这次 attempt 里做掉。

   如果验收通过、也没有剩下的事，agent 不提交任何东西，只说明每条 Done when 由哪张子票满足。系统据此关闭母票，不走 merge。这种情况不当作 `nothing-produced` 去问 judge。【待定】这条"拆过票的母票零提交 = 验收通过"的规则需要确认。
4. **只拆一层**：自动拆出来的子票如果又被判定 `TicketTooBig` → **H**，不再自动拆。
5. 子票必须按 write-ticket 的规范写（原则 6）。现在 triage 写的子票还达不到，0.18.0 会把同一套写票能力用到这里。

---

## 八、上限（防止死循环）

| 上限 | 管什么 | 现在 | 建议 |
|---|---|---|---|
| `TRANSIENT_RETRIES_LIMIT` | R：每个 attempt 的重做次数（瞬时错误、崩溃、没有回执、回答读不懂） | 3 | 3 |
| `rounds` | F：修复轮；wall/turns 用完后"接着做"，按 attempt 计 | 4 | **6**（已定） |
| 冲突轮 | 按 attempt 单独计数 | 同 `rounds` | 同 `rounds` |
| `BASE_MERGES_LIMIT` | base 动了之后的合并，按 attempt 计 | 10 | 10 |
| `restarts` | S：从头重来，按票计 | 2 | 2 |
| 拆票层数 | P | — | 1 |

**调到 6 的依据**：最近 7 天 lingtai 落地 228 张票，0 到 1 轮修完的占 79%，5 轮以上的占 4%（只看 feature 票是 13%）。按"第几次 review 通过"统计：第 4 次 review 时 16 张过了 8 张，第 5 次时 8 张过了 1 张。人工额外给轮的票里，#1170、#1177 都是多给 1 轮就过了。调到 6，能覆盖"再给一两轮就能过"的那批票；受影响的约 4%，每张多花大约 $1–2。

---

## 九、和现在相比要改的地方

| # | 改动 | 涉及 |
|---|---|---|
| 1 | WIP 直接提交到工作分支；冲突轮和 `no-commits` 不提交；删掉 lane 的 `wip-commit` 拒绝；判断"有没有产出"时不算 WIP commit | `conduct.ts` 的 `keepUncommittedWork`，`integrate.ts`，0108 |
| 2 | 删掉 #1170 的 WIP 携带 | `carry-wip-port.ts`，`conduct.ts` 的 `cut` |
| 3 | R 统一成一个工作流：从 head 整步重跑，brief 加说明；去掉 #1201 那套从被打断的动作接着跑 | 0108 §12，`run-attempt.ts`，`action.ts` |
| 4 | 不认识的崩溃、没有回执、回答读不懂都走 R；#1205 的 `askedAgainOn` 随之删掉 | 0108 §12、§18，`attempt.ts` |
| 5 | implement 的 brief 要求分块提交 | implement 的 prompt |
| 6 | triage 的回答改成第六节的格式；系统按原因自动执行，记成 `by: triage` | 0108 §16，0118，`wait.ts`，triage 的 prompt |
| 7 | wall/turns 用完时交给 triage，由它判断拆票还是接着做 | 0108 §12 |
| 8 | 自动拆票，只拆一层，母票按方案处理 | 0118 §12 |
| 9 | `rounds` 从 4 调到 6 | 本机 recipe（只改配置） |
| 10 | #1218、#1219（人在页面上点"重跑这一步"）改成走 R | 0.15.0 里已有的票，改正文 |
| 11 | write-ticket 的 Edges 清单、design 的提问清单都加上"一个动作被重做或跳过时，同一步里的其他动作怎么办" | write-ticket skill，`agent-action.ts:1398-1405` |

---

## 十、已定与待定

- 母票一律放回队列；子票全部落地后，母票做验收并补完剩下的部分。（已定）
- `rounds` 从 4 调到 6。（已定）
- **R 的触发范围**：只有"这一步本身没做完"（第 2 类：agent 崩溃、超时、turns 用完、没有回执、回答读不懂）才走 R。"这一步做完了但结论是不通过"（第 3 类：build 红、review 有 findings）走修复轮 F，不走 R。（已定）
- 【待定】拆过票的母票零提交 = 验收通过，关闭母票、不走 merge。
