# 失败怎么处理：方案（讨论稿）

2026-11-17 起草，operator 与 Claude 逐条讨论定下；同日按一次冷评补了"恢复协议与完成判据"（第五节的重放规则、第四节的判定、第七节的执行协议、第八节的拆票）。依据：ADR [0108](../decisions/0108-a-refusal-buys-a-round.md)、[0118](../decisions/0118-a-hold-explains-itself.md) §12、`packages/domain/src/wait.ts` 里 triage 的六种原因，以及 #1201、#1205 两张票的教训。

全部定下来之后，改写进 0108（失败与恢复）和 0118（triage 与拆票），再切票。**这批票放在 0.15.0**：0.15.0 的目标就是"人是兜底"，这是它的主线。
标 **（已定）** 的是讨论定下的；标 **【待定】** 的是还要 operator 确认的建议。

---

## 零、术语表

全文、以后的 ADR、代码、日志、看板都只用下面这些词。一个词只指一件事；意义不同的两件事，即使数值或做法相同，也用两个词。

**对象**

| 词 | 意思 |
|---|---|
| attempt | 对一张票的一次尝试：一个 worktree、一条工作分支 `agent/<n>`，从 claim 走到 end。不叫 pass |
| step | attempt 里的十步之一：claim、admit、prepared、design、implement、build、review、proposed、merge、end |
| action | step 里 recipe 声明的一项：`run:`、`agent:`、`file:`…… |
| run | 一次 agent 运行（一次 dispatch） |
| base | 票要合进去的分支（`main`）的某个 commit |
| head | 工作分支当前最新的 commit |
| WIP | implement 的 agent 异常结束时还没提交的代码，由灵台替它提交成一个 commit，sha 记在 `RunKeptUncommitted` 上（第三节） |

**动作**（第五节）：失败后系统做的事，一共六个，加三个由规则直接执行的。**名字一律是"动词 + 名词"**，读起来就是接下来要做的事。

| 词 | 中文 | 出发点 |
|---|---|---|
| `redoStep` | 重做这一步 | ↻ 同一步再做一遍 |
| `fixRefusal` | 修掉被拒的地方（build 红、review 的 findings） | ➡ 接着往下做 |
| `resolveConflict` | 解决合并冲突 | ➡ 接着往下做 |
| `startNewAttempt` | 开一个新的 attempt（从头重来） | ⟲ 从 base 重来 |
| `splitTicket` | 拆这张票 | ⟲ 从 base 重来 |
| `askPerson` | 交给人决定 | — |
| `rerunCommand` | 检查红了立刻再跑（规则） | ↻ 同一步再做一遍 |
| `mergeBaseBranch` | base 动了合并进来（规则） | ➡ 接着往下做 |
| `retryLanding` | 重新落地（规则） | ↻ 同一步再做一遍 |

**出发点**：
- **➡ 接着往下做**：同一个 attempt，从当前 head 往前走，已有的 commit 都保留，再加新的。
- **↻ 同一步再做一遍**：只把刚才出问题的那一步（或那一次检查）再做一遍，起点是当前 head。不往前推进，不回到 attempt 的开头，也不开新的 attempt。
- **⟲ 从 base 重来**：开新的 attempt，从 base 开始，旧的改动不带。

**上限**（第九节）：每个动作有自己的上限，名字由动作名变成复数：`redoStep` → `stepRedos`、`rerunCommand` → `commandReruns`、`fixRefusal` → `refusalFixes`、`resolveConflict` → `conflictResolutions`、`startNewAttempt` → `newAttempts`、`splitTicket` → `ticketSplits`、`askPerson` → `personAsks`、`mergeBaseBranch` → `baseBranchMerges`、`retryLanding` → `landingRetries`。

**implement 的结果**（第四节）：`Implemented`、`AgentFailed`、`Disputed`、`AlreadyDone`、`Unclear`。

**triage 的原因**（第七节）：`FixableLines`、`WrongApproach`、`ConflictingHunks`、`TicketTooBig`、`SetupBroken`、`UndecidedQuestion`，新加 `Unfinished`。

**`askPerson` 的三种**：`unclear`（需求不清楚）、`environment`（环境坏了）、`limit`（某个上限用完了）。

**票的终态**：`landed`（合进 main）、`satisfied`（review 核对过 Done when 已经满足，这次没有合入代码）、被人 `Close`。

---

## 一、原则

1. **机器处理是默认，人是兜底。**（已定）机器能处理的都交给机器。人只在两种情况介入：
   - **防止死循环**：程序必须有出口、会终止，并且留下结束标识。出口就是第 5 条的上限。
   - **需求本身不清楚**：只有人能回答。上限用完也不能让 agent 替人做业务决定。
2. **triage 只判断原因，不动手；系统按原因决定动作并执行。**（已定）以前 triage 的建议写给人看，人照着去点按钮；现在 triage 只回答 `cause`（加上这个原因需要的附带内容），动作由系统按第七节的表决定，执行前核对状态有没有变。人读 `summary`，页面直接显示这个回答。
3. **从已经提交的东西接着做。**（已定）失败不扔掉已有的 commit。只有判定方向错了，才从 base 重来。
4. **没提交的丢了很正常。**（已定）不为保住没提交的东西写复杂逻辑；丢了顶多多 `redoStep` 一次，花不了多少 token。唯一的例外是 implement 的 agent 异常结束时留下的代码，由灵台替它提交（第三节）。
5. **每条自动路径都有上限**，用完才交给人。（已定）这是第 1 条"程序必须有出口"的落实：每条路径都有计数和上限，计数记在事件里，重启、重新领取都不会清零；用完时留下结束标识，写明是哪个上限、用了几次（`askPerson` 的 `limit`）。
6. **开票时把不了关，所以在 design 阶段把关。**（已定）票可能是人在 GitHub 上手工开的，系统现在也没有开票功能，开票时的质量我们限制不了。所以：
   - **design 阶段是系统唯一能把关的地方**：发现业务规则不清楚，就提问，进 Waiting 页面等人回答（`AgentQuestion`，#649）。
   - **系统自己开的票**（`splitTicket` 出来的子票，以及以后 0.18 在看板上生成的票）**必须按 write-ticket 的规范写**。
   - 失败处理只管怎么恢复，不替票补需求。
7. **"完成"要有证据，不能只看状态。**（已定，冷评后新加）`Implemented` 要求 head 真的动过；`satisfied` 要求 review 在具体的 base sha 上核对过每一条 Done when；子票关闭只用来解除依赖，不等于母票的验收通过。

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
 └─ 第三层：人（askPerson）
      只在上限用完（limit）、需求不清楚（unclear）、环境坏了（environment）的时候
```

---

## 三、WIP（已定）

> **WIP 只有一种来源：implement 这一步的 agent（首次实现，或 `fixRefusal` 里的 fixer）异常结束时，worktree 里还没提交的代码。灵台把它作为一个普通 commit 直接提交到这个 attempt 的工作分支 `agent/<n>`，再 push。**

- **异常结束指**：crash、timeout、`run.turns` 或 `run.usd` 用完，以及 agent 还在跑时 attempt 被停掉（`interrupted`）。
- **不产生 WIP 的情况**：
  - design、review、merge：它们不写代码。现在的代码也只在 implement 里设置 `stoppedBy`（`conduct.ts:4684-4812`、`4931-5085`）。
  - `resolveConflict`：再做时会重新 merge、重新拿到冲突标记，存下来没有意义。
  - agent 正常结束但零提交：不算异常，按 agent 声明的类型处理（第四节）。
  - agent 根本没启动（never-started）：它什么都没碰。
- **内容**：`git add -A` 能收进去的改动，不包括被 `.gitignore` 忽略的文件，也不包括种进去的 env 文件。commit message 用固定前缀，例如 `wip: implement cut off by <原因>`，**只给人看**。日志里记一条 `RunKeptUncommitted`，带上这个 commit 的 sha；程序判断"哪个 commit 是 WIP"一律读这个 sha，不看 message 前缀。
- **为什么直接提交到工作分支，不再另放 arm**：
  - lane 原本拒绝带 `wip:` commit 的分支（`packages/repo/src/integrate.ts:520-536`），理由是"做到一半的 commit 不能落到 main"。现在落地的永远是 build 和 review 检查过的那个 head（#1209）。
  - implement 要求分块提交，agent 自己的中间 commit 也不保证每个都能编译，WIP commit 和它们没区别。
  - lane 用 merge commit 合进 main，main 的 first-parent 链上每个点都是检查过的。
- **配套要改的**：删掉 lane 的 `wip-commit` 拒绝；`keepUncommittedWork` 改为提交到工作分支，`resolveConflict` 和零提交时不提交；**删掉 #1170**（把 WIP 打到下一个 attempt 的新 worktree 上）：同一个 attempt 里 `redoStep` 直接从 head 做，换 attempt 只剩 `startNewAttempt`，而 `startNewAttempt` 不该带旧改动。

---

## 四、implement 的五种结果（已定）

**两件事分开看**（冷评后改）：
- **结论**：agent 在最终回答里明确声明属于哪一种。**结论决定走哪条路。**
- **事实**：这一步**最初**开始时的 sha、现在的 head、中间有哪些 commit（含 WIP，按 `RunKeptUncommitted` 的 sha 认）。**事实只用来纠正两种自相矛盾的声明**：
  - 声明 `Implemented`，但 head 和这一步开始时一样 → 按 `AgentFailed`。
  - 声明 `AlreadyDone`，但 head 动过 → 按 `Implemented`，进 build 和 review。
- 有 commit 不能盖过 `Unclear` 或 `Disputed`：agent 做了一部分、然后发现需要人决定，仍然是 `Unclear`，已有的 commit 留在工作分支上。
- WIP commit 算"head 动过"：上次被打断时的工作已经被灵台提交，这次 `redoStep` 的 agent 检查后发现已经做完、无需再改，声明 `Implemented` 是对的。

| 结果 | 意思 | 判定 | 下一步 |
|---|---|---|---|
| `Implemented` | 做完了 | 声明 `Implemented`，且 head 比这一步开始时动过（WIP 也算） | 直接进 build，不经过路由 |
| `AgentFailed` | 没做完 | 异常结束（第三节）；或没有声明；或声明 `Implemented` 但 head 没动 | 有 WIP 就提交 → `redoStep` |
| `Disputed` | `fixRefusal` 里的 fixer 认为 finding 不成立 | 声明 `Disputed`，说明不同意哪条、为什么 | 路由（`fixer-disagrees`）→ judge 裁定：fixer 对 → 这条 finding 作废并记进 backlog，往下走；reviewer 对 → 带着 judge 的理由再 `fixRefusal` |
| `AlreadyDone` | 要做的事 base 上已经有了 | 声明 `AlreadyDone`，head 没动，逐条说明每项 Done when 由什么满足 | 路由（新原因 `already-done`）→ **review 核对**（下面）→ 通过：`splitTicket` 过的母票由系统以 `satisfied` 关闭；其他情况（重复票、被别的票顺手修了）`askPerson` 确认后再关 |
| `Unclear` | 照着票写的做不下去 | 声明 `Unclear`，按下面的格式列出问题；有没有 commit 都一样 | 路由（`needs-input`，现有的 `InputNeeded{from: 'implement'}`）→ `askPerson`（unclear）→ 人回答，答案写进正文 → 继续这一步 |

**`AlreadyDone` 的核对**：不走 build 和 merge（没有要合入的代码），但**不跳过 review**。review 拿到原来的 Done when、agent 逐条给的证据和当前 base 的 sha，逐条判断是否满足：
- 全部满足 → `satisfied`。`TicketSatisfied` 事件记下核对时的 base sha、正文的版本和每条的证据。
- 有不满足的 → 当作 findings，走 `fixRefusal`：implement 在 head 上把缺的部分做掉，之后照常 build、review、merge。

### 提问的格式（已定）

design 阶段提问（`agent-action.ts:1407-1440`）、implement 的 `Unclear`、triage 的 `UndecidedQuestion`，三处统一用 triage 现有的 `TriageQuestion`（`packages/domain/src/triage.ts`）：

```
questions: 最多 5 个
  - id
    text:        一句话问题
    answers:     2–4 个选项，每个 {id, text}，text 写明选了它会怎么做
    recommended: 推荐的那个选项的 id
```

页面把问题按 1、2、3 列出来，每个问题下列选项，推荐项排第一、带标记；人也可以不选、自己写答案。回答完，系统把"问题 → 答案"写进正文的一个固定小节（`triageAnswersText`，#921），然后**继续这一步**：做法和 `redoStep` 一样（从 head 整步重跑，brief 带上说明），但**不计入 `stepRedos`**——`stepRedos` 只数失败后的重做。每停下来问一次人，计入 `personAsks`（第九节）。

### implement 之后怎么走：沿用现有路由，不加新步骤（已定）

- `Implemented`：implement → build → review → proposed，跟现在一样。
- 其余结果：带着原因（`when:`）到 `proposed` 的路由（`packages/domain/src/proposal.ts` 的 `JudgeWhen`）。`Disputed` → `fixer-disagrees`（已有）；`Unclear` → `needs-input`（已有）；`AlreadyDone` → 新加 `already-done`；`AgentFailed` 由规则直接 `redoStep`，不经过路由。现有的 `nothing-produced` 去掉，并入 `AgentFailed`。
- `already-done` 的去向是 review 核对；核对通过后到 end，以 `satisfied` 结束，不走 build 和 merge。
- 五种结果同样适用于 `resolveConflict` 里的 agent：冲突块里有只能由人判断的内容（权限、数据保留、金额……），它声明 `Unclear`。

---

## 五、六个动作（已定）

所有失败最后都落到这六个动作之一。名字和第九节的上限一一对应。

| 动作 | 做什么 | 出发点 | 上限 |
|---|---|---|---|
| **`redoStep`** 重做这一步 | 只重做出错的这一步，不重走整个流程 | ↻ 工作分支的 head（含 WIP commit），其他没提交的改动丢掉 | `stepRedos` |
| **`fixRefusal`** 修复 | build 红、review 有 findings：带着证据（命令输出、findings）回 implement，在当前 head 上修，修完再走 build 和 review | ➡ 同一个 worktree，当前 head | `refusalFixes` |
| **`resolveConflict`** 解冲突 | 合并冲突：带着冲突文件回 implement，在当前 head 上重新 merge、把冲突解掉，再走 build 和 review | ➡ 当前 head | `conflictResolutions` |
| **`startNewAttempt`** 从头重来 | 方向错了，开一个新 attempt | ⟲ base；旧方案推到 arm 分支留档，旧改动一律不带 | `newAttempts` |
| **`splitTicket`** 拆票 | 票太大：开子票，用 blocked-by 串起来；母票放回队列，等子票全部关闭后验收并补完（第八节） | ⟲ 子票和母票都从 base 开始 | `ticketSplits` |
| **`askPerson`** 交给人 | 停在 Waiting 页面，按 `unclear`、`environment`、`limit` 显示需要人做什么 | — | `personAsks`（只数 `unclear`） |

`fixRefusal` 和 `resolveConflict` 做法一样（回 implement 在 head 上改），但起因和证据不同，所以是两个动作、两个上限。

另外三个**由规则直接执行**，不经过 triage：`rerunCommand`（`commandReruns`）、`mergeBaseBranch`（`baseBranchMerges`）、`retryLanding`（`landingRetries`）。

**`redoStep` 和 `rerunCommand` 都是"同一步再做一遍"，但不合并**（2026-11-17）：

| | `redoStep` | `rerunCommand` |
|---|---|---|
| 什么时候 | 这一步**没做完**：agent 崩溃、超时、没有回执 | 这一步**做完了，结论是红**：`pnpm test` 跑完失败 |
| 再做什么 | 整个 step，包括再跑一次 agent | 只把那条检查命令再跑一次，不跑 agent |
| 花不花钱 | 花（一次 agent run） | 不花（只花检查的时间） |
| 等多久 | 1、5、15 分钟 | 立刻 |
| 第二次的结果怎么用 | 当成这一步的结果，照常往下走 | 和第一次比：红了又绿 → 按 flaky 规则放行，记一条 backlog；两次都红 → 走 `fixRefusal` |
| 上限 | `stepRedos` 3 次 | `commandReruns` 1 次 |

合并成一个会出两个问题：检查一红就要等 1 分钟、还占掉 agent 重做的次数；flaky 判断需要"同一个 commit 上两次结果对比"，`redoStep` 没有这层意思。如果检查命令本身没跑完（进程被杀、超时），那是"没做完"，走 `redoStep`。

### `redoStep` 的细节（已定）

- 这一步从第一个 action 开始重跑，不从"被打断的那个 action"接着跑。#1201 里那套逻辑（`ranBefore`、按 action 区分的重跑标记、`startedAt`/`fixDiffSeen`）要换掉。前提是下面的重放规则。
- agent 的 brief 末尾加一段：

  > 这一步被打断过（原因）。这一步开始时在 `<起点>`，现在已经提交到 `<head>`，其中包括灵台替你保存的未完成改动（如果有）。接着做，已经提交的不要重做。

- review 也走 `redoStep`，但不加这段说明：review 只读已提交的东西，没有什么会丢。
- implement 判断结果时，拿这一步**最初**开始时的 sha 来比（第四节）。
- **implement 的 brief 要求分块提交**：每完成一块能跑通的部分就提交一次，被打断时丢得最少。
- **只有"这一步本身没做完"才走 `redoStep`**（第六节第 2 类）。"这一步做完了、结论是不通过"（build 红、review 有 findings）走 `fixRefusal`，不走 `redoStep`。
- 触发 `redoStep` 的入口：瞬时错误、不认识的崩溃、没有回执、回答读不懂（规则，自动）；`run.turns`/`run.wall` 用完后 triage 判断 `Unfinished`（自动）；人在页面上点"在保存的工作上重做这一步"（#1218、#1219，改成走 `redoStep`）。人回答问题之后的继续，做法相同，但不计入 `stepRedos`（第四节）。

### 重放规则：哪些 action 可以重跑（已定，冷评后新加）

整步重跑的前提是：这一步里每个 action 再执行一次都不会出错。按 action 写到哪里分三种：

| action 写到哪里 | 例子 | 重跑 |
|---|---|---|
| 不写，或只读 | 检查命令、`agent:` 做 review | 可以重跑 |
| 只写这个 attempt 自己的 worktree 和工作分支 | `agent:` 做 design、implement；`file:`、`file-brief:` 写到固定路径；`run: pnpm install` | 可以重跑：worktree 先复位到 head，同一个路径覆盖写，结果只取决于 head 和正文 |
| 写到外部（GitHub、远端、别的票） | `merge` 的落地、`end` 的 `close`、`labels`、`refs`、拆票时开子票 | **不用 `redoStep`**：落地有自己的 `retryLanding`（只推检查过的那个 sha，#1209）；开子票有标记和对账（0118 §12）；`end` 的 action 保留"已完成"的记录，再进 end 时跳过已完成的 |

- `redoStep` 只用在 prepared、design、implement、review 四步。这四步里内置的 action 都属于前两种。
- **每个插件声明自己属于哪一种**（`replay: safe | external`）。recipe 解析时，如果在这四步里声明了 `external` 的 action，按名字拒绝。
- recipe 里人自己写的 `run:` 命令，灵台无法判断它写不写外部。规则写进 0108：**放在这四步的 `run:` 必须可以安全地再跑一次**；做不到的，放到 end。
- design 重跑会重新生成设计，这没问题：implement 还没开始，没有谁读过上一份设计。implement 的 `redoStep` 不重跑 design，用的是已经提交的那份。

---

## 六、失败分六类（已定）

### 第 1 类：Lingtai 自己或环境的问题（还没有 agent 在跑）

| 情况 | 处理 |
|---|---|
| recipe 解析不了、没配 App、数据库连不上 | 认领之前就挡掉，不认领、不花钱（0108 §1） |
| prepared 失败，原因是瞬时错误（registry 5xx） | 规则 → `redoStep` |
| prepared 失败，其他原因 | triage 判定 `SetupBroken` → `askPerson`（environment） |
| agent 根本没启动（账户额度用完） | 规则：锁住这个账户，额度重置后自动解锁；解锁后从保存的 head 重新做这一步（#1205）。这条路径不计次数：等待不花钱，也不跑 agent；没有重置时间的额度（例如月度花费）由人解锁 |

### 第 2 类：一步没跑完（agent 异常结束）

| 情况 | 处理 |
|---|---|
| 瞬时 API 错误（5xx、529、429、Cloudflare） | 规则 → `redoStep` |
| 不认识的崩溃、没有回执 | 规则 → `redoStep` |
| 回答读不懂 | 规则 → `redoStep`（不再单独记"重问一次"） |
| `run.turns` 或 `run.wall` 用完 | triage：`TicketTooBig` 并附拆票方案 → `splitTicket`；`TicketTooBig` 没有方案 → 把耗时点写进正文，然后 `redoStep`；`Unfinished` → `redoStep` |
| `stepRedos` 用完 | `askPerson`（limit） |

### 第 3 类：对代码的判断不通过

| 情况 | 处理 |
|---|---|
| build 红 | 规则：`rerunCommand`（0108 §17）；红了又绿且满足 flaky 的三个条件 → 放行，在 backlog 记一条 minor。base 上也红 → 放回队列，保留 head（0108 §13）。否则 → `fixRefusal` |
| review 有 findings | triage：`FixableLines` → `fixRefusal`；`WrongApproach` → `startNewAttempt` |
| review 的 diff 太大，读不完 | triage：`TicketTooBig` 并附方案 → `splitTicket`；否则 → `askPerson`（limit） |
| implement 没有声明 `Implemented` | 按 agent 声明的结果处理（第四节）：`Disputed`、`AlreadyDone`、`Unclear`，或按 `AgentFailed` 处理 |
| 合并冲突 | 冲突块不超过 5 个 → `resolveConflict`，不经过 triage；块数只决定用哪种解法，不代表不需要人判断：agent 遇到只能由人判断的块，声明 `Unclear`（第四节）。更多时 triage `ConflictingHunks`：两边逻辑矛盾 → `startNewAttempt`；有只能由人判断的冲突块 → `askPerson`（unclear）；否则 → `resolveConflict` |
| `refusalFixes` 或 `conflictResolutions` 用完 | triage 判定 `WrongApproach` → `startNewAttempt`；否则 → `askPerson`（limit） |

### 第 4 类：票本身的问题

| 情况 | 处理 |
|---|---|
| design 阶段提问（`AgentQuestion`） | `askPerson`（unclear） |
| triage 判定 `UndecidedQuestion` | `askPerson`（unclear） |
| triage 判定 `TicketTooBig` | `splitTicket` |
| triage 判定 `WrongApproach` | `startNewAttempt` |
| `personAsks` 用完 | `askPerson`（limit）：不再自动继续，由人决定改正文、关票或再给机会。**agent 不能因为问不了就自己替人决定** |

### 第 5 类：落地时的问题

| 情况 | 处理 |
|---|---|
| base 动了 | 规则：`mergeBaseBranch`，重新 build；只有 base 的改动碰到分支改过的文件，review 才重做（#1210）。**这是成本上的取舍，不是保证**：文件不重叠不代表语义不冲突（base 改了一个 API 的默认行为，分支改了另一个文件里的调用方），这时 build 是唯一的防线。沿用的 review 绑定它当时看的 head、base 和检查结果 |
| `baseBranchMerges` 用完（base 一直在动） | `askPerson`（limit） |
| push 遇到瞬时错误 | 规则：`retryLanding`，从保存的 head 重新落地（#1221） |
| push 被拒且重试也没用 | `askPerson`（environment） |
| 分支已经不在了 | `startNewAttempt` |

### 第 6 类：triage 自己失败

| 情况 | 处理 |
|---|---|
| triage 崩溃，或回答读不懂，或回答回来时状态已经变了（第七节） | 规则：再问一次（`triageRetries`） |
| 还是失败 | `askPerson`，页面写明"triage 没有给出可执行的判断" |

---

## 七、triage 的回答 → 系统执行的动作（已定）

### 回答的格式

triage **只回答原因**，不回答动作（冷评后改：两者都写，不一致时听谁的就说不清了）。

```
cause:   FixableLines | WrongApproach | ConflictingHunks | TicketTooBig
       | SetupBroken | UndecidedQuestion | Unfinished
附带的内容（按原因）：
  FixableLines       →  要改的行：[{path, line, what}]
  WrongApproach      →  一句话：旧方案哪里错了（写进下一个 attempt 的 brief）
  ConflictingHunks   →  每个冲突块：建议解法 | 两边逻辑矛盾 | 需要人判断（附问题）
  TicketTooBig       →  拆票方案（可选）；没有方案时写耗时点
  SetupBroken        →  哪里坏了、怎么修
  UndecidedQuestion  →  问题和选项（第四节的格式）
  Unfinished         →  正文要补的一句（可选）
summary: 给人读的一句话
```

### 原因 → 动作

动作由这张表决定，不由 triage 选。

| 原因 | 系统执行 | 前提 | 前提不满足时 |
|---|---|---|---|
| `FixableLines` | `fixRefusal` | 还有 `refusalFixes` | `askPerson`（limit） |
| `WrongApproach` | `startNewAttempt` | 还有 `newAttempts` | `askPerson`（limit） |
| `TicketTooBig` 并附拆票方案 | `splitTicket` | 还有 `ticketSplits` | `askPerson`（limit） |
| `TicketTooBig` 没有方案，出在 `run.turns`/`run.wall` 用完时 | 把耗时点写进正文，然后 `redoStep` | 还有 `stepRedos` | `askPerson`（limit） |
| `TicketTooBig` 没有方案，出在 review 的 diff 太大时 | `askPerson`（limit）：重做不会让 diff 变小 | — | — |
| `Unfinished` | `redoStep` | 还有 `stepRedos` | `askPerson`（limit） |
| `ConflictingHunks` | 有块需要人判断 → `askPerson`（unclear）；否则有块两边逻辑矛盾 → `startNewAttempt`；否则 → `resolveConflict` | 对应的上限还有 | `askPerson`（limit） |
| `SetupBroken` | `askPerson`（environment） | — | — |
| `UndecidedQuestion` | `askPerson`（unclear） | 还有 `personAsks` | `askPerson`（limit） |

- **`limit` 由系统给出，不来自 triage**，写明是哪个上限、用了几次。
- **`Approve`（跳过拒绝直接落地）和 `Close`（关票）只留给人**，表里没有它们。唯一的例外是 `splitTicket` 过的母票经 review 核对后以 `satisfied` 结束（第四节）。

### 执行协议（已定，冷评后新加）

triage 回来时，世界可能已经变了：人关了票、改了正文、或者 head 已经不是 triage 看的那个。所以自动执行和人点按钮走**同一条路**，带同样的校验：

1. **wait 照样开。** 失败时照现在一样开 wait、triage 在 wait 上跑（`TriageStarted{waitId, attempt}`，#1234）。区别只在于：能自动执行的，wait 由系统以 `by: triage` 关掉，页面上只显示一行"系统做了什么、为什么"；`askPerson` 时 wait 留给人。
2. **回答绑定它看的状态**：`waitId`、attempt、head、开始时 ticket 的版本。
3. **执行前核对**：wait 仍是当前的、ticket 版本没变（`finishTriageTransition` 的 `ifVersion` 由可选改为必填，`ticket.ts:1160`）、对应上限还有。任何一项不满足 → 不执行，计一次 `triageRetries` 重新判断；还是不满足 → `askPerson`。
4. **先记决定，再动手**：triage 的回答、系统选的动作、消耗的那一次上限，在同一次追加里写进事件流（带期望版本）。之后的动作由 conductor 读事件执行，跟人点按钮之后一样；中途重启，从事件续上。动作本身按 `waitId` 幂等，重复执行不会做两次。

---

## 八、拆票（`splitTicket`，已定）

1. **方案**：triage 写拆票方案：最多 8 张子票，每张有标题、正文、kind，以及子票之间的先后关系；**每张子票写明覆盖母票的哪几条 Done when**；方案写明母票还剩哪几条没有子票覆盖。
2. **母票正文：原来的 Done when 一字不改。** 子票清单和"哪条由哪张子票覆盖"写在单独的小节 `## Split into`。现在的 `splitDoneWhen`（`packages/conductor/src/split-body.ts:16`）会把 Done when 整段换成"#子票 is closed"，要改掉。
3. **发布屏障**：子票开出来时带一个系统自己的标记（例如 `lingtai:publishing`），队列跳过带这个标记的票。所有子票、依赖、母票的 blocked-by 都写完并读回核对之后，才去掉标记。用自己的标记而不是 `agent:hold`，是为了不误删人后来加的 hold。中断后按现有的标记和对账（0118 §12）续上，标记一直留到核对通过。
4. **母票放回队列**，被所有子票 blocked-by。子票**关闭**就解除依赖（GitHub 的语义，不管是落地、重复还是不做了）；**母票的验收另外判断**。母票再被取出来时，新的 attempt 从 base 开始，只做两件事：
   - **验收**：对照母票**原来的** Done when 逐条检查。子票关了但没做到的那一条，在这里会显出来。
   - **补完**：没满足的那几条，在这次 attempt 里做掉，照常 build、review、merge。

   全部已经满足、没有剩下的事：agent 声明 `AlreadyDone`，逐条给出证据 → review 核对 → `satisfied`（第四节）。
5. **每张根票只自动拆一次**（`ticketSplits` = 1）：子票不能再被自动拆；母票补完时如果又被判定 `TicketTooBig`，也不能再拆。两种情况都 → `askPerson`（limit）。拆过几次读 ticket 事件流里的 `TicketSplit`，重启、重新领取、等子票都不会清零。
6. **母票回来那个 attempt 不计入 `newAttempts`**：它不是"方向错了重来"，而且因为只拆一次，它最多发生一次。一张根票自动派生的工作因此有界：至多 1 张母票 + 8 张子票，每张票自己的上限照常算。
7. 子票必须按 write-ticket 的规范写（原则 6）。现在 triage 写的子票还达不到，0.18.0 会把同一套写票能力用到这里。

---

## 九、上限的名字和数值（已定）

**规则：每个上限一个名字，说清它数的是什么、按什么范围计数。** 意义不同就用两个名字，即使数值相同。所有计数都记在事件里，重启不清零。

| 上限 | 数的是什么 | 出发点 | 计数范围 | 值 | 放在哪 | 旧名字 |
|---|---|---|---|---|---|---|
| **`refusalFixes`** | `fixRefusal`：build 红、review 有 findings，回 implement 在 head 上修 | ➡ 接着往下做 | 每个 attempt | **6** | recipe | `rounds` |
| **`conflictResolutions`** | `resolveConflict`：合并冲突，回 implement 在 head 上解 | ➡ 接着往下做 | 每个 attempt | **6** | recipe | 没有自己的名字，借用 `rounds` 的值 |
| `baseBranchMerges` | `mergeBaseBranch`：base 动了合并进来，再 build | ➡ 接着往下做 | 每个 attempt | 10 | 常量 | `BASE_MERGES_LIMIT` |
| **`landingRetries`** | `retryLanding`：push 遇到瞬时错误后，同一个 head 再落地一次（#1221），不跑 agent | ↻ 同一步再做一遍 | 每个 attempt | 3 | 常量 | 现在和 `redoStep` 共用 `TRANSIENT_RETRIES_LIMIT` 的计数 |
| **`stepRedos`** | `redoStep`：瞬时错误、崩溃、没有回执、回答读不懂、`Unfinished`。**不含**人回答问题之后的继续 | ↻ 同一步再做一遍 | 每个 attempt | 3 | 常量 | `TRANSIENT_RETRIES_LIMIT` |
| `stepRedoWaits` | 每次 `redoStep` 之前等多久 | （跟随 `stepRedos`） | — | 1、5、15 分钟 | 常量 | `TRANSIENT_WAITS` |
| `commandReruns` | `rerunCommand`：检查红了，在同一个 commit 上立刻再跑 | ↻ 同一步再做一遍 | 每次红 | 1 | 常量 | 0108 §17，没有名字 |
| **`newAttempts`** | `startNewAttempt`：从头重来 | ⟲ 从 base 重来 | 每张票 | 2 | recipe | `restarts` |
| **`ticketSplits`** | `splitTicket`：自动拆票 | ⟲ 从 base 重来 | 每张根票（含它的子票） | **1** | 常量 | 没有，新加 |
| **`personAsks`** | `askPerson`（unclear）：design 提问、implement 的 `Unclear`、triage 的 `UndecidedQuestion`，每停下来问一次计 1 | ■ 封顶（用完 → `askPerson`（limit）） | 每张票 | **5** | 常量 | #649 的 `designAsks`（2，只数 design） |
| `run.turns` | 一次 run 的轮数 | ■ 封顶（用完 → triage 判断 `splitTicket` 还是 `redoStep`） | 每次 run | 350 | recipe | `runtime.limits.turns` |
| `run.wall` | 一次 run 的时长 | ■ 封顶（同上） | 每次 run | 75m | recipe | `runtime.limits.wall` |
| `run.usd` | 一次 run 的花费 | ■ 封顶（同上） | 每次 run | 未设置 | recipe | `runtime.limits.usd` |
| `triageRetries` | triage 崩溃、回答读不懂、或回答回来时状态已变，再问 | ↻ 再问一次 | 每次 triage | 1 | 常量 | 没有，新加 |
| `triage.turns` / `triage.wall` / `triage.usd` | 一次 triage 调用 | ■ 封顶（用完 → triage 失败，第六节第 6 类） | 每次调用 | 100 / 15m / $10 | recipe | `triage.limits` |

**■ 封顶**：本身不重跑任何东西，用完时触发括号里写的动作。

**改动说明：**
- **`rounds` 拆成 `refusalFixes` 和 `conflictResolutions`，不再叫 round**：round 听起来像"再来一轮"，容易被理解成整个 attempt 重来；这两个动作其实是在当前 head 上接着修。两者起因和证据不同，分成两个参数，可以各自调整。
- **`restarts` 改名为 `newAttempts`**：`restart` 已经是 `lingtai restart`（重启 daemon）的名字。
- **`landingRetries` 从 `TRANSIENT_RETRIES_LIMIT` 里分出来**：重新落地只是再 push 一次，不跑 agent；`redoStep` 要跑 agent。现在两者共用一个计数，会互相占用次数。
- **`designQuestions` 改为 `personAsks`**：不只数 design，implement 的 `Unclear` 和 triage 的 `UndecidedQuestion` 也算，否则"回答 → 继续 → 又问"没有出口。
- **`splitDepth` 改为 `ticketSplits`**：只限制层数，挡不住母票反复拆；按根票数次数才有界（第八节）。
- **recipe 按计数范围分组**：

  ```yaml
  runtime:
    limits:
      run:     { turns: 350, wall: 75m }                         # 一次 run
      attempt: { refusalFixes: 6, conflictResolutions: 6 }       # 一个 attempt
      ticket:  { newAttempts: 2 }                                # 一张票
  ```

- **recipe 里写旧名字直接拒绝**（已定）：`rounds`、`restarts` 以及不分组的 `runtime.limits.turns` 等，解析时按名字拒绝，报错里写明对应的新名字和新位置，不做兼容。
- **implement 最多跑多少次**：`(newAttempts + 1) × (1 + refusalFixes + conflictResolutions + stepRedos) + personAsks` = 3 × (1 + 6 + 6 + 3) + 5 = 53 次。**这只是 implement 一步，不是整张票的 run 总数**：design、review、judge、triage 各自也跑 agent，各有自己的有限次数（review 每次 implement 之后一次，`mergeBaseBranch` 碰到分支的文件时再一次），ADR 里按步列出，不合成一个数。`landingRetries`、`baseBranchMerges`、`commandReruns` 不跑 agent。每天 $200 的总闸只挡新的 attempt，不能代替这些上限。
- **单张票的花费上限这次不加**：系统还没有按票统计花费的设计。以后需要时叫 `ticket.usd`，放在 `ticket` 分组里。

**`refusalFixes` 定为 6 的依据**：最近 7 天 lingtai 落地 228 张票，0 到 1 次修完的占 79%，5 次以上的占 4%（只看 feature 票是 13%）。按"第几次 review 通过"统计：第 4 次 review 时 16 张过了 8 张，第 5 次时 8 张过了 1 张。人工额外给修复的票里，#1170、#1177 都是多给 1 次就过了。

---

## 十、现在的设置（2026-11-17 盘点，旧名字）

这一节记录改之前系统里实际的设置，所以用旧名字。

### recipe 里可以改的（`~/.lingtai/lingtai/recipe.yml`）

| 设置 | 当前值 | 管什么 | 计数范围 | 新名字 |
|---|---|---|---|---|
| `runtime.limits.turns` | 350 | 一次 run 最多多少轮 | 每次 run | `run.turns` |
| `runtime.limits.wall` | 75m | 一次 run 最长多久 | 每次 run | `run.wall` |
| `runtime.limits.usd` | 未设置 | 一次 run 最多花多少钱 | 每次 run | `run.usd` |
| `runtime.limits.rounds` | 4 | 修复的上限；冲突也用这个数值，但两个计数器各算各的（`run-attempt.ts:1625` 把 `conflictRounds` 设成 `ceilings.rounds`） | 每个 attempt | `refusalFixes` + `conflictResolutions` |
| `runtime.limits.restarts` | 2 | 从 base 重来 | 每张票 | `newAttempts` |
| `source.backoff` | 1h | 票放回队列后，最早多久能再被领 | 每次放回 | 不变 |
| `triage.limits` | turns 100、wall 15m、usd $10 | 一次 triage 调用 | 每次调用 | `triage.*` |
| `runtime.budget.diff` | 400000 字节 | diff 超过这个大小就不交给 review，直接交给人（0108 §14） | 每次 review | 不变 |
| `runtime.concurrency` | 2 | 同时跑几张票（不是出口） | — | 不变 |

### 程序里写死的数值

**循环的出口**

| 位置 | 值 | 管什么 | 新名字 |
|---|---|---|---|
| `TRANSIENT_RETRIES_LIMIT`（`domain/src/failure/respond.ts:586`） | 3 | 原地重跑被瞬时错误打断的 run；落地重试也算在里面 | `stepRedos`、`landingRetries` |
| `TRANSIENT_WAITS`（`respond.ts:589`） | 1、5、15 分钟 | 每次重跑之前等多久 | `stepRedoWaits` |
| `BASE_MERGES_LIMIT`（`respond.ts:579`） | 10 | base 动了之后自动合并 | `baseBranchMerges` |
| 检查红了再跑一次（0108 §17） | 1 次 | build、声明的检查或 base check 红了立刻再跑 | `commandReruns` |
| 回答读不懂再问（0108 §18） | 1 次 | 再问同一个 agent | 并入 `stepRedos` |
| design 提问（`actions/src/agent-action.ts:150-154`，#649） | 2 | 同一张票 design 问满 2 次后不让再问 | `personAsks` |
| 网络不通时重试（`repo/src/network.ts` 的 `retryUnreachable`，默认 `UNREACHABLE_WAITS`） | 等待次数 + 1 | mirror fetch / push 连不上时原地重试 | 不变 |
| GitHub 限流（`github/src/client.ts:577` `MIN_RATE_LIMIT_WAIT`） | 至少 1 分钟 | 锁住 acct-github；没给重置时间就等 1 分钟、再翻倍（#1213） | 不变 |

**triage 的边界**（`domain/src/triage.ts`）

| 常量 | 值 | 管什么 |
|---|---|---|
| `READS_PER_TURN` | 6 | triage 或讨论一轮最多读几个文件 |
| `MAX_READ_ROUNDS`（`conductor/src/read-step.ts:29`） | 4 | 最多读几轮再必须给出回答 |
| `CONFLICT_ROUND_HUNKS` | 5 | 冲突块不超过 5 个，一律 `resolveConflict`，不管 triage 怎么判断 |
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
| 1 | WIP 直接提交到工作分支，sha 记在 `RunKeptUncommitted`；`resolveConflict` 和零提交时不提交；删掉 lane 的 `wip-commit` 拒绝 | `conduct.ts` 的 `keepUncommittedWork`，`integrate.ts`，0108 |
| 2 | 删掉 #1170 的 WIP 携带 | `carry-wip-port.ts`，`conduct.ts` 的 `cut` |
| 3 | `redoStep` 统一成一个工作流：从 head 整步重跑，brief 加说明；去掉 #1201 那套从被打断的 action 接着跑；插件声明 `replay: safe \| external`，recipe 在 prepared、design、implement、review 里拒绝 `external` 的 action；end 的 action 保留完成记录 | 0108 §12，`run-attempt.ts`，`action.ts`，`recipe.ts` |
| 4 | 不认识的崩溃、没有回执、回答读不懂都走 `redoStep`；#1205 的 `askedAgainOn` 随之删掉 | 0108 §12、§18，`attempt.ts` |
| 5 | implement 的 brief 要求分块提交 | implement 的 prompt |
| 6 | implement 的五种结果：结论由 agent 声明，事实（开始的 sha、head、WIP 的 sha）只纠正两种矛盾；去掉 `nothing-produced`（并入 `AgentFailed`）；路由加原因 `already-done`，去向是 review 核对；票加终态 `satisfied`（`TicketSatisfied` 记 base sha、正文版本、逐条证据） | implement 的 prompt，`proposal.ts`，路由，review 的 prompt，ticket 的 reducer，看板 |
| 7 | design 提问、implement 的 `Unclear`、triage 的 `UndecidedQuestion` 统一用 `TriageQuestion` 格式，答案用 `triageAnswersText` 写进正文；回答后的继续不计入 `stepRedos`，每次提问计入 `personAsks` | `agent-action.ts`，`triage.ts`，Waiting 页面 |
| 8 | triage 只回答 `cause`（新加 `Unfinished`），动作由系统按第七节的表决定；执行协议：wait 照开、回答绑定状态、`ifVersion` 必填、先记决定再动手、按 `waitId` 幂等；状态变了计 `triageRetries` 重判 | 0108 §16，0118，`wait.ts`，`ticket.ts`，triage 的 prompt |
| 9 | `run.turns`/`run.wall` 用完时交给 triage，由它判断 `TicketTooBig` 还是 `Unfinished` | 0108 §12 |
| 10 | 自动 `splitTicket`：母票原来的 Done when 不改，子票清单和覆盖关系放 `## Split into`；子票带发布标记，全部写完核对后去掉；每张根票只拆一次（`ticketSplits`）；母票回来验收原标准、补完剩余 | 0118 §12，`split-body.ts`，`split-ticket.ts`，`discover.ts` |
| 11 | 上限按第九节改名、分组：`rounds` → `refusalFixes`（6）和 `conflictResolutions`（6），`restarts` → `newAttempts`，`TRANSIENT_RETRIES_LIMIT` → `stepRedos` 和 `landingRetries`，`designAsks` → `personAsks`（5），新加 `ticketSplits`、`triageRetries`；recipe 写旧名字按名字拒绝，报错写明新名字 | recipe 的 schema，`attemptCeiling`，`respond.ts`，`agent-action.ts`，本机 recipe |
| 12 | 代码和界面里的旧词改成第零节的动作名（清单见下） | domain 的事件和 tag，看板，CLI |
| 13 | #1218、#1219（人在页面上点"重做这一步"）改成走 `redoStep` | 已落地，由第 3 条一起改 |
| 14 | write-ticket 的 Edges 清单、design 的提问清单都加上"一个动作被重做或跳过时，同一步里的其他动作怎么办" | write-ticket skill，`agent-action.ts:1398-1405` |
| 15 | 文档票 #1220（操作指南）、#1223（参考文档、the-attempt）留在 0.15.0，排到上面这些票之后，正文按新术语重写 | 两张票的正文和 blocked-by |

### 第 12 条：改哪些名字，旧事件怎么读（已定）

实际要改的名字（`FixRequested` 早在 #502 就删了，`conduct.ts:5090`，不在清单里）：

| 种类 | 旧 | 新 | 位置 |
|---|---|---|---|
| 事件类型 | `StepRerunInPlace` | `StepRedone` | `events.ts:2813` |
| 事件类型 | `RunAppliedKeptWork` | 没有，随 #1170 删除 | `events.ts:2791` |
| release 的原因 | `Restart` | `NewAttempt` | `events.ts:284` |
| 路由的去向 | `FixRound`、`MergeBase` | `FixRefusal`、`MergeBaseBranch` | `attempt.ts:618-621` |
| 人的决定 | `GrantFixRound`、`RerunStep`、`Requeue`、`EditBodyAndRequeue` | `FixRefusal`、`RedoStep`、`StartNewAttempt`、`EditBodyAndStartNewAttempt` | `wait.ts:248-262` |
| triage 的回答 | `TriageAdvice`（六种建议） | `cause`（第七节） | `wait.ts:279` |

**旧事件留在日志里，不迁移，含义不变：**
- **改名的事件类型**：旧名字进 `RETIRED`（`events.ts:2890`），不再写；reducer 新旧两个名字都读，**含义相同**。照 `PassRouted` 的做法（`attempt.ts:597`，和 `ProposalRouted` 走同一个分支）。不能只是跳过：跳过会改变历史投影、报告和快照重建的结果。
- **改名的嵌套 tag**（payload 里的 `_tag`）：这个类型的 `SCHEMA_VER` 加 1，加一个 upcaster 在读的时候把旧 tag 改成新 tag。照 `WaitTriaged` 的做法（`events.ts:2872`，#591）。
- 旧的 `WaitTriaged` 里的 `TriageAdvice`：建议和原因不是一一对应的，不改写；reducer 照旧读，页面按历史记录显示。
- 不能直接删掉旧名字：读到目录里没有的类型，`decodeRow` 会抛 `LogPredatesHoldError`（`packages/event-store/src/event-store.ts:250`），daemon 启动前的检查（`:303`）也会拒绝启动。
- **验证**：改名的票在 Done when 里要求：用改名前后的代码，各自从空投影把四个投影完整重建一遍，结果一致。

---

## 十二、结论汇总

已定（2026-11-17）：

- 原则 1–7；处理分三层。
- WIP：只来自 implement 的 agent 异常结束，由灵台提交到工作分支，sha 记在事件里；删掉 #1170。
- implement 的五种结果：`Implemented`、`AgentFailed`、`Disputed`、`AlreadyDone`、`Unclear`；结论看声明，事实只纠正两种矛盾；提问统一用 `TriageQuestion` 格式；沿用现有路由，新加 `already-done` 和终态 `satisfied`；`satisfied` 要经 review 核对。
- 六个动作：`redoStep`、`fixRefusal`、`resolveConflict`、`startNewAttempt`、`splitTicket`、`askPerson`；规则直接执行的三个：`rerunCommand`、`mergeBaseBranch`、`retryLanding`。
- `redoStep` 只用于"这一步本身没做完"，只在 prepared、design、implement、review 四步；整步重跑以 action 的重放规则为前提。
- triage 只回答原因，动作由系统决定；自动执行和人点按钮走同一条路、同样的校验。
- `splitTicket`：全自动，保留原 Done when，发布屏障，每张根票只拆一次，母票回来验收原标准并补完。
- 上限名字和数值见第九节：`refusalFixes` 6、`conflictResolutions` 6、`stepRedos` 3、`landingRetries` 3、`newAttempts` 2、`ticketSplits` 1、`personAsks` 5、`triageRetries` 1；recipe 写旧名字直接拒绝；单张票的花费上限这次不加。
- `Approve` 和 `Close` 只留给人；`splitTicket` 过的母票经 review 核对后以 `satisfied` 结束是唯一例外。
- 事件改名：旧事件留在日志里，含义不变（第十一节第 12 条）。
- 这批票放在 0.15.0。

【待定】冷评之后新加、还没和 operator 确认的两条：
- `designAsks` 扩成 `personAsks`，把 implement 的 `Unclear` 和 triage 的提问也算进去（第九节）。
- 母票回来的那个 attempt 不计入 `newAttempts`（第八节第 6 条）。

不在这份方案里：首页加一节可交互的"选一种失败，看系统怎么处理"（operator 2026-11-17 的想法），先在 `doc/design/` 做 mock，确认后单独开 site 的票，排在这批票之后。

下一步：把这份方案改写进 ADR 0108 和 0118，再按第十一节切票。
