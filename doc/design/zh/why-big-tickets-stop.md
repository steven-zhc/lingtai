# 大票为什么老是停下来：数据、一个新发现的缺口，和几个方案

**状态** 讨论稿 · 2026-11-27 · 本文不声称实现了任何东西

这份文档回答一个问题：**一张票稍微大一点，Lingtai 就停下来好多次，是上限给得不够，还是设计上有问题？**

结论先说：**主要是设计问题，不是上限。** 90% 的 run 在自动轮次里就通过了 review；停在 review 上的只有 3.5%，但它们占了等人停顿的一半以上（§1.2）。这些停顿有四个根因：

1. 全量 review 本身不稳定，票越大越差（§1.3）。
2. 自动轮次里，同一个问题被一轮一轮重新提出，没有停止条件（§3.1）。
3. 第一次停下之后，续跑的 review 回到全量，于是连环停（§2）。这是 #671 留下的缺口。
4. judge 的回答解析失败，自动轮次还没用完，票就提前交给了人（§5）。

调高上限对这些都没有帮助（§7）。implement 没有"做了一部分，接着做"这个结局（§4）是另一类问题，证据比前四条弱。

**数据来源。** §1.1 来自 git 历史。其余数字来自 `events`：2026-11-27 在 Studio 上用只读连接查询，范围是 11-10 以来的 549 个 run、1,203 次 review。引用的 seq 用来当场证明；日志可能被重置，所以每处也写了票号。初稿的 §1.2 是按 GitHub 留言统计的，已经换成日志数据。

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

11-17（triage 开始自动处理跑满上限的情况，#1260）以来，日志里有 80 个 `WaitStarted`。按 `reason` 分类：

| 次数 | 占比 | 原因 | 票 |
|---|---|---|---|
| 45 | 56% | review 拒绝（`ReviewFindings`），细分见下表 | #1170 #1201 #1205 #1208 #1250 #1254 #1258 #1274 #1312 #1339 #1341 #1398 #1435 |
| 13 | 16% | agent 停下提问（`AgentQuestion`） | #1288 #1300 #1348 #1426 #1435 #1474 #1490 #1517 #1523 #1524 #1525 #1529 |
| 7 | 9% | agent 崩溃（`AgentCrashed`） | #1240 #1371 |
| 6 | 8% | 修复 agent 不同意 review 的意见（`FixerDisagrees`） | #1250 #1295 #1385 #1398 #1444 #1474 |
| 3 | 4% | build 红（`BuildRed`） | #1339 #1341 #1395 |
| 6 | 8% | 其他：`SetupRefused` 2（#1264 #1356）、`DiffTooLarge` 2（#1242）、`MergeRefused` 1（#1258）、`MergeConflict` 1（#1250） | |

45 次 review 停顿的细分：

| 次数 | 情况 |
|---|---|
| 35 | 轮次用完。其中 13 次 judge 判了"改几行"但 `refusalFixes` 已用完；22 次是 `NotAsked`：只剩"交给人"一个选项，judge 没被问（`packages/conductor/src/proposed-route.ts:178`） |
| 5 | judge 的回答解析失败（§5.2） |
| 3 | judge 自己交给了人（#1201 #1205 #1208） |
| 1 | judge 判方案错，`newAttempts` 用完（#1435） |
| 1 | judge 选的路已不可用（#1170） |

11-10 以来有 review 的 run 共 549 个：

- **492 个（90%）在自动轮次里通过了 review**，没有人介入。
- **19 个（3.5%）停在 review 上。** 上面那 45 次停顿都来自这类 run，平均每个停两次以上。#1258 的一个 run 停了 11 次（10 次在 review 上），最后被关闭，没有落地。

停得最多的几张票都是大票：#1339 2,287 行、17 个提交；#1312 2,310 行、18 个提交；#1250 1,938 行、13 个提交。

初稿按 GitHub 留言写过"跑满 `run.turns` 或 `run.wall` 停下来的一次都没有"。这一条**还没有用日志核实**：7 次 `AgentCrashed` 里是否有跑满上限的，没有查。

### 1.3 全量 review 不稳定，票越大越差

按 run 第一次产出的 diff 大小分组（`RunProducedDiff`，增加加删除的行数）：

| 首次 diff 行数 | run 数 | 第一次 review 被拒 | 第一次 review 的阻塞问题数 | 平均 review 次数 | 停在 review 上 |
|---|---|---|---|---|---|
| < 300 | 191 | 30% | 0.43 | 1.6 | 0.5% |
| 300–600 | 139 | 54% | 0.88 | 2.0 | 1.4% |
| 600–1,000 | 112 | 64% | 1.45 | 2.5 | 6.2% |
| 1,000–2,000 | 94 | 71% | 1.91 | 3.2 | 9.6% |
| > 2,000 | 13 | 54% | 1.08 | 2.4 | 0% |

另外两个事实：

- **同一个 head 全量重读一遍，会读出新问题。** #1312 的 `152a7f9` 上一次有 1 个阻塞问题，重读后是 4 个新的；#1339 的 `a48ab3b` 重读后多出 1 个新的（seq 55383）。两次都没有任何代码变动。
- **575 次拒绝里，311 次（54%）没有 blocker，最高只是 major。** 实验 [012](../../experiments/012-where-the-turns-go.md) §4 当时测到的是 65%。

所以每多做一次全量 review，就多一次被拒的机会，与修复质量无关。超过 600 行之后，这个机会超过六成。

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

**所以：续跑后的第一次 review，拿不到"上次审到哪"，只能全量冷审。** 全量审就会在修复没碰过的代码里找到新问题，又拒绝，`refusalFixes` 已经用完，又停下来等人。人再批准一轮，又是一次续跑，又是全量。

**日志证实了这一点。** review 的 `RunPrompted` 里有没有 `## What the fix changed` 这一节，就是这次 review 是不是增量：

| 续跑后的第一次 review | 次数 | 被拒 | 平均新增阻塞问题 |
|---|---|---|---|
| 全量，带复查清单 | 27 | 85% | 1.19 |
| 全量，不带复查清单 | 25 | 76% | 1.88 |
| 增量 | 2 | — | — |
| merge 增量（#1274） | 4 | 25% | 0.25 |
| 对照：自动轮次里的增量 review | 498 | 49% | 0.31 |

58 次里 52 次是全量。#1258 的 run `pass-399055d6` 是完整的例子：seq 48186 到 48674 之间，人连续批准 5 次"再修一轮"，每次续跑后的 review 都是全量，每次都带着 1–2 个新问题被拒，每次都直接停下。

**这个缺口解释的是"连环停"，不是"第一次停"。** 每个 run 第一次停下之前的那几轮是自动轮次，在同一次 `runAttempt` 里，#671 是生效的。第一次停的原因在 §1.3、§3.1 和 §5.2。

顺带一提：11-19 #1274 的一次 judge 回答（seq 48544）已经写了 *"On continuation, restore reviewedSha and mergedSinceReview instead of initializing them to null"*。那次回答解析失败（§5.2），交给了人，#1274 最后只修了 base merge 那一种情况。

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

## 3. 自动轮次为什么不收敛

之前提的方案一是"第二轮起只审修复的增量加复查，增量外的新问题进 backlog"。**这就是 #671，已经做了，在自动轮次里也确实生效**：11-10 以来 498 次 review 带了增量那一节。但 6 轮自动修复仍然会用完。原因不在增量机制。

### 3.1 根因：同一个问题被反复重新提出

增量模式下有 239 次拒绝。按阻塞问题的来源分：

| 次数 | 来源 |
|---|---|
| 114 | 只有重新提出的旧问题（`failureScenario` 和上一轮原文相同） |
| 56 | 旧问题加增量里的新问题 |
| 69 | 只有增量里的新问题 |

**"增量之外的新问题降级"几乎没触发过**：平均每次 review 0.02 条。也就是说，#671 防的那种情况在自动轮次里很少出现；真正用掉轮次的是另外两种，其中旧问题重提占了 170 次（71%）。

#1339 的 run `pass-d6236023` 是典型（seq 54951 到 55077）。第一次 review 提出一个 blocker：CI 对 head A 判了绿，有人在 ready 之前推了 head B。之后 6 轮，这个场景每轮都被原文重新提出，`claim` 每轮不同：

- 第 1 轮：*"The head comparison still leaves a check-then-write race."*
- 第 2 轮：*"The new read detects the race after unchecked head B has already been promoted."*
- 第 3 轮：*"The promotion race remains reachable. After the final getPull returns A, recordPrOpened awaits another store read…"*
- 第 4 轮：*"…remains reachable because PrOpened commits before the final read."*
- 第 5 轮：*"…remains reachable when compensation fails."*
- 第 6 轮：*"…remains reachable when recording PrWaiting fails."*

每轮修复收窄一点，reviewer 就找到下一种交错。这是和外部系统（GitHub）之间的竞态，靠补代码关不完。judge 每一轮都判"改几行就行"。`refusalFixes` 用完后停下。之后续跑时的一次全量 review（seq 55383）才指出：*"CI never follows a moved PR head… The same obsolete policy drives the additional reads and draft compensation"*，即这 6 轮修补依据的策略本身已经过时。

19 个停在 review 上的 run 里，6 个在第一次停下之前是这个形态，连续 3 轮以上都有旧问题被重提：#1056、#1152、#1163、#1208、#1254、#1339。

结构上有两处让它停不下来：

- **复查的规则没有终点。** 提示词写的是 *"A scenario that is still reachable by **any** path is still a finding. Report it again, at the same severity or higher"*（`packages/actions/src/agent-action.ts:446-447`）。对"竞态""失败后的补偿再失败"这类问题，永远找得到下一条路径。
- **judge 看不到轮次历史。** 它每轮只读当前的问题，判断"几行还是方案"。同一个场景被提了第 5 次，在它看来仍然是"指明了某一行，改一下就行"。11-19 #1254 的一次 judge 回答倒是看出来了（seq 49079）：*"Five consecutive fix commits have each closed one reader and left another open… Patching readers one at a time has not converged"*，但那次回答解析失败，没有生效。

这和实验 [011](../../experiments/011-patching-versus-starting-over.md) 的结论一致：方案本身不对的时候，轮次越多，越修越偏。

### 3.2 可以讨论的方向

**先修 §2，再用日志看剩下多少问题**，下面几条不要一起改：

1. **同一个场景被重提 N 次以后，不再当成"改几行"。** 比如第 3 次重提时，把重提次数和历次 `claim` 交给 judge，让它在"方案错了""这是可以接受的残余风险，进 backlog""交给人"之间选。N 取多少要看日志：第 2 次 review 时平均有 0.34 个重提，这属于正常修不干净。
2. **人批准的轮次是一轮一停。** `refusalFixes` 用完之后，人每次批准只买一轮，review 再拒绝就又停（§1.2 的 22 次 `NotAsked`）。可以讨论：人批准时能否一次给 N 轮。
3. **major 是否应该算拒绝。** 54% 的拒绝没有 blocker（§1.3）。major 是判断题，多读几遍就会多出来。可以讨论 major 是否和 minor 一样进 `finding_backlog`（#137），或者只有增量里的 major 才算拒绝。
4. **大票的修复增量本身就大。** 增量里的新问题有 125 次（上表后两行）。票越大，一次修复改的文件越多。这一条靠拆票解决（§4.3、§6.2），不靠 review 规则。

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

**证据的分量。** 11-17 以来 `AgentQuestion` 共 13 次，占停顿的 16%（§1.2），其中问"做不完怎么办"的只是一部分：#1525（seq 70879）和 #1529（seq 71056）是，#1524（seq 70841）问的是前置代码不在分支上（§6.1）。13 次没有逐条分类。这类停顿和 review 不收敛是两回事，量也小得多，所以排在 §2、§3、§5 之后。

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

这一类停顿，工作本身往往没有问题，只是系统没读懂 agent 的回答。

1. **最后没写 `outcome` 块**：现在按没跑完处理，然后重做（`prompts/ticket.md:79-80`）。初稿按 GitHub 留言写的是 #1371 连续 5 次停在这里；日志里 #1371 和 #1240 共有 7 次 `AgentCrashed`，具体原因**还没有逐条看**。可以讨论：head 动过、`build` 通过时，按 `Implemented` 交给 review，由 review 去判断。
2. **judge 的回答解析失败**：11-17 以来 5 次，原始回答都在 `ProposalRouted.reply.raw` 里，**5 次都是合法的 JSON**。

   | seq | 日期 | 票 | 原因 |
   |---|---|---|---|
   | 48153 | 11-19 | #1258 | 确定：`fixes` 里"补测试"那一条写了 `"path": null, "line": null` |
   | 60080 | 11-24 | #1398 | 确定：同上 |
   | 48544 | 11-19 | #1274 | 未确定 |
   | 49079 | 11-19 | #1254 | 未确定 |
   | 49479 | 11-19 | #1258 | 未确定 |

   `LineFix.path` 是 `z.string()`，不允许 null（`packages/domain/src/wait.ts:1080`）；`line` 允许。`causeIn` 遇到一个不符合 schema 的候选就整个返回 `null`（`packages/conductor/src/judge-agent.ts:378`）。没有对应文件的修复条目（补测试、改文档）是 judge 的正常回答，schema 应该接受。

   11-19 那 3 次，字段都在、长度都在 1,200 以内，按今天的代码看不出为什么不认。11-18 有两个相关修复（`df8559a7f`、`b6327ae06`），当时的 daemon 可能还没重启到它们上面。**这一点没有核实。**

   这 5 次的代价比次数大：#1258 和 #1274 在第 2 次 review 之后、#1398 在第 4 次之后就因此交给了人，自动轮次还没用完，之后就进了 §2 的连环停。两次被丢掉的回答内容还是对的（§2.2 末尾、§3.1）。
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

- Studio 上实际生效的值（`~/.lingtai/lingtai/recipe.yml:253-255`）：`run.turns` 350、`run.wall` 75m、`refusalFixes` 6、`conflictResolutions` 6、`newAttempts` 2，和 0108 §8 一致。代码默认值是 300、2h（`packages/recipe/src/recipe.ts:3410-3470`）。仓库里 `.lingtai/config.yaml` 注释写的 150/1h/3/1 已经过时，没有程序读它。
- 90% 的 run 用不到 6 轮就通过了；用完 6 轮的那些，§3.1 说明再给轮次也只是继续补同一个洞。
- 跑满 `run.turns`/`run.wall` 而停下来的次数还没有用日志核实（§1.2）。
- 11 月只有 4 张票用过"从头重来"（#1118、#1242、#1258 两次、#1524），依据是 `agent/N-attempt-k` 分支。
- 把 `refusalFixes` 调到 20，在 §2 修好之前，只是让全量冷审多跑几次，晚点停，多花钱。
- 实验 [011](../../experiments/011-patching-versus-starting-over.md)：方案本身错的时候，轮次越多，越修越偏。

另外有一处不一致，顺手统一：0108 §8 和 Studio 的 recipe 都是 `run.turns` 350、`run.wall` 75m，代码默认值是 300、2h。

---

## 8. 待讨论

1. 先修 §2 和 §5.2 的 `path: null`（两处都小、边界清楚），用一周的日志看停顿分布变了多少，再决定 §3.2 的几条做不做。同意吗？
2. §3.1 的重提：第几次重提开始换一种处理？"可以接受的残余风险"由谁来判，judge 还是人？
3. 方案二用 `Progress`，用拆票，还是两个都要？分界线放在哪？按 §4.1 的证据，是不是可以先只做拆票的入口（§4.3）？
4. `implementContinuations` 默认给几次？总花费谁来定上限？
5. §5.1 缺 `outcome` 块时按 `Implemented` 处理，会不会把真正没做完的工作送进 review？
6. §6.1 "整张票完成"怎么判断：看 attempt 的结局，还是看 `Done when` 的每一条？

---

## 9. 日志核实的结果，和还没查的

2026-11-27 已核实：

| 事项 | 结果 |
|---|---|
| §2 的缺口 | 成立。续跑后的第一次 review，58 次里 52 次是全量（§2.2） |
| 自动轮次里 #671 是否生效 | 生效：498 次 review 带增量一节。但降级几乎不触发，不收敛的原因是旧问题重提（§3.1） |
| §1.2 的分布 | 已换成 `WaitStarted` 的统计 |
| 大小和结局的关系 | 第一次 review 的被拒率从 30% 升到 71%，停在 review 上的比例从 0.5% 升到 9.6%（§1.3） |
| judge 解析失败 | 5 次里 2 次确定是 `path: null`（§5.2） |

还没查：

1. **11-19 那 3 次 judge 解析失败的原因**（§5.2）：对一下当时 daemon 的 `ConductorStarted` 提交和 `df8559a7f`、`b6327ae06` 的先后。
2. **7 次 `AgentCrashed` 各是什么**（§5.1）：没写 `outcome` 块、跑满上限，还是别的。
3. **13 次 `AgentQuestion` 逐条分类**（§4.1）：多少是"做不完"，多少是真的需要人决定。
4. **花费**：停在 review 上的 19 个 run 各花了多少（`RunSpent`），和无人介入就通过的 run 对比。这也是 #938 的第 7 个问题。
5. **6 次 `FixerDisagrees`**：修复 agent 不同意 review 意见时，谁是对的。本文没有分析这一类。

统计方法：一次 review 是不是增量，看它的 `RunPrompted` 里有没有 `## What the fix changed`；一个阻塞问题是不是重提，看它的 `failureScenario` 是否和同一 run 上一次 review 的某个阻塞问题原文相同；阻塞问题指 blocker 和 major。

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
