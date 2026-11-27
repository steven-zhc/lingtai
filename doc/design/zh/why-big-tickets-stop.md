# 大票为什么老是停下来：数据、一个新发现的缺口，和几个方案

**状态** 讨论稿 · 2026-11-27 · 本文不声称实现了任何东西

这份文档回答一个问题：**一张票稍微大一点，Lingtai 就停下来好多次，是上限给得不够，还是设计上有问题？**

结论先说：**主要是设计问题，不是上限。** 停下来最多的原因是 review 不收敛，而 review 不收敛有一个具体的、新发现的代码缺口（§2）：#671 做的"第二轮只审增量"在 pass 停下等人、再续跑之后就失效了。其次是 implement 没有"做了一部分，让我接着做"这个结局（§4），以及协议太脆（§5）。调高上限对这些都没有帮助（§7）。

文中的数据都来自 git 历史和 GitHub 上 `lingtai-agent[bot]` 的留言，**不是**来自 `events`。日志在 Studio 那台机器上，写这份文档的会话读不到。§9 列出了连上 Studio 之后要用日志核实的事项。按 CLAUDE.md 的规矩，行为上的结论最终以日志为准。

---

## 1. 数据

### 1.1 能落地的票有多大

11 月落地的 674 个 agent 分支，每个分支相对落地分支的 diff（`git diff --shortstat <merge>^1 <merge>`，即增加加删除的行数），再对上每张票的正文：

| | p25 | 中位数 | p75 | p90 | 最大 |
|---|---|---|---|---|---|
| diff 行数 | 217 | 438 | 822 | 1,411 | 3,779 |
| 改动文件数 | 6 | 10 | 16 | 29 | 314 |
| `Done when` 条目数 | 4 | 6 | 7 | 9 | 23 |
| 正文字符数 | 5.3k | 7.9k | 11.3k | 15.2k | 25.6k |

分支上的提交数（大致反映修复轮次）随 diff 变大而上升：

| diff 行数 | 票数 | 提交数中位数 | 提交数 p90 |
|---|---|---|---|
| < 300 | 233 | 2 | 3–4 |
| 300–600 | 181 | 3 | 6 |
| 600–1,000 | 132 | 4 | 7 |
| 1,000–2,000 | 107 | 5 | 12 |
| > 2,000 | 21 | 4 | 18 |

经验上的安全区间：改动不超过约 1,000–1,500 行，`Done when` 不超过 10 条，正文不超过约 15k 字符。

**这是幸存者数据**：只看得到落地的票，看不到中途放弃的、停下等人的、花了多少钱。

### 1.2 停下来等人的 60 次，原因是什么

11-17（triage 开始自动处理跑满上限的情况，#1260）以来，人处理过的停顿共 60 次。按留言里写的原因分类：

| 次数 | 占比 | 原因 | 票 |
|---|---|---|---|
| 31 | 52% | review 一直拒绝；`refusalFixes` 用完（*"`refusalFixes` is spent, 6 of 6 used"*），人批准"再修一轮"，跑完一轮又停 | #1258 #1250 #1339 #1341 #1312 #1274 #1201 #1208 |
| 12 | 20% | 协议或环境：agent 最后没写 `outcome` 块（#1371 连续 5 次）、`ENOSPC`、`pnpm install` 失败、`admit` 的 git 命令失败、检查第一次就红 | #1371 #1240 #1264 #1356 #1339 #1341 |
| 8 | 13% | agent 停下提问，其中 3 次是"一个 pass 做不完" | #1524 #1525 #1435 #1474 #1490 #1517 #1426 |
| 4 | 7% | judge 的回答解析失败（JSON 明明在） | #1258 #1274 #1254 |
| 2 | 3% | diff 超过 400k 字符 | #1242 |
| 3 | 5% | 修复 agent 拒绝修改、方案被判错且 `newAttempts` 用完 | #1250 #1398 #1435 |

**跑满 `run.turns` 或 `run.wall` 停下来的，一次都没有。** 停得最多的几张票都是大票：#1339 2,287 行、17 个提交；#1312 2,310 行、18 个提交；#1250 1,938 行、13 个提交。#1258 一张票停了 11 次，人批准越过拒绝 4 次，最后也没落地。

看 review 每次的拒绝理由，几乎都是新的问题：*"remains reachable"*、*"survives through the red path"*、*"The continuation scenario remains reachable after a second conflict round"*。实验 [012](../../experiments/012-where-the-turns-go.md) §5 测过同样的现象：后一轮的问题有 40% 出现在上一轮已经读过、没提意见的文件里。

---

## 2. 新发现：续跑之后，review 又回到全量

### 2.1 #671 做了什么

#671（父票 #669，2026-10-27 关闭）要的就是"review 收敛"：

> From the second review in a pass, the reviewer (a) rechecks the earlier scenarios as today and (b) looks for new problems only in what the fix changed. A new finding outside the fix's change is demoted to `minor` and goes to the backlog. A re-raised recheck scenario is never demoted.

代码都在：

- 上一次 review 读到的 head 记在 `reviewedSha`（`packages/conductor/src/run-attempt.ts:1607`），review 完整读过 diff 之后设置（`run-attempt.ts:2604-2611`）。
- review 动作拿到 `reviewedSha` 后，额外读修复的增量 `deps.diff(reviewedSha)`（`packages/actions/src/agent-action.ts:1063-1078`）。
- 增量之外的新问题加上前缀 `outside the fix — was ` 降级（`packages/actions/src/diff-hunks.ts:156`）。

### 2.2 缺口在哪

**`reviewedSha` 只是一次 `runAttempt` 里的局部变量，不进日志。** 每次 `runAttempt` 开始，它都是 `null`：

```ts
// packages/conductor/src/run-attempt.ts:1607
let reviewedSha: string | null = null
```

pass 停下来等人之后再继续，是一次新的 `runAttempt`，上下文从日志重建（`packages/conductor/src/conduct.ts:1669`、`:1840`）。上一次 review 读到的 head 由 `reviewedHeadOf` 从日志里读，但它只在中间发生过 base merge 时才返回值：

```ts
// packages/conductor/src/attempts.ts:734
export function reviewedHeadOf(runEvents: readonly Envelope[]): string | null {
  const outcomes = stepOutcomesOf(runEvents)
  const merged = outcomes.findLastIndex((o) => o.step === 'merge' && (conflictedIn(o) !== null || movedIn(o) !== null))
  if (merged < 0) return null
  ...
```

这是 #1274 为 base merge 加的。就算拿到了值，`options.from.reviewedHead` 也只用来设置 `mergedSinceReview`（`run-attempt.ts:1612`、`:2416`、`:2483`），从来不会赋给 `reviewedSha`。

**所以：续跑后的第一次 review，拿不到"上次审到哪"，只能全量冷审。** 全量审就会在修复没碰过的代码里找到新问题，又拒绝，`refusalFixes` 已经用完，又停下来等人。人再批准一轮，又是一次续跑，又是全量。§1.2 里 52% 的停顿，正好落在这个循环上。

### 2.3 为什么当时没发现

#671 自己在 Edges 里写了：

> **A process restart mid-pass**: a resumed pass (`options.from`) has no `reviewedSha`, so its next review is full. That is acceptable: it only costs a fuller review.

并把 *"Persisting `reviewedSha` across a process restart"* 列为 Out of scope。

10-27 那时，续跑只在进程重启时才发生，很少见，"多花一次全量 review"确实可以接受。11 月中以后，续跑变成了常态路径：

- 人批准再修一轮（`FixRefusal`）；
- 步骤没跑完被重做（#1245 `redoStep`）；
- 跑满上限后，triage 安排重做（#1260）；
- 人回答了 agent 的问题后继续（0108 §22）；
- judge 的回答解析失败，人来处理。

**当初"很少发生、可以接受"的前提已经不成立了。** 而人批准再修一轮，正是最需要收敛的时候。

### 2.4 修法

日志里本来就有需要的数据：review 的 `StepEnded` 记录了它读到的 `onSha`，`reviewedHeadOf` 已经会读这个值（`attempts.ts:743-745`）。

1. `reviewedHeadOf` 在中间没有 merge 时，也返回最后一次完整读过 diff 的 review 的 head。被截断的读取（#892）和 `AlreadyDone` 检查（#1251）仍然返回 `null`，规则和 `run-attempt.ts:2604` 那段一致。
2. 续跑时，如果没有 `landedOnBase`，就用 `options.from.reviewedHead` 初始化 `reviewedSha`。有 `landedOnBase` 时，保持 #1274 的做法不变。
3. 和 #671 一样，**复查场景永远不降级**：上一轮问题的 `failureScenario` 原文匹配到的，不管在不在增量里，都保持原严重度。

### 2.5 边界

- **续跑时 head 和 `reviewedHead` 相同**（一轮修复什么都没提交）：没有增量这一节，什么也不降级，复查照常。
- **增量读取失败或为空**：在 run log 里说明，退回全量 review，什么也不降级（#671 原有的规则）。
- **修复 agent 改写了历史**（force-push 盖过 `reviewedHead`）：增量读不出来，按上一条退回全量。
- **人批准过某个 head，之后 base 动了**：#1279 的规则优先，以人批准的 head 为基线。
- **一次新 attempt**（`startNewAttempt`，从 base 重来）：`reviewedHead` 属于旧 attempt，新 attempt 的第一次 review 必须是全量。
- **两个 pass 同时跑**（0122）：每个 pass 只读自己 run stream 上的事件，不共享。
- **对之后其他票的影响**：固定 `reviewedHeadOf` 返回 `null` 的测试要改。

### 2.6 怎样算完成

- [ ] 单元测试：一个 `FixRefusal` 续跑的 review prompt 里有增量这一节，并且没有 *"exactly as you would have without this section"* 这句。
- [ ] 单元测试：上述续跑中，增量之外的新 blocker 被降级为 `outside the fix — was blocker: `。
- [ ] 单元测试：上述续跑中，`failureScenario` 和上一轮问题相同的 blocker 不降级，即使它在增量之外。
- [ ] 单元测试：被截断的 review 和 `AlreadyDone` 检查之后的续跑，仍然是全量 review。
- [ ] 单元测试：新 attempt 的第一次 review 是全量的。
- [ ] `pnpm typecheck` 和 `HOME=/nonexistent pnpm test` 通过；`effect-ratchet.baseline.json` 不升高。

---

## 3. 方案一：review 收敛（§2 之外还剩什么）

之前提的方案一是"第二轮起只审修复的增量加复查，增量外的新问题进 backlog"。**这其实就是 #671，已经做了。** 它没起作用，原因是 §2 的缺口。所以方案一的第一步就是修 §2。

修完 §2 以后，还有几件事值得讨论，但应该**先修 §2，再用日志看剩下多少问题**，不要一起改：

1. **人批准的轮次是一轮一停。** `refusalFixes` 用完之后，人每次批准只买一轮，review 再拒绝就又停。可以讨论：人批准时能否一次给 N 轮；或者在人批准之后，增量之外的新问题一律降级。
2. **major 是否应该算拒绝。** 实验 012 §4：65% 的拒绝里，最高严重度是 major，不是 blocker。major 是判断题，多读几遍就会多出来。可以讨论 major 是否和 minor 一样进 `finding_backlog`（#137），或者只有在增量里的 major 才算拒绝。
3. **大票的修复增量本身就大。** 一次修复改了十几个文件，"只审增量"能收窄的范围有限。这一条和方案二（让大票分段做）有关。

---

## 4. 方案二：implement 加一个"做了一部分，接着做"的结局

### 4.1 问题

`prompts/ticket.md` 只给 implement 三个结局：`Implemented`、`Unclear`、`AlreadyDone`（`prompts/ticket.md:50-80`）。同一个提示词还要求：

> Make the smallest change that closes the issue as written.（`prompts/ticket.md:30`）

> You do not get a warning before your last turn（`prompts/ticket.md:37-38`）

于是面对大票，agent 只有两条路：

- 把做了一部分的工作当成 `Implemented` 交上去，review 发现缺东西，拒绝；
- 选 `Unclear` 停下来问人。#1523 就是这样：*"about 4,000 lines and does not fit one pass. The judge half is committed. How should the rest be delivered?"*。#1525 也是：*"too large for one pass"*，它还自己提出了解决办法：*"Allow several passes on this one branch: commit each green…"*。

在 Claude Code 里，一个会话可以改几十个文件、写几万行，靠的就是做一段、提交、上下文压缩、接着做，中间不用问人。Lingtai 缺的就是这一步。

### 4.2 方案

1. implement 加一个结局 `Progress`：

   ```outcome
   {"outcome": "Progress", "done": ["<Done when 原文>"], "next": "<下一段要做什么，一句话>"}
   ```

   要求 head 动过，而且已提交的代码能通过 `build`。
2. 系统收到 `Progress` 后，不进 review、不叫人，在同一分支的 head 上再派一次 implement。brief 开头写明哪些条目已完成、下一段要做什么，类似 `redoStep` 的那段说明（0108 §12，#1404）。
3. 加一个新的上限，按 0108 §8 的规矩单独命名、单独计数，比如 `implementContinuations`，作用范围是 attempt，写在 recipe 里。用完以后照常交给 review。
4. 只有在 `Implemented` 之后才跑 review，reviewer 看到的是整张票的 diff。

### 4.3 方案二附带：agent 能直接说"这张票太大"

拆票的机制已经有了（#1262），但只有两个入口：一轮跑满 `run.turns`/`run.wall`/`usd` 之后交给 triage，或者 diff 超过 400k 字符（0108 §12、§14；`packages/domain/src/ticket.ts:1481-1490`）。agent 自己判断"太大"时，只能变成一个问题交给人（0108 §22）。

可以让 `design` 和 `implement` 直接回答 `TicketTooBig`，并带上拆分方案，走 `splitTicket`，规则和 triage 的一样。

和 4.2 二选一还是都要，需要讨论：**能在一条分支上分段做完的，用 `Progress`；需要分成几个 PR 或者有依赖顺序的，用拆票。**

### 4.4 边界

- **`Progress` 但 head 没动**：不认，按没跑完处理（`redoStep`），和 `Implemented` 的规则一样。
- **每段仍受 `run.turns`/`run.wall` 约束**：一段跑满上限，照常交给 triage。
- **花费**：每段是一次新的 run，按 $0.10/轮计算（实验 012 §2）。总花费上限要有人愿意写下来。
- **一直 `Progress` 不收尾**：`implementContinuations` 用完就交给 review，不会无限做下去。
- **进程中途重启**：续跑从日志里读已完成的条目，不从内存读（§2 的教训）。

---

## 5. 方案三：协议放宽

占停顿的约 27%（§1.2）。代码其实已经提交、测试也是绿的，只是格式不对。

1. **最后没写 `outcome` 块**：现在按没跑完处理，然后重做（`prompts/ticket.md:79-80`）。#1371 连续 5 次停在这里。可以讨论：head 动过、`build` 通过时，按 `Implemented` 交给 review，由 review 去判断。
2. **judge 的回答解析失败**：`causeIn`（`packages/conductor/src/judge-agent.ts:349`）只要遇到一个候选 JSON 不符合 `JudgeAnswer` 的 schema，就整个返回 `null`（`judge-agent.ts:378`），而 `JudgeAnswer` 是 `z.strictObject`（`packages/domain/src/wait.ts:1185`），多一个字段就不认。**这只是一个可能的原因，还没核实**：要看 #1258、#1274、#1254 那几次 judge 的原始回答才能确定。
3. **环境问题**（`ENOSPC`、`pnpm install`、`git rev-parse`）：这些是 [why-it-stopped.md](../why-it-stopped.md) 一类的问题，不在本文范围。

---

## 6. 另外两个发现

### 6.1 只落地一部分的票，不应解除下游的阻塞

#1423 的规则：在 team 项目里，blocker 落地到 `branch.personal` 之后就不再阻塞。#1523 只落地了一半（`1a730db35`：*"This is the judge half of #1523 only; the one project list is not built yet"*），票依然 open，但它的下游 #1524 被放行了。#1524 在缺少前置代码的分支上开工，`design` 停下问了一次，`implement` 又问了一次，最后是人手工拆出了 #1525、#1526。

可以讨论：只有 attempt 以"整张票完成"结束的落地才算解除阻塞，停下问"剩下的怎么办"的那种不算。

### 6.2 开工前先估大小

#938 已经在讨论（open，`lingtai:hold`）。§1.1 的数据可以作为一个起点，比如正文超过 15k 字符或 `Done when` 超过 10 条，先拆再做。但 #938 自己也提醒过：**误停的代价是人的时间**，阈值要先用日志验证。

---

## 7. 不建议：调高上限

- 代码默认值：`run.turns` 300、`run.wall` 2h、`refusalFixes` 6、`conflictResolutions` 6、`newAttempts` 2（`packages/recipe/src/recipe.ts:3410-3470`）。Studio 上 `~/.lingtai/config.yml` 的实际值，本文没有读到；仓库里 `.lingtai/config.yaml` 注释写的 150/1h/3/1 已经过时，没有程序读它。
- 11-17 以来，跑满 `run.turns`/`run.wall` 停下来的一次都没有（§1.2）。
- 11 月只有 4 张票用过"从头重来"（#1118、#1242、#1258 两次、#1524），依据是 `agent/N-attempt-k` 分支。
- 把 `refusalFixes` 调到 20，在 §2 修好之前，只是让全量冷审多跑几次，晚点停，多花钱。
- 实验 [011](../../experiments/011-patching-versus-starting-over.md)：方案本身错的时候，轮次越多，越修越偏。

另外有一处不一致，顺手统一：0108 §8 写的是 `run.turns` 350、`run.wall` 75m，代码默认值是 300、2h。

---

## 8. 待讨论

1. 先修 §2，用一周的日志看停顿分布变了多少，再决定 §3 的三条做不做。同意吗？
2. 方案二用 `Progress`，用拆票，还是两个都要？分界线放在哪？
3. `implementContinuations` 默认给几次？总花费谁来定上限？
4. §5.1 缺 `outcome` 块时按 `Implemented` 处理，会不会把真正没做完的工作送进 review？
5. §6.1 "整张票完成"怎么判断：看 attempt 的结局，还是看 `Done when` 的每一条？

---

## 9. 连上 Studio 之后，用日志核实

1. **§2 的缺口**：#1258 续跑那次 review 的 `RunPrompted`，确认 prompt 里没有增量那一节。
2. **自动轮次里 #671 是否生效**：同一个 attempt 内，第 2–6 轮 review 的 prompt 里应该有增量那一节，也应该有 `outside the fix — was ` 前缀的降级问题。
3. **§1.2 的分布**：用 `WaitOpened`/`WaitResolved` 按原因统计，代替 GitHub 留言。留言只反映人处理过的停顿。
4. **§1.1 的安全线**：用 `ticket_report` 统计"大小 × 结局"（是否无人干预就落地、等了几次、花了多少），这也是 #938 第 7 个问题。
5. **§5.2 judge 解析失败**：看那 4 次 judge 的原始回答，确认是哪个字段不符合 schema。

---

## 相关

- #671、#669：review 收敛，第二轮只审增量。本文 §2 是它的缺口。
- #1274、#1279：base merge 之后的 review 只看 merge 带来的变化；人批准的 head 作为基线。
- #1245、#1260：步骤没跑完时重做；跑满上限后交给 triage。这两张让续跑变成常态。
- #1262：triage 判断票太大时，daemon 自动拆票。
- #1423：team 项目里，blocker 落地到个人分支就不再阻塞。
- #938：开工前估计大小，讨论中。
- 0108 §8、§12、§14、§22：上限表、重做、diff 太大、提问。
- 实验 [011](../../experiments/011-patching-versus-starting-over.md)、[012](../../experiments/012-where-the-turns-go.md)：修补和从头重来的对比；轮次花在哪里。
