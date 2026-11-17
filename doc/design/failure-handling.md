# 失败怎么处理：方案（讨论稿）

2026-11-17 起草，operator 与 Claude 逐条讨论定下。依据：ADR [0108](../decisions/0108-a-refusal-buys-a-round.md)、[0118](../decisions/0118-a-hold-explains-itself.md) §12、`packages/domain/src/wait.ts` 里 triage 的六种原因，以及 #1201、#1205 两张票的教训。

全部定下来之后，改写进 0108（失败与恢复）和 0118（triage 与拆票），再切票。
标 **（已定）** 的是讨论定下的；标 **【待定】** 的是还要 operator 确认的建议。

---

## 零、术语表

全文、以后的 ADR、代码、日志、看板都只用下面这些词。一个词只指一件事；意义不同的两件事，即使数值或做法相同，也用两个词。

**对象**

| 词 | 意思 |
|---|---|
| attempt | 对一张票的一次尝试：一个 worktree、一条工作分支 `agent/<n>`，从 claim 走到 end。不叫 pass |
| step | attempt 里的十步之一：claim、admit、prepared、design、implement、build、review、proposed、merge、end |
| run | 一次 agent 运行（一次 dispatch） |
| base | 票要合进去的分支（`main`）的某个 commit |
| head | 工作分支当前最新的 commit |
| WIP | implement 的 agent 异常结束时还没提交的代码，由灵台替它提交成一个 commit（第三节） |

**动作**（第五节）：失败后系统做的事，一共六个，加三个由规则直接执行的。

| 词 | 中文 | 出发点 |
|---|---|---|
| `redo` | 重做这一步 | ↻ 当前 attempt 里重做 |
| `fix` | 修复 | ➡ 接着往下做 |
| `conflictFix` | 解冲突 | ➡ 接着往下做 |
| `startOver` | 从头重来 | ⟲ 从 base 重来 |
| `split` | 拆票 | ⟲ 从 base 重来 |
| `toPerson` | 交给人 | — |
| `checkRerun` | 检查红了立刻再跑（规则） | ↻ 当前 attempt 里重做 |
| `baseMerge` | base 动了合并进来（规则） | ➡ 接着往下做 |
| `landRetry` | 重新落地（规则） | ➡ 接着往下做 |

**出发点**：
- **➡ 接着往下做**：同一个 attempt，从当前 head 往前走，已有的 commit 都保留，再加新的。
- **↻ 当前 attempt 里重做**：同一个 attempt，把同一件事（一步或一次检查）原样再做一遍，起点还是当前 head。
- **⟲ 从 base 重来**：开新的 attempt，从 base 开始，旧的改动不带。

**上限**（第九节）：每个动作有自己的上限，名字是动作的复数：`redos`、`fixes`、`conflictFixes`、`startOvers`、`splitDepth`、`checkReruns`、`baseMerges`、`landRetries`。

**implement 的结果**（第四节）：`Implemented`、`AgentFailed`、`Disputed`、`AlreadyDone`、`Unclear`。

**`toPerson` 的三种**：`unclear`（需求不清楚）、`environment`（环境坏了）、`limit`（某个上限用完了）。

**票的终态**：`landed`（合进 main）、`satisfied`（已实现，这次没有合入代码）、被人 `Close`。

---

## 一、原则

1. **机器处理是默认，人是兜底。**（已定）机器能处理的都交给机器。人只在两种情况介入：
   - **防止死循环**：程序必须有出口、会终止，并且留下结束标识。出口就是第 5 条的上限。
   - **需求本身不清楚**：只有人能回答。
2. **triage 只给建议，不动手；系统读它的建议去执行。**（已定）以前 triage 的建议写给人看，人照着去点按钮；现在系统照着去点。triage 只调用一次，给出一个结构化回答：机器读 `action`，人读 `summary`，页面直接显示这个回答（第七节）。
3. **从已经提交的东西接着做。**（已定）失败不扔掉已有的 commit。只有判定方向错了，才从 base 重来。
4. **没提交的丢了很正常。**（已定）不为保住没提交的东西写复杂逻辑；丢了顶多多 `redo` 一次，花不了多少 token。唯一的例外是 implement 的 agent 异常结束时留下的代码，由灵台替它提交（第三节）。
5. **每条自动路径都有上限**，用完才交给人。（已定）这是第 1 条"程序必须有出口"的落实：每条路径都有计数和上限，用完时留下结束标识，写明是哪个上限、用了几次（`toPerson` 的 `limit`）。
6. **开票时把不了关，所以在 design 阶段把关。**（已定）票可能是人在 GitHub 上手工开的，系统现在也没有开票功能，开票时的质量我们限制不了。所以：
   - **design 阶段是系统唯一能把关的地方**：发现业务规则不清楚，就提问，进 Waiting 页面等人回答（`AgentQuestion`，#649）。
   - **系统自己开的票**（`split` 出来的子票，以及以后 0.18 在看板上生成的票）**必须按 write-ticket 的规范写**。
   - 失败处理只管怎么恢复，不替票补需求。

---

## 二、处理分三层（已定）

```
失败
 │
 ├─ 第一层：规则（不花钱，不跑 agent）
 │    认得出是什么错，就按规则直接处理：瞬时错误、flaky、base 红、base 动了、push 失败……
 │
 ├─ 第二层：triage（判断一次，花少量钱）
 │    规则答不了的，交给 triage 判断原因；系统按原因自动执行对应的动作（第七节）
 │
 └─ 第三层：人（toPerson）
      只在上限用完（limit）、需求不清楚（unclear）、环境坏了（environment）的时候
```

---

## 三、WIP（已定）

> **WIP 只有一种来源：implement 这一步的 agent（首次实现，或 `fix` 里的 fixer）异常结束时，worktree 里还没提交的代码。灵台把它作为一个普通 commit 直接提交到这个 attempt 的工作分支 `agent/<n>`，再 push。**

- **异常结束指**：crash、timeout、`run.turns` 或 `run.usd` 用完，以及 agent 还在跑时 attempt 被停掉（`interrupted`）。
- **不产生 WIP 的情况**：
  - design、review、merge：它们不写代码。现在的代码也只在 implement 里设置 `stoppedBy`（`conduct.ts:4684-4812`、`4931-5085`）。
  - `conflictFix`：再做时会重新 merge、重新拿到冲突标记，存下来没有意义。
  - agent 正常结束但零提交：不算异常，按 agent 声明的类型处理（第四节）。
  - agent 根本没启动（never-started）：它什么都没碰。
- **内容**：`git add -A` 能收进去的改动，不包括被 `.gitignore` 忽略的文件，也不包括种进去的 env 文件。commit message 用固定前缀，例如 `wip: implement cut off by <原因>`。日志里记一条 `RunKeptUncommitted`。
- **为什么直接提交到工作分支，不再另放 arm**：
  - lane 原本拒绝带 `wip:` commit 的分支（`packages/repo/src/integrate.ts:520-536`），理由是"做到一半的 commit 不能落到 main"。现在落地的永远是 build 和 review 检查过的那个 head（#1209）。
  - implement 要求分块提交，agent 自己的中间 commit 也不保证每个都能编译，WIP commit 和它们没区别。
  - lane 用 merge commit 合进 main，main 的 first-parent 链上每个点都是检查过的。
- **配套要改的**：删掉 lane 的 `wip-commit` 拒绝；判断"有没有产出 commit"时不算 WIP commit（按 message 前缀识别）；`keepUncommittedWork` 改为提交到工作分支，`conflictFix` 和零提交时不提交；**删掉 #1170**（把 WIP 打到下一个 attempt 的新 worktree 上）：同一个 attempt 里 `redo` 直接从 head 做，换 attempt 只剩 `startOver`，而 `startOver` 不该带旧改动。

---

## 四、implement 的五种结果（已定）

agent 在最终回答里**明确声明**属于哪一种，系统再核对一次：**有 commit 就算 `Implemented`**（WIP commit 不算），直接进 build，做得对不对交给 build 和 review；**零提交时按 agent 声明的类型处理**；没有声明，或者声明 `Implemented` 却零提交，按 `AgentFailed` 处理。

| 结果 | 意思 | 判定 | 下一步 |
|---|---|---|---|
| `Implemented` | 做完了 | 正常结束，有至少 1 个 agent 自己的 commit | 直接进 build，不经过路由 |
| `AgentFailed` | 没做完 | 异常结束（第三节）；或零提交又没说明原因 | 有 WIP 就提交 → `redo` |
| `Disputed` | `fix` 里的 fixer 认为 finding 不成立 | 零提交，说明不同意哪条、为什么 | 路由（`fixer-disagrees`）→ judge 裁定：fixer 对 → 这条 finding 作废并记进 backlog，往下走；reviewer 对 → 带着 judge 的理由再 `fix` |
| `AlreadyDone` | 要做的事 base 上已经有了 | 零提交，逐条说明每项 Done when 由什么满足 | 路由（新原因 `already-done`）→ 不走 build、review、merge，直接到 end，终态 `satisfied`。`split` 过的母票（子票全部落地）由系统自动关闭；其他情况（重复票、被别的票顺手修了）交给人确认后再关 |
| `Unclear` | 照着票写的做不下去 | 零提交，按下面的格式列出问题 | 路由（`needs-input`，现有的 `InputNeeded{from: 'implement'}`）→ `toPerson`（unclear）→ 人回答，答案写进正文 → `redo` |

### 提问的格式（已定）

design 阶段提问（`agent-action.ts:1407-1440`）、implement 的 `Unclear`、triage 的 `UndecidedQuestion`，三处统一用 triage 现有的 `TriageQuestion`（`packages/domain/src/triage.ts`）：

```
questions: 最多 5 个
  - id
    text:        一句话问题
    answers:     2–4 个选项，每个 {id, text}，text 写明选了它会怎么做
    recommended: 推荐的那个选项的 id
```

页面把问题按 1、2、3 列出来，每个问题下列选项，推荐项排第一、带标记；人也可以不选、自己写答案。回答完，系统把"问题 → 答案"写进正文的一个固定小节（`triageAnswersText`，#921），然后 `redo` 这一步。

### implement 之后怎么走：沿用现有路由，不加新步骤（已定）

- `Implemented`：implement → build → review → proposed，跟现在一样。
- 其余结果：带着原因（`when:`）到 `proposed` 的路由（`packages/domain/src/proposal.ts` 的 `JudgeWhen`）。`Disputed` → `fixer-disagrees`（已有）；`Unclear` → `needs-input`（已有）；`AlreadyDone` → 新加 `already-done`；`AgentFailed` 由规则直接 `redo`，不经过路由。现有的 `nothing-produced` 去掉，并入 `AgentFailed`。
- 路由加一个新去向：**end，以 `satisfied` 关闭**，不走 build、review、merge。

---

## 五、六个动作（已定）

所有失败最后都落到这六个动作之一。名字和第九节的上限一一对应。

| 动作 | 做什么 | 出发点 | 上限 |
|---|---|---|---|
| **`redo`** 重做这一步 | 只重做出错的这一步，不重走整个流程 | ↻ 工作分支的 head（含 WIP commit），其他没提交的改动丢掉 | `redos` |
| **`fix`** 修复 | build 红、review 有 findings：带着证据（命令输出、findings）回 implement，在当前 head 上修，修完再走 build 和 review | ➡ 同一个 worktree，当前 head | `fixes` |
| **`conflictFix`** 解冲突 | 合并冲突：带着冲突文件回 implement，在当前 head 上重新 merge、把冲突解掉，再走 build 和 review | ➡ 当前 head | `conflictFixes` |
| **`startOver`** 从头重来 | 方向错了，开一个新 attempt | ⟲ base；旧方案推到 arm 分支留档，旧改动一律不带 | `startOvers` |
| **`split`** 拆票 | 票太大：开子票，用 blocked-by 串起来；母票放回队列，等子票全部落地后验收并补完（第八节） | ⟲ 子票和母票都从 base 开始 | `splitDepth` |
| **`toPerson`** 交给人 | 停在 Waiting 页面，按 `unclear`、`environment`、`limit` 显示需要人做什么 | — | — |

`fix` 和 `conflictFix` 做法一样（回 implement 在 head 上改），但起因和证据不同，所以是两个动作、两个上限。

另外三个**由规则直接执行**，不经过 triage：`checkRerun`（`checkReruns`）、`baseMerge`（`baseMerges`）、`landRetry`（`landRetries`）。

### `redo` 的细节（已定）

- 这一步从第一个动作开始重跑，不从"被打断的那个动作"接着跑。#1201 里那套逻辑（`ranBefore`、按动作区分的重跑标记、`startedAt`/`fixDiffSeen`）要换掉。
- agent 的 brief 末尾加一段：

  > 这一步被打断过（原因）。这一步开始时在 `<起点>`，现在已经提交到 `<head>`，其中包括灵台替你保存的未完成改动（如果有）。接着做，已经提交的不要重做。

- review 也走 `redo`，但不加这段说明：review 只读已提交的东西，没有什么会丢。
- implement 判断"有没有产出 commit"时，拿这一步**最初**开始时的 sha 来比，并且不算 WIP commit。
- **implement 的 brief 要求分块提交**：每完成一块能跑通的部分就提交一次，被打断时丢得最少。
- **只有"这一步本身没做完"才走 `redo`**（第六节第 2 类）。"这一步做完了、结论是不通过"（build 红、review 有 findings）走 `fix`，不走 `redo`。
- 触发 `redo` 的入口：瞬时错误、不认识的崩溃、没有回执、回答读不懂（规则，自动）；`run.turns`/`run.wall` 用完后 triage 判断"只是没做完"（自动）；`Unclear` 被人回答之后；人在页面上点"在保存的工作上重做这一步"（#1218、#1219，改成走 `redo`）。

---

## 六、失败分六类（已定）

### 第 1 类：Lingtai 自己或环境的问题（还没有 agent 在跑）

| 情况 | 处理 |
|---|---|
| recipe 解析不了、没配 App、数据库连不上 | 认领之前就挡掉，不认领、不花钱（0108 §1） |
| prepared 失败，原因是瞬时错误（registry 5xx） | 规则 → `redo` |
| prepared 失败，其他原因 | triage 判定 `SetupBroken` → `toPerson`（environment） |
| agent 根本没启动（账户额度用完） | 规则：锁住这个账户，额度重置后自动解锁；解锁后从保存的 head 重新做这一步（#1205） |

### 第 2 类：一步没跑完（agent 异常结束）

| 情况 | 处理 |
|---|---|
| 瞬时 API 错误（5xx、529、429、Cloudflare） | 规则 → `redo` |
| 不认识的崩溃、没有回执 | 规则 → `redo` |
| 回答读不懂 | 规则 → `redo`（不再单独记"重问一次"） |
| `run.turns` 或 `run.wall` 用完 | triage：`TicketTooBig` 并附拆票方案 → `split`；`TicketTooBig` 没有方案 → 把耗时点写进正文，然后 `redo`；只是没做完 → `redo` |
| `redos` 用完 | `toPerson`（limit） |

### 第 3 类：对代码的判断不通过

| 情况 | 处理 |
|---|---|
| build 红 | 规则：`checkRerun`（0108 §17）；红了又绿且满足 flaky 的三个条件 → 放行，在 backlog 记一条 minor。base 上也红 → 放回队列，保留 head（0108 §13）。否则 → `fix` |
| review 有 findings | triage：`FixableLines` → `fix`；`WrongApproach` → `startOver` |
| review 的 diff 太大，读不完 | triage：`TicketTooBig` 并附方案 → `split`；否则 → `toPerson`（limit） |
| implement 零提交 | 按 agent 声明的结果处理（第四节）：`Disputed`、`AlreadyDone`、`Unclear`，或按 `AgentFailed` 处理 |
| 合并冲突 | 冲突块不超过 5 个 → `conflictFix`；更多时 triage `ConflictingHunks`：两边逻辑矛盾 → `startOver`；有只能由人判断的冲突块 → `toPerson`（unclear）；否则 → `conflictFix` |
| `fixes` 或 `conflictFixes` 用完 | triage 判定 `WrongApproach` → `startOver`；否则 → `toPerson`（limit） |

### 第 4 类：票本身的问题

| 情况 | 处理 |
|---|---|
| design 阶段提问（`AgentQuestion`） | `toPerson`（unclear） |
| triage 判定 `UndecidedQuestion` | `toPerson`（unclear） |
| triage 判定 `TicketTooBig` | `split` |
| triage 判定 `WrongApproach` | `startOver` |

### 第 5 类：落地时的问题

| 情况 | 处理 |
|---|---|
| base 动了 | 规则：`baseMerge`，重新 build；只有 base 的改动碰到分支改过的文件，review 才重做（#1210） |
| push 遇到瞬时错误 | 规则：`landRetry`，从保存的 head 重新落地（#1221） |
| push 被拒且重试也没用 | `toPerson`（environment） |
| 分支已经不在了 | `startOver` |

### 第 6 类：triage 自己失败

| 情况 | 处理 |
|---|---|
| triage 崩溃，或回答读不懂 | 规则：再问一次（`triageRetries`） |
| 还是失败 | `toPerson`，页面写明"triage 没有给出建议" |

---

## 七、triage 的回答 → 系统执行的动作（已定）

### 回答的格式

```
action:  redo | fix | conflictFix | startOver | split | toPerson
cause:   triage 判断的原因（现有六种之一）
附带的内容：
  redo         →  正文要补的一句（可选，比如"turns 主要耗在 X 上"）
  fix          →  要改的行：[{path, line, what}]
  conflictFix  →  每个冲突块的建议解法
  startOver    →  一句话：旧方案哪里错了（写进下一个 attempt 的 brief）
  split        →  拆票方案：子票列表，以及母票还有没有剩余部分
  toPerson     →  unclear（问题和选项，第四节的格式） | environment（哪里坏了、怎么修）
summary: 给人读的一句话
```

- **页面直接读这个回答。** `toPerson` 时按种类显示"需要你做什么"：unclear 显示问题和选项，人在页面上作答，答案写进正文后 `redo`；environment 显示哪里坏了、用什么命令修。其他五个动作时，页面只显示一行"系统做了什么、为什么"，不开 wait。
- **`limit` 由系统给出，不来自 triage**，写明是哪个上限、用了几次。
- **`Approve`（跳过拒绝直接落地）和 `Close`（关票）只留给人**，triage 不能选。唯一的例外是 `split` 过的母票得到 `AlreadyDone` 时，由系统以 `satisfied` 关闭（第四节）。
- 所有自动执行都在日志里记成 `by: triage`。

### 原因 → 动作

| triage 判断的原因 | 系统执行 | 前提 | 前提不满足时 |
|---|---|---|---|
| `FixableLines` | `fix` | 还有 `fixes` | `toPerson`（limit） |
| `WrongApproach` | `startOver` | 还有 `startOvers` | `toPerson`（limit） |
| `TicketTooBig` 并附拆票方案 | `split` | 这张票不是 `split` 出来的子票（`splitDepth`） | `toPerson`（limit） |
| `TicketTooBig` 没有方案 | 把耗时点写进正文，然后 `redo` | 还有 `redos` | `toPerson`（limit） |
| `ConflictingHunks` | 能逐块解 → `conflictFix`；两边逻辑矛盾 → `startOver` | 没有只能由人判断的冲突块；还有 `conflictFixes` / `startOvers` | 有人判断的块 → `toPerson`（unclear）；上限用完 → `toPerson`（limit） |
| `SetupBroken` | `toPerson`（environment） | — | — |
| `UndecidedQuestion` | `toPerson`（unclear） | — | — |

---

## 八、拆票（`split`，已定）

1. triage 写拆票方案：最多 8 张子票，每张有标题、正文、kind，以及子票之间的先后关系。
2. 系统直接开票，**不加 `agent:hold`**，用 blocked-by 串起来，子票按顺序进队列。写入过程沿用 0118 §12 已经做好的部分（标记、对账、中断后可以重试）。
3. **母票一律放回队列**，被所有子票 blocked-by，子票没落地之前队列会一直跳过它。再被取出来时，新的 attempt 从 base 开始（此时 base 已经包含所有子票），只做两件事：
   - **验收**：对照母票正文的 Done when，逐条检查是否满足。
   - **补完**：子票没覆盖到的部分，在这次 attempt 里做掉。

   验收通过、也没有剩下的事，agent 零提交并声明 `AlreadyDone`，说明每条 Done when 由哪张子票满足；系统自动以 `satisfied` 关闭母票，不走 merge。
4. **只拆一层**（`splitDepth` = 1）：`split` 出来的子票如果又被判定 `TicketTooBig` → `toPerson`（limit），不再自动拆。
5. 子票必须按 write-ticket 的规范写（原则 6）。现在 triage 写的子票还达不到，0.18.0 会把同一套写票能力用到这里。

---

## 九、上限的名字和数值（已定）

**规则：每个上限一个名字，说清它数的是什么、按什么范围计数。** 意义不同就用两个名字，即使数值相同。

| 上限 | 数的是什么 | 出发点 | 计数范围 | 值 | 放在哪 | 旧名字 |
|---|---|---|---|---|---|---|
| **`fixes`** | `fix`：build 红、review 有 findings，回 implement 在 head 上修 | ➡ 接着往下做 | 每个 attempt | **6** | recipe | `rounds` |
| **`conflictFixes`** | `conflictFix`：合并冲突，回 implement 在 head 上解 | ➡ 接着往下做 | 每个 attempt | **6** | recipe | 没有自己的名字，借用 `rounds` 的值 |
| `baseMerges` | `baseMerge`：base 动了合并进来，再 build | ➡ 接着往下做 | 每个 attempt | 10 | 常量 | `BASE_MERGES_LIMIT` |
| **`landRetries`** | `landRetry`：push 遇到瞬时错误后重新落地（#1221），不跑 agent | ➡ 接着往下做 | 每个 attempt | 3 | 常量 | 现在和 `redo` 共用 `TRANSIENT_RETRIES_LIMIT` 的计数 |
| **`redos`** | `redo`：瞬时错误、崩溃、没有回执、回答读不懂、`run.turns`/`run.wall` 用完后的"接着做" | ↻ 当前 attempt 里重做 | 每个 attempt | 3 | 常量 | `TRANSIENT_RETRIES_LIMIT` |
| `redoWaits` | 每次 `redo` 之前等多久 | （跟随 `redos`） | — | 1、5、15 分钟 | 常量 | `TRANSIENT_WAITS` |
| `checkReruns` | `checkRerun`：检查红了，在同一个 commit 上立刻再跑 | ↻ 当前 attempt 里重做 | 每次红 | 1 | 常量 | 0108 §17，没有名字 |
| **`startOvers`** | `startOver`：从头重来 | ⟲ 从 base 重来 | 每张票 | 2 | recipe | `restarts` |
| `splitDepth` | `split`：自动拆票的层数 | ⟲ 从 base 重来 | 每张票 | **1** | 常量 | 没有，新加 |
| `run.turns` | 一次 run 的轮数 | ■ 封顶（用完 → triage 决定 `split` 还是 `redo`） | 每次 run | 350 | recipe | `runtime.limits.turns` |
| `run.wall` | 一次 run 的时长 | ■ 封顶（同上） | 每次 run | 75m | recipe | `runtime.limits.wall` |
| `run.usd` | 一次 run 的花费 | ■ 封顶（同上） | 每次 run | 未设置 | recipe | `runtime.limits.usd` |
| `designQuestions` | design 阶段停下来提问的次数（每次最多 5 个问题） | ■ 封顶（用完 → design 不能再问，必须自己决定） | 每张票 | **5**（现在是 2） | 常量 | #649 的 `designAsks` |
| `triageRetries` | triage 崩溃或回答读不懂后再问 | ↻ 再问一次 | 每次 triage | 1 | 常量 | 没有，新加 |
| `triage.turns` / `triage.wall` / `triage.usd` | 一次 triage 调用 | ■ 封顶（用完 → triage 失败，第六节第 6 类） | 每次调用 | 100 / 15m / $10 | recipe | `triage.limits` |

**■ 封顶**：本身不重跑任何东西，用完时触发括号里写的动作。

**改动说明：**
- **`rounds` 拆成 `fixes` 和 `conflictFixes`，不再叫 round**：round 听起来像"再来一轮"，容易被理解成整个 attempt 重来；这两个动作其实是在当前 head 上接着修。两者起因和证据不同，分成两个参数，可以各自调整。
- **`restarts` 改名为 `startOvers`**：`restart` 已经是 `lingtai restart`（重启 daemon）的名字。
- **`landRetries` 从 `TRANSIENT_RETRIES_LIMIT` 里分出来**：重新落地只是再 push 一次，不跑 agent；`redo` 要跑 agent。现在两者共用一个计数，会互相占用次数。
- **`run.turns`/`run.wall` 用完后的"接着做"记到 `redos`**：它本身就是 `redo`。
- **recipe 按计数范围分组**：

  ```yaml
  runtime:
    limits:
      run:     { turns: 350, wall: 75m }           # 一次 run
      attempt: { fixes: 6, conflictFixes: 6 }       # 一个 attempt
      ticket:  { startOvers: 2 }                    # 一张票
  ```

- **一张票最多自动跑多少次 run**：`(startOvers + 1) × (1 + fixes + conflictFixes + redos)` = 3 × (1 + 6 + 6 + 3) = 48 次。`landRetries`、`baseMerges`、`checkReruns` 不跑 agent，不计入。
- **单张票的花费上限这次不加**：系统还没有按票统计花费的设计。以后需要时叫 `ticket.usd`，放在 `ticket` 分组里。

**`fixes` 定为 6 的依据**：最近 7 天 lingtai 落地 228 张票，0 到 1 次修完的占 79%，5 次以上的占 4%（只看 feature 票是 13%）。按"第几次 review 通过"统计：第 4 次 review 时 16 张过了 8 张，第 5 次时 8 张过了 1 张。人工额外给修复的票里，#1170、#1177 都是多给 1 次就过了。

---

## 十、现在的设置（2026-11-17 盘点，旧名字）

这一节记录改之前系统里实际的设置，所以用旧名字。

### recipe 里可以改的（`~/.lingtai/lingtai/recipe.yml`）

| 设置 | 当前值 | 管什么 | 计数范围 | 新名字 |
|---|---|---|---|---|
| `runtime.limits.turns` | 350 | 一次 run 最多多少轮 | 每次 run | `run.turns` |
| `runtime.limits.wall` | 75m | 一次 run 最长多久 | 每次 run | `run.wall` |
| `runtime.limits.usd` | 未设置 | 一次 run 最多花多少钱 | 每次 run | `run.usd` |
| `runtime.limits.rounds` | 4 | 修复的上限；冲突也用这个数值，但两个计数器各算各的（`run-attempt.ts:1625` 把 `conflictRounds` 设成 `ceilings.rounds`） | 每个 attempt | `fixes` + `conflictFixes` |
| `runtime.limits.restarts` | 2 | 从 base 重来 | 每张票 | `startOvers` |
| `source.backoff` | 1h | 票放回队列后，最早多久能再被领 | 每次放回 | 不变 |
| `triage.limits` | turns 100、wall 15m、usd $10 | 一次 triage 调用 | 每次调用 | `triage.*` |
| `runtime.budget.diff` | 400000 字节 | diff 超过这个大小就不交给 review，直接交给人（0108 §14） | 每次 review | 不变 |
| `runtime.concurrency` | 2 | 同时跑几张票（不是出口） | — | 不变 |

### 程序里写死的数值

**循环的出口**

| 位置 | 值 | 管什么 | 新名字 |
|---|---|---|---|
| `TRANSIENT_RETRIES_LIMIT`（`domain/src/failure/respond.ts:586`） | 3 | 原地重跑被瞬时错误打断的 run；落地重试也算在里面 | `redos`、`landRetries` |
| `TRANSIENT_WAITS`（`respond.ts:589`） | 1、5、15 分钟 | 每次重跑之前等多久 | `redoWaits` |
| `BASE_MERGES_LIMIT`（`respond.ts:579`） | 10 | base 动了之后自动合并 | `baseMerges` |
| 检查红了再跑一次（0108 §17） | 1 次 | build、声明的检查或 base check 红了立刻再跑 | `checkReruns` |
| 回答读不懂再问（0108 §18） | 1 次 | 再问同一个 agent | 并入 `redos` |
| design 提问（`actions/src/agent-action.ts:150-154`，#649） | 2 | 同一张票 design 问满 2 次后不让再问 | `designQuestions` |
| 网络不通时重试（`repo/src/network.ts` 的 `retryUnreachable`，默认 `UNREACHABLE_WAITS`） | 等待次数 + 1 | mirror fetch / push 连不上时原地重试 | 不变 |
| GitHub 限流（`github/src/client.ts:577` `MIN_RATE_LIMIT_WAIT`） | 至少 1 分钟 | 锁住 acct-github；没给重置时间就等 1 分钟、再翻倍（#1213） | 不变 |

**triage 的边界**（`domain/src/triage.ts`）

| 常量 | 值 | 管什么 |
|---|---|---|
| `READS_PER_TURN` | 6 | triage 或讨论一轮最多读几个文件 |
| `MAX_READ_ROUNDS`（`conductor/src/read-step.ts:29`） | 4 | 最多读几轮再必须给出回答 |
| `CONFLICT_ROUND_HUNKS` | 5 | 冲突块不超过 5 个，一律 `conflictFix`，不管 triage 怎么判断 |
| `MERGE_HUNKS_ONE_BY_ONE` | 20 | 冲突块超过 20 个，就整体判断，不逐块判断 |
| `TRIAGE_QUESTIONS_MAX` / `TRIAGE_ANSWERS_MAX` | 5 / 4 | 最多问 5 个问题，每个问题最多 4 个选项 |
| `TRIAGE_FIXES_MAX` | 20 | `FixableLines` 最多列 20 处要改的地方 |
| `TRIAGE_SPLIT_CHILDREN_MAX` | 8 | 拆票最多 8 张子票 |

**recipe 没写时的默认值**（`recipe/src/recipe.ts`）：`turns` 300（`:3267`），`rounds` 2（`:3310`），`restarts` 0（`:3345`）。lingtai 自己的 recipe 都写了。

**全局总闸**：当天花费上限 $200，花到就不再开新的 attempt（0126）。

**一张票最多自动跑多少次 run**：0108 §8 现在的公式是 `(restarts + 1) × (2 × rounds + 1 + TRANSIENT_RETRIES_LIMIT)`（`attemptCeiling`），即 3 × (8 + 1 + 3) = 36 次，最长 36 × 75 分钟。改名、分开之后的公式见第九节。

---

## 十一、和现在相比要改的地方

| # | 改动 | 涉及 |
|---|---|---|
| 1 | WIP 直接提交到工作分支；`conflictFix` 和零提交时不提交；删掉 lane 的 `wip-commit` 拒绝；判断"有没有产出"时不算 WIP commit | `conduct.ts` 的 `keepUncommittedWork`，`integrate.ts`，0108 |
| 2 | 删掉 #1170 的 WIP 携带 | `carry-wip-port.ts`，`conduct.ts` 的 `cut` |
| 3 | `redo` 统一成一个工作流：从 head 整步重跑，brief 加说明；去掉 #1201 那套从被打断的动作接着跑 | 0108 §12，`run-attempt.ts`，`action.ts` |
| 4 | 不认识的崩溃、没有回执、回答读不懂都走 `redo`；#1205 的 `askedAgainOn` 随之删掉 | 0108 §12、§18，`attempt.ts` |
| 5 | implement 的 brief 要求分块提交 | implement 的 prompt |
| 6 | implement 的五种结果由 agent 声明并按 commit 核对；去掉 `nothing-produced`（并入 `AgentFailed`）；路由加原因 `already-done` 和去向 end；票加终态 `satisfied` | implement 的 prompt，`proposal.ts`，路由，ticket 的 reducer，看板 |
| 7 | design 提问、implement 的 `Unclear`、triage 的 `UndecidedQuestion` 统一用 `TriageQuestion` 格式，答案用 `triageAnswersText` 写进正文 | `agent-action.ts`，`triage.ts`，Waiting 页面 |
| 8 | triage 的回答改成第七节的格式；系统按原因自动执行，记成 `by: triage`；triage 失败再问一次 | 0108 §16，0118，`wait.ts`，triage 的 prompt |
| 9 | `run.turns`/`run.wall` 用完时交给 triage，由它判断 `split` 还是 `redo` | 0108 §12 |
| 10 | 自动 `split`：只拆一层，母票放回队列，子票落地后验收并补完 | 0118 §12 |
| 11 | 上限按第九节改名、分组：`rounds` → `fixes`（6）和 `conflictFixes`（6），`restarts` → `startOvers`，`TRANSIENT_RETRIES_LIMIT` → `redos` 和 `landRetries`，等等；`designQuestions` 从 2 改为 5 | recipe 的 schema，`attemptCeiling`，`respond.ts`，本机 recipe |
| 12 | 代码和界面里的 "round" 改成 fix：`GrantFixRound`、`FixRequested`、"Continue fixing current work"、"fix round" 等文案 | domain 事件和 resolution 的名字，看板，CLI |
| 13 | #1218、#1219（人在页面上点"重做这一步"）改成走 `redo` | 0.15.0 里已有的票，改正文 |
| 14 | write-ticket 的 Edges 清单、design 的提问清单都加上"一个动作被重做或跳过时，同一步里的其他动作怎么办" | write-ticket skill，`agent-action.ts:1398-1405` |

第 12 条涉及事件名（`FixRequested` 等）。日志里已经有旧名字的事件，是用 `packages/domain/src/upcast.ts` 在读的时候改成新名字，还是新旧两个名字并存，切票时再定。

---

## 十二、结论汇总

全部已定（2026-11-17）：

- 原则 1–6；处理分三层。
- WIP：只来自 implement 的 agent 异常结束，由灵台提交到工作分支；删掉 #1170。
- implement 的五种结果：`Implemented`、`AgentFailed`、`Disputed`、`AlreadyDone`、`Unclear`；提问统一用 `TriageQuestion` 格式；沿用现有路由，新加 `already-done` 和终态 `satisfied`。
- 六个动作：`redo`、`fix`、`conflictFix`、`startOver`、`split`、`toPerson`；规则直接执行的三个：`checkRerun`、`baseMerge`、`landRetry`。
- `redo` 只用于"这一步本身没做完"；"做完了但不通过"走 `fix`。
- `split`：全自动，只拆一层，母票放回队列，子票落地后验收并补完。
- 上限名字和数值见第九节：`fixes` 6、`conflictFixes` 6、`redos` 3、`landRetries` 3、`startOvers` 2、`splitDepth` 1、`designQuestions` 5；单张票的花费上限这次不加。
- `Approve` 和 `Close` 只留给人；`split` 过的母票 `AlreadyDone` 时系统以 `satisfied` 关闭是唯一例外。

【待定】只剩一条：第十一节第 12 条里事件改名怎么处理旧事件，切票时定。

下一步：把这份方案改写进 ADR 0108 和 0118，再按第十一节切票。
