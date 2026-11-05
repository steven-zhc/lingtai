# Triage 的问题、你的选择和 fix brief：等待页上的信息流

这份文档讲一张票停下来等人以后，信息是怎么流动的。

- triage 提出的问题，最后由谁回答；
- 你的选择存在哪里，谁读得到；
- fix brief 是什么，什么时候用；
- 页面上每个按钮分别做什么；
- 日志里记下了哪些内容。

它讲的是机制，不重复决定本身。每一节都链接到定下该规则的 ADR 条目。规则以 ADR 为准；两者不一致时，以 ADR 为准，并改这份文档。

术语按仓库的约定：**attempt** 是对一张票的一次尝试，**run** 是一次 agent 调用，一个 attempt 里可以有多个 run；**reduce** 是把一条 stream 的事件折叠成状态。

## 1. 一条规则

> triage 给出的是建议，不会自己进入 prompt。你在页面上的选择是你的决定：凡是会派 agent 的按钮，执行之前都先把答案写进 ticket 正文。

- 问题的单选框默认勾在 triage 推荐的答案上。没改就点按钮，等于接受推荐。
- 在看不到选项的地方做操作（首页卡片、命令行），也按接受推荐处理。
- 所以 agent 只从一个地方读到你的答案：**正文**。

依据：[0118 §6](../../decisions/0118-a-hold-explains-itself.md)（*A pick is the person's, so every resolution that sends an agent carries it*）、§1、§8。实现见 #921、#922。

## 2. 每样东西放在哪，谁读得到

| 东西 | 存在哪里 | 谁读 | 谁读不到 |
|---|---|---|---|
| **triage 的结论**（原因、问题和推荐答案、建议修的行） | 日志里的 `WaitTriaged` | 等待页；Discussion 里的 agent；修复轮的 brief，但**只读** `FixableLines` 里建议修的行；`lingtai status` | 实现 agent 和 cold reviewer |
| **页面上的勾选** | 只在页面内存里（`apps/board/src/app/triage-picks.tsx`），绑在当前 wait 上 | 只有页面，用来预填要写的文字 | 任何 agent。离开页面就没了（页面会提示先复制草稿） |
| **正文里的答案段** | GitHub issue 正文里的一段，用标记 `ticket/waitId` 找到；同一个 wait 再写一次会替换这一段，不会多出一段 | 实现 agent、修复 agent、cold reviewer（按正文审）、下一次 triage、Discussion agent、人 | 没有。之后每次 attempt 都读得到 |
| **你在 wait 上的决定** | 日志里的 `WaitResolved`；写了正文的那条带 `answers`：每题选的答案 id，以及写进正文的原文（#924） | 人（任务页的记录、`lingtai status`）；对照 `WaitTriaged` 能查出你改了哪题 | agent 不直接读，它们读正文 |
| **fix brief** | 每轮修复开始时现拼（`packages/conductor/src/fix.ts` 的 `fixBrief`），作为修复 agent 的 prompt 发出；发出的 prompt 记在 `RunPrompted` 上（见第 7 节） | 只有这一轮的修复 agent | 其他人；下一轮重新拼 |
| **按钮旁写的理由**（Requeue 的 why、Approve 豁免的理由、Close 的理由） | `WaitResolved.note` | 人 | agent。Requeue 的理由不会进后续 attempt（`approve.ts` 里 `requeue()` 的注释） |

## 3. 一轮修复是什么：不是 turn，也不是 start over

| | 是什么 | 从哪里开始 | 已有的改动 |
|---|---|---|---|
| **turn** | agent 和模型的一来一回 | — | — |
| **一轮修复**（fix round） | 同一个 attempt 里再派一个修复 run | 当前分支、当前 worktree、当前 commit | 保留，在上面改 |
| **start over**（Requeue） | 一个新的 attempt | base，新的分支 | 扔掉，从头实现 |

- 一轮修复在原来的 worktree 里跑。修复 agent 看到的 diff 是这个分支到目前为止的全部改动；它只改被拒的地方，然后提交。
- 一轮里有很多 turn。turn 的上限是每个 run 一个数，不是整个 attempt 的总数（[0118 §2](../../decisions/0118-a-hold-explains-itself.md)，*at most T a run*）。
- 修完以后，拒掉它的那一步重跑：测试红了就重跑 build，reviewer 拒了就重新 review。
- 轮数有上限，就是 brief 开头写的 *fix round N of M*。M 来自 recipe，用完就停下来等人，这时才有 triage。
- **Continue fixing** 是轮数用完以后由人再批一轮，仍然在保存下来的分支上继续。
- **Start over** 读得到正文，但读不到任何 fix brief。所以点 Requeue 重来时，只有正文能把你的答案带过去。

## 4. fix brief：谁用，什么时候用，里面有什么

fix brief 就是修复 agent 的 prompt。修复 agent 拿不到实现 agent 的思路（brief 开头写着 *"You are not given the implementer's reasoning"*），它的全部上下文就是 brief 加上 worktree。

### 什么时候用

| 触发 | 谁决定修 | brief 里的证据 | 经过 triage 吗 |
|---|---|---|---|
| `build` 的测试红了，或者 verify 失败 | 内置规则，自动（`judge.ts` 的 `BUILT_IN_FOR`） | 红掉的输出 | 不经过 |
| reviewer 拒了，有 findings | recipe 在 `findings` 上配置的 judge agent 判定「改这几行」，自动 | findings 原文 | 不经过 |
| 自动轮数用完，停下来等人 | 你点 Continue fixing，或者跑 `lingtai grant-fix-round` | findings、输出或冲突的路径 | 经过：triage 提问，你勾选，答案先写进正文 |

大多数修复轮是自动跑的，没有人参与。reviewer 的意见、红掉的测试，全靠 fix brief 才能传到修复 agent 手里。

### 一张票的典型过程

1. **实现**：conductor 取到票，在新的 worktree 和分支上派实现 agent。prompt 里带着正文；取票事件 `TicketClaimed` 也记下了这份正文（#926）。
2. **build 红了**：内置规则自动买一轮修复。brief 带着红掉的测试输出；修复 agent 改完、提交，build 重跑。
3. **review 拒了**：cold reviewer 按正文审，给出 findings。judge 判定「改这几行」，自动再修一轮，这次 brief 带的是 findings 原文。
4. **轮数用完，停下来等人**：triage 读 ticket、diff 和代码，给出原因、推荐的按钮，必要时提问。
5. **你在页面上勾选**：问题默认勾在推荐答案上，可以改；这时勾选还只在页面里。
6. **你点 Continue fixing**：先把当前勾选写进正文，写成功了才批一轮。这一轮从 `TicketContinued` 开始，它也记下了这时的正文。brief 带着 findings、正文（含你的答案）和 diff。
7. **review 再审**：reviewer 按正文审，看得到你的答案，不会把你的决定当成 finding。
8. **合并**。

第 6 步如果点的是 Requeue，就是从 base 开一个新的 attempt，回到第 1 步。旧分支和所有 fix brief 都不要了，只有正文（含你的答案）跟过去。

### 里面有什么

1. **轮次**：第几轮，共几轮。
2. **证据**：reviewer 的 findings 原文、红掉的检查输出，或者冲突的路径和两个 sha。它是判断修没修好的标准，re-review 只问这些有没有解决。
3. **批准这一轮的人接受的修改**：只在 `FixableLines` 时出现，内容是 triage 建议修的几行 `文件:行号`。这类没有可选项，点修复就等于接受。冲突 hunk 的答案不再放在这里，只从正文来（0118 §8）。
4. **ticket 正文**，包括写进去的答案段。
5. **这一版的 diff**，以及规则：只改被拒的地方，不改别的，必须提交。

## 5. 正文和 fix brief 的分工

| | 正文 | fix brief |
|---|---|---|
| 回答的问题 | 这张票要做成什么样 | 这一版改动哪里不行、怎么改 |
| 有效期 | 长期：之后每次 attempt、每轮修复、每次 review 都读 | 只管一轮 |
| 读者 | 实现 agent、修复 agent、reviewer、triage、人 | 只有这一轮的修复 agent |
| 放什么 | 需求，以及你对 triage 问题的回答 | findings、测试输出、diff、建议修的行、轮次和规则 |

**为什么 findings 和建议修的行不写进正文：**

- **会过期。** `a.ts:42 这里漏了 null 检查` 说的是这个分支上的这一行；从 base 重来以后可能根本没有这一行，正文里却一直留着。
- **会污染标准。** reviewer 按正文审，findings 一旦写进正文，就从「这一版的问题」变成了「票的需求」。
- **正文会越来越长。** 每轮都写一遍，几轮之后 prompt 里大半都是旧轮次的记录。

**为什么你的回答写进正文，而不是 fix brief：**

- **reviewer 只读正文，不读 fix brief。** 如果你的选择只写在 brief 里，修复 agent 照做以后，reviewer 不知道这是你定的，会把它当成 finding 拒掉，于是又多花一轮钱。这是最关键的一条。
- **一轮修复不一定是最后一轮。** 之后点 Requeue 重来时，正文里的答案还在，不用再答一次。
- **这是决定，不是证据。** 正文没说清楚 ticket 要什么时，triage 就用 `UndecidedQuestion` 来问；回答它就是在补需求。
- **冲突 hunk 的答案也写进正文。** 它回答的是「两边行为不同时，以哪边为准」，换一个分支也成立。答案里的 `文件:行号` 可能过期，但它只是辅助，起作用的是问题里描述的行为差异。

一句话：**正文放决定，fix brief 放这一轮的证据。**

## 6. 每个按钮怎么处理

| 按钮 | 写正文吗 | 写什么 | 然后发生什么 |
|---|---|---|---|
| **Write it into the body & requeue** | 写 | 输入框里的文字。输入框按勾选预填，可以改；改过以后就不再跟着勾选变 | 从 base 开一个新的 attempt |
| **Continue fixing**（GrantFixRound） | 写 | 当前勾选的答案，包括你改过的 | 在原分支上再修一轮 |
| **Requeue / Start over from base** | 写 | 当前勾选的答案；Why 只进日志 | 从 base 开一个新的 attempt |
| **Approve** | 不写 | —（理由进日志） | 从记录的 commit 继续，豁免拦下它的检查 |
| **Split** | 不写 | — | 按 triage 的拆分方案开子票 |
| **Close** | 不写 | —（理由进日志） | 结束这张票 |
| **首页卡片的一键按钮** | 修复或 Requeue 时写 | triage 推荐的答案（首页看不到选项） | 同上 |
| **命令行** `grant-fix-round`、`requeue` | 写 | triage 推荐的答案 | 同上；没有 GitHub 凭证就拒绝，不会不带答案就继续 |
| **重新排期**（已批准、但没排上时再点一次） | 不写 | — | 只补排期，不会用默认答案覆盖已经写进正文的答案 |

只有 triage 已经完成、并且真的提了问题时才会写正文，也就是 `UndecidedQuestion`，或者带 `Divergent` hunk 的冲突。其他原因、triage 还在跑或失败了、冲突超过 5 个 hunk，按钮的行为都和以前一样。

**出错时：**

- **写正文失败**：什么都不执行，按钮上显示原因。绝不会不带答案就开工（0118 §6，*The body is written first*）。
- **写进去了，但操作被拒**（别人先处理了这个 wait）：答案段留在正文里，页面说明现在的状态。
- **页面过期**（triage 变了，或者 wait 已经过去）：拒绝操作，提示刷新，什么都不写。
- **同一个 wait 点了两次**：答案段被替换，不会出现两段。

## 7. 日志里记了什么

按「日志说了算」的原则，每个 agent 被告知了什么、每个人决定了什么，都要能从日志里回答，不依赖 GitHub 上可能已经改过的正文。依据：[0100 §14](../../decisions/0100-one-append-only-log.md)、[0109 §1](../../decisions/0109-the-core-takes-a-ticket.md)。

| 问题 | 记在哪里 |
|---|---|
| 这一次 attempt（或一次继续）读到的正文 | `TicketClaimed`、`TicketContinued` 的 `body`（#926） |
| 每个 agent 收到了什么 prompt | 每次付费调用一条 `RunPrompted`，带和 `RunSpent` 一样的 `for`（#923） |
| prompt 里重复的大块内容 | 换成引用：正文引用取票事件，命令输出和 design 文档引用对应的 `StepEnded`，diff 记两个 sha、字节数和 sha256（#927 用在 review 和 fix 上；#928 用在实现 agent 上，并且由 conductor 统一写，hook 不再写）。还原就是把引用代回去，能逐字复原 |
| 你在 wait 上选了什么、写了什么 | `WaitResolved.answers`（#924） |
| 跑的是哪个版本的 runtime | 每条 `RunPrompted` 上记 runtime 自己报告的版本（#929） |
| recipe | 每个 `configHash` 只记一次，放在自己的 stream 上；`StepsResolved` 只带 hash（#930，[0104 §13](../../decisions/0104-the-recipe-is-the-pipeline.md)） |

`RunPrompted` 只是 Lingtai 组装的那一部分，不是 agent 的全部上下文。runtime 自带的 system prompt 和工具定义我们读不到，这台机器 `~/.claude` 下的配置也会作用到每个 run 上（`lingtai doctor` 有提示）。日志里只记 runtime 的版本。仓库里的说明文件不用另记，用 `baseSha` 就能从 git 复原。

## 8. 已知的问题

- **在 fixer 拒绝之后批的修复轮，拿到的依据是错的**（#935）。`grantCriterion`（`packages/domain/src/wait.ts`）在「fixer 拒绝」这种 wait 上，把 fixer 自己的拒绝原文（只保留 500 字）当作 review 交给下一轮，reviewer 原来的 findings 没有传进去。#911 就是这样连续两轮白花钱。#935 修好之前，这种 wait 上不要批修复，应该改用 Approve 或 Requeue。
- **prompt 里的引用，board 上暂时看不到原文**（#933）。在它落地之前，attempt 页签上显示的是引用标记，标记里写着类型、sha 和大小。
- **合并到 main 的改动要等 daemon 重启后才生效。** 正在跑的 daemon 用的是它启动时的代码。上面列的这些行为，要等 `lingtai restart` 以后才会出现。

## 相关的票

- #921、#922：会派 agent 的按钮都先写正文；任务页把勾选传给服务端。
- #923、#927、#928、#929、#933：`RunPrompted` 覆盖每次调用，改成引用，记 runtime 版本，在 board 上还原。
- #924：`WaitResolved.answers`。
- #926：取票事件和继续事件带上正文。
- #930、#931、#932：recipe 只记一次；`PassRouted` 改成引用 `StepEnded`。
- #935、#936：在 fixer 拒绝后批修复的依据；#911 补的测试。
