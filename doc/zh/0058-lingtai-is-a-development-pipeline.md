# 0058 — 灵台是一条开发流水线，一趟 pass 有九站

**状态** **提议中（proposed）** · 2026-09-22 · **本仓库第一份不是 `accepted` 的
ADR**，这是有意的：§2 的分界是其余一切所依赖的地基，而它还在讨论中。 ·
**修正 [0015](../decisions/0015-five-gates-and-two-extensions.md) 的框架表述，不动它的任何规则**

> 这是 [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) 的中文本。
> **英文本是正本**；两者意见不一致时以英文本为准。

灵台不是一个带五个扩展点的通用工作流引擎。它是一条形状固定的开发流水线，那五个点
是它**做判断**的地方。另外四站是它**干活**的地方 —— 它们和那五个点一样可配置，
但永远不产出裁决。

## 背景

### 造出来的东西是 git、diff 和 issue 形状的

每一站都指向软件开发特有的东西，没有一站经得起"换一种工作"的追问：

```
claim        取一张 issue，它的标签决定优先级
admit        一个 gate point
worktree     从 git 镜像按 base ref 切出工作树
prepared     跑一个包管理器的 install
implement    一个 agent 写代码并提交到分支
proposed     跑构建；一个 reviewer 读 **diff**
merge        一个 gate point
merge lane   把 base 并进来、verify、再并出去
end          关掉并标记一张 **GitHub issue**
```

[0015](../decisions/0015-five-gates-and-two-extensions.md) 把这件事表述成
*五个 gate 和两种扩展* —— 一个工作流引擎，插件往它的点上挂东西。正是这个表述
让 `admit` 和 `merge` 读起来像是 `proposed` 的可配置同类，也正是它把
`worktree`、`implement` 和 merge lane 整个排除在模型之外：它们不是扩展点，
所以在那个表述下它们什么都不是。

**0015 立下的规则全部保留。** gate point 的集合是封闭的；插件只能做两件事。
变的是这份文档不再声称这条流水线是通用的，而 0015 没有词可称呼的那些站点
得到了名字。

### 看板画不出模型没有命名的东西

`apps/board/src/app/rail.tsx:109` 画的是 `points.map(...)` —— 五段，一段一个
gate point —— 并把名字与折叠的当前标签相符的那一段点亮。而在修复轮里那个标签是
`fixing round 1 of 3`，它不是那五个中的任何一个，于是**没有任何一段被标记，
眼睛落在最后一段绿色上**。2026-09-22 在 `#179` 上观察到：rail 读起来像停在
`prepared`，而那趟 run 已经在 `proposed` 的修复轮里跑了十八分钟。

折叠本身没错 —— `progress.ts:345` 是特意设这个标签的，`task_view.note` 里
也带着它。是那条五段的尺子上没有这一格。

**rail 画不出的那些站，正是时间的去处。** 据
[012](../experiments/012-where-the-turns-go.md)：一次实现 run 是 44–67 turns，
一个修复轮 31 turns，加起来基本就是一趟 pass 的全部，而那些 gate 不过是三条命令。

### 流水线的大部分早已在日志上

九站里有八站今天就在追加事件：

```
claim        WorkItemClaimed                                          263
admit…end    GateRequested · GateStarted · GatePassed · GateFailed
worktree     —— 没有自己的事件；它的路径挂在 RunStarted 上
implement    RunStarted 260 · RunFinished 227
修复轮       FixRequested 203 · FixApplied 202 · FixDeclined 24
merge lane   IntegrationAttempted 153 · Succeeded 123 · Refused 31
end          EndActionsResolved                                       237
```

所以下面这套词汇表，大半只是给日志已经记录的东西一个名字。

## 决定

### 1. 工作流是固定的，而且它是一条开发工作流

灵台不提供工作流编排器。它提供**一条站点预先已知的流水线**，并为它所指向的
仓库配置每一站。需要另一种流水线的项目，不是灵台服务的项目。

这是一次收窄，而且它是对现存之物的诚实描述。它同时买到了通用引擎买不到的
东西：**系统能够提议配置，因为它知道每一站是干什么的。** `#161` 对 gate point
已经在这么做了 —— 读仓库的脚本、标签和默认分支。

### 2. 两类站点，只有其中一类做判断

| | 配置的是 | 产出 | 能否拒绝 |
|---|---|---|---|
| **gate point** | 用什么来判 —— 一条命令、一个 reviewer、一组 glob、一个人 | **裁决** | **能** |
| **work station** | 怎么把事做成 —— 一个 ref、一个 agent、一种合并策略 | 那个东西本身 | **不能** |

**这是本 ADR 的承重墙，也是它状态为"提议中"的原因。**

一个 work station **可以失败** —— clone 可能 404，agent 可能崩 —— 而失败不是拒绝。
拒绝是一句关于这次改动的话；失败是一句关于机器的话。
[0057](../decisions/0057-a-gate-that-did-not-finish.md) 在低一层为 gate 内部的
agent 画过完全相同的这条线，而
[012 §4](../experiments/012-where-the-turns-go.md) 量过把两者混为一谈的代价：
**10% 的 `review` 拒绝不含任何 finding，却照样买了一轮 fix。**

**护栏。** 没有这条线，"每一站都可配置"会悄悄把封闭的 gate point 集合变成开放的，
而 0015 为插件所做的整个论证 —— *点的集合永远封闭，所以插件可以依赖它们* ——
也就跟着没了。**work station 不是 gate point，也不会因为被配置而变成 gate point。**

### 3. 九站就是那套词汇表，UI 与 recipe 共用

```
1  claim         干活   取哪张票，它的 kind 和优先级
2  admit         GATE
3  worktree      干活   工作副本从哪里来
4  prepared      GATE
5  implement     干活   哪个 agent、哪个模型、什么限额来写这次改动
6  proposed      GATE
7  merge         GATE
8  merge lane    干活   这次改动怎么被集成
9  end           GATE
```

外加两个循环，它们不是站点，但仍然必须画得出来：

```
修复轮     proposed 拒绝 → 回到 implement → 再走 proposed      rounds: 3
restart    整趟 pass 从 base 重来，带着拒绝它的东西            restarts: 1
```

**一站一个名字，rail、recipe 和日志共用。** 今天同一样东西在 `the-pass.py` 里叫
`the agent`，在日志上叫 `RunStarted`，在 recipe 里根本没有名字。

### 4. init 配置每一站，人可以覆盖其中任何一条

在 `lingtai init` 和 `lingtai add` 的时候读取仓库，每一站得到一份被提议的配置 ——
`prepared` 用哪个包管理器、`worktree` 用哪个默认分支、`implement` 用哪个已登录的
runtime、`proposed` 用哪个测试脚本。人可以改动其中任何一项，而改动会像 gate 一样
被记进 recipe。

**检测出来的是默认值，不是"不必被告知"的理由** ——
[0046 §3](../decisions/0046-lingtai-is-personal.md) 的规矩，从只管 `runtime.agent`
推广到每一站。

[0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md)
已经是这条规则的第一个实例：它配置的就是 `implement` 这一站 —— 哪个 agent、
哪个模型、什么限额 —— 而它已被接受，实现就在一个尚未合并的分支上。
**它不被本 ADR 取代；它是本 ADR 所推广的那个范式。**

### 5. 本 ADR 不改变什么

- **五个 gate point 仍然是五个，集合仍然封闭**（0015）。
- **一个配置了却静默不运行的点，是灵台自己的 bug**
  （[0016 §4](../decisions/0016-the-settled-model.md)）。`#61` 量出三十格里仍有
  十格是静默的；给 work station 命名并不为它们开脱。
- **recipe 是这台机器的**（[0046 §3](../decisions/0046-lingtai-is-personal.md)），
  仍然在 `~/.lingtai/<project>/recipe.yml`。
- **一趟 run 拿到的是什么，在日志上**
  （[0047](../decisions/0047-the-recipe-a-run-got-is-on-the-log.md)）。一站的配置
  是那份记录的一部分。

## 后果

**rail 的对齐不必等这一切建成。** 九站里八站已经在日志上，所以把一趟 pass
如实画出来不需要改 schema、不需要改 recipe、也不碰 0015。这件事本身值得先做，
而且它是对 §3 那套命名的一次检验：如果 `implement` 或 `merge lane` 印在卡片上
读着不对，在 recipe 用上这个词之前发现要便宜得多。

**recipe 会长出一个它现在没有的形状。** `gates:` 有五个键，而站点有九个。
work station 是与 `gates:` 并列，还是统一收进一个 `pipeline:`，本 ADR 不决定，
而且不该在 §2 定下来之前决定。

**`admit` 变得更难被放着不管。** 在 0015 的框架下，一个没被使用的点就是"没人配
的点"；在 §3 下它是固定序列里一个什么都不做的站 —— 那就是 `#61` 的主题，
现在有了把它关掉的理由，而不只是把它记录下来。

**每一份写着"五个点"的 ADR 都需要重读一遍**，但不是重写：它们大多指的是 gate
point，而且是对的。要查的是那些用"点"来指"阶段"的地方。

## 尚未决定

- **§2 的分法是否正确。** 一个拒绝集成的 merge lane，看起来非常像一次裁决 ——
  而答案也可能是：**它本来就是一个没人声明的 gate point。** 这正是本 ADR
  保持"提议中"所要讨论的问题。
- **work station 在 recipe 里住哪**，以及它们的配置要不要像 gate 那样被算进
  `configHash`。
- **work station 能不能被一个扩展替换**，还是只能被配置。0015 给了插件两种权力，
  这会是第三种。
- **`claim` 可以被什么配置。** 把它列为一站，是因为不列它这个序列就不诚实，
  而不是因为关于它有任何决定。
