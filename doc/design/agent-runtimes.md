# 按职责选择 Claude Code 与 Codex：开发文档

**Status** accepted · 2026-09-17 · implementation pending

每个项目可以选择 Claude Code 或 Codex 开发，并为 discussion 和每个 review
门禁单独选择 agent。例如：Codex 开发和修复，Claude Code review；也支持反向组合、
全部使用同一种 agent，以及两个门禁分别使用不同 agent 审查。

这是已讨论接受的目标行为与实施计划。本文的配置示例和接口是待实现的契约，
不是当前版本的操作说明。本次只落成文档，没有实现适配器或迁移实际用户配置。

关键决策见 [0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md)
和 [0054](../decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md)。

## 1. 当前实现与需要补齐的地方

| 位置 | 当前情况 | 目标 |
|---|---|---|
| `packages/agent/src/codex.ts` | 能力声明、登录探测和拒绝运行的 stub | 可执行、可取消、按职责配置的 Codex 适配器 |
| `apps/cli/src/run.ts`、`conduct.ts` | 固定创建 Claude Code runtime | 根据项目解析后的配置选择适配器 |
| `packages/conductor/src/run-once.ts` | 开发、review、fix 共用一个 runtime；review 共用开发 worktree | 按职责分配 runtime；review 使用独立 worktree |
| `packages/actions/src/from-recipe.ts` | 所有 agent 门禁共用一份 agent dependencies | 每个门禁解析自己的 runtime |
| `apps/cli/src/discuss.ts` | 固定 Claude Code，专用禁止工具的设置 | 根据 discussion 配置选择 agent，保留权限边界 |
| `packages/recipe/src/local.ts` | 从机器配置注入 agent、limits，拒绝写在 recipe 中 | 从 recipe 解析职责选择和预算，支持旧配置迁移 |
| `apps/cli/src/init.ts`、`doctor.ts` | init 把 agent 写进机器配置；多项检查固定 Claude Code | 引导写入项目 recipe，按所选 agent 和职责检查 |
| board 的配置、历史和费用视图 | 主要按单一 runtime、数值 turns 和美元金额展示 | 展示职责选择、实际调用和未知用量或费用 |

`RuntimeId` 已包含 `claude-code` 和 `codex`。这次增加的是实际可用的接入及按职责
选择，不增加插件注册表、manifest 或第六个 gate。现有 `run:` 命令扩展和 subscribers
保持 [0037](../decisions/0037-an-extension-is-a-command.md) 的边界。

## 2. 配置归属和结构

运行选择与预算的来源是 `~/.lingtai/<project>/recipe.yml`。顶层 `runtime`
是**当前项目内各职责的默认配置**。机器配置继续保存端口、存储和 assignee 等机器
设置；CLI 安装、登录凭据和实际模型可用性是机器能力。

下面是 recipe 的局部示例；`repo`、`source`、`env` 等现有必要配置照常存在。

```yaml
runtime:
  agent: codex
  limits:
    wall: 1h
    rounds: 2
    restarts: 0

development:
  runtime:
    agent: codex
    # model: <该 agent 接受的模型名称>

discussion:
  runtime:
    agent: claude-code
    limits:
      wall: 5m

gates:
  proposed:
    - name: build
      run: pnpm verify

    - name: code-review
      agent: |
        检查正确性、失败路径和并发问题。
      runtime:
        agent: claude-code
        limits:
          turns: 150
          wall: 15m

    # 需要两次审查时，再声明一个独立门禁。
    - name: second-review
      agent: |
        检查边界条件和测试遗漏。
      runtime:
        agent: codex
        limits:
          wall: 15m
```

现有 review 门禁的 `agent:` 字符串仍是补充提示词；`runtime.agent` 是执行它的
CLI。`development` 是开发阶段配置，不是 gate action。五个 gate 点仍为
`admit`、`prepared`、`proposed`、`merge`、`end`。

### 字段范围

| 配置 | 字段 |
|---|---|
| 顶层 `runtime` | agent、可选 model；现有 tier、prompt、budget；limits |
| `development.runtime` | 可选 agent、model、单次运行 limits |
| `discussion.runtime` | 可选 agent、model、单次回答 limits |
| agent 门禁的 `runtime` | 可选 agent、model、单次审查 limits |

职责级 limits 只接受 `wall` 和可选 `turns`。`rounds`、`restarts` 只接受在
顶层 `runtime.limits` 中声明，含义沿用 0039/0040。`tier` 保留现有项目级隔离
要求，开发与 review 必须检查实际满足情况；discussion 还必须满足禁止命令和
文件修改的职责边界。职责级选择不能放宽项目要求。

新字段使用严格校验。未知 agent、空模型名称、非法时长、拼错的职责字段，或者
把 runtime 覆盖写在非 agent 门禁上，均报告完整配置路径，不静默删除。
凭据值和可任意透传的 CLI 参数不属于这些新增配置字段。

### 继承规则

解析必须是纯函数，并为每个最终字段提供来源。

| 职责覆盖 | agent | model |
|---|---|---|
| 没有自己的 runtime | 项目默认 | 项目默认，未声明则使用 agent 默认 |
| runtime 只声明 model | 项目默认 | 职责指定的 model |
| runtime 只声明 limits | 项目默认 | 项目默认 |
| runtime 显式声明 agent，未声明 model | 职责指定的 agent | 使用该 agent 默认模型 |
| runtime 声明 agent 和 model | 职责指定的 agent | 职责指定的 model |

显式声明 agent 就建立自己的模型选择，**即使 agent 与顶层相同，也不继承顶层
model**。开发后的修复沿用解析后的 development runtime；review 不改变修复 agent。

Limits 按字段继承，覆盖 agent 不会删除显式预算。若顶层显式声明 `turns`，它
也会到达使用 Codex 的职责，并在 Codex 首版触发能力校验错误。混合配置应把
共同的 `wall` 放顶层，把 `turns` 放在需要它的 Claude Code 职责中。

缺少显式 `turns` 时，Claude Code 沿用其既有适用默认值；Codex 不注入 Claude Code
的默认轮数。时间上限必须为正且始终存在。保留既有时间默认值；示例中的 15m、5m
是项目覆盖值，不设为新的全局默认。Discussion 的时间是单次回答的等待上限，
不是整个对话的累计费用上限；保留 0033 的人工控制与用量展示。

## 3. 职责权限、工作目录与会话

| 职责 | 工作目录与材料 | 能力 | 会话 |
|---|---|---|---|
| development | 任务的开发 worktree、ticket 和历史失败材料 | 读写代码、命令、测试、创建提交 | 本次开发调用独立会话 |
| fix | 同一个开发 worktree、明确的 findings/检查输出/冲突材料 | 与 development 相同 | 每轮独立会话 |
| review | 待审 SHA 的独立临时 worktree、ticket、固定 diff | 读代码、执行验证、输出 findings | 每个门禁及每次复审独立会话 |
| discussion | Lingtai 提供的事件、任务和 mirror 文件内容；空工作目录 | 分析和回答，禁止命令与文件修改 | runtime 绑定对话；回答通过 Lingtai 历史重建 |

Push、合并、标签更新和关闭任务仍由 conductor 执行。适配器不获得 GitHub App key、
事件库连接或负责这些效果的 token。Agent 创建开发提交并不意味着拥有发布权限。

### Review checkout

1. 在门禁开始时固定完整 `onSha` 和 diff 的 base/head。对同一个 SHA 审查，
   不跟随之后发生的 HEAD 变化。
2. 通过 repo port 创建 detached、独立的临时 worktree；不共享开发 checkout
   或可被 review 改写的开发环境文件。环境值依然经过 agent-env 的项目规则解析。
3. Reviewer 可运行验证命令。测试缓存和生成产物属于这个临时目录。
4. 调用结束检查 HEAD 和待审源码；改变提交或待审源码意味着本次审查无效，
   不能用它的通过结果放行原始 `onSha`。
5. 不把 review 目录中的修改复制回开发目录，不 push review 提交。
6. 成功、错误、超时、取消都清理 checkout；daemon 启动恢复处理遗留目录和进程。

复审在修复后的新 SHA 上重复上述步骤。Review 不得到开发 agent 的计划、会话和
transcript；复审只额外得到需要验证的 failure scenarios，不继承上次 reviewer 会话。
当前按门禁顺序执行、首个拒绝停止的行为保留；声明两个 reviewer 不意味着并发审查。

### Discussion boundary

权限必须由适配器的角色设置落实，不靠提示词。空目录和 read-only sandbox 不能
单独证明“禁止命令”：只读命令同样是命令执行。

实际启用的 shell、统一 exec、代码执行、文件修改、MCP/apps、浏览器或子 agent
等能力都必须服从 discussion 边界。不能让用户配置、项目配置或插件重新开放这些
能力。保留系统按请求从 mirror 提供文件内容的路径，不给 assistant 任意命令接口。
适配器拒绝职责外的审批请求；单纯拒绝审批也不能替代关闭无需审批的执行能力。

实现时验证完整工具配置和实际调用行为，无法满足就拒绝以该 agent 提供 discussion。
不修改用户既有 `~/.claude`、`~/.codex` 的账号配置，不把凭据复制进 recipe 或日志。

### Recipe 和会话的生效时机

一次 pass 开始时读取当前文件并解析全部职责，固定到 pass 结束，包括其内部 fix
和 re-review。下一次 pass，包括 rounds 用尽后的后续 restart，重新读取文件。
不在两个门禁之间偷偷换 agent 或模型。

新 discussion 开始时绑定解析后的 runtime。对话期间保持这份选择；改变 recipe
影响新 discussion。Lingtai 的聊天事件是历史和恢复的依据，不依赖某个 agent 的
原生 resume 才能读到历史。恢复已有对话使用其绑定的调用配置；新任务的配置始终
来自当前文件，不从旧 `GatesResolved.recipe` 解析。

## 4. 接入方式与包边界

Codex 采用 Lingtai 启动的独立 `codex app-server` 子进程，使用 stdio 协议。
每次 agent 调用拥有自己的进程和会话资源，结束即释放；不连接用户正在使用的共享
桌面会话或公共常驻 server。Claude Code 保留现有 CLI 接入。

App Server 能提供结构化通知、取消请求、用量和错误，适合按职责控制调用。
[`codex exec --json`](https://learn.chatgpt.com/docs/non-interactive-mode)
是一次性自动化的可选路径；本方案选择
[App Server](https://learn.chatgpt.com/docs/app-server) 以统一控制生命周期。
这是设计选择，协议字段以实现锁定的 CLI 版本生成 schema 为准。

| 包/宿主 | 责任 |
|---|---|
| recipe | 定义 schema、解析覆盖、校验字段和输出来源；不启动 agent |
| conductor | 决定职责、材料、SHA、预算与结果如何进入流程；依赖 port |
| actions | 继续使用固定 review rubric 和 findings 契约；按门禁获得对应 dependencies |
| agent | 实现两种 runtime、角色设置、实际能力、进程生命周期和输出归一化 |
| repo | review worktree 的创建、检查和清理，保留原开发 worktree 生命周期 |
| agent-env | 项目环境与凭据过滤；账号可达性在最终调用环境中验证 |
| CLI host / daemon host | 创建并提供 agent 选择 port，统一解析入口 |
| board | 编辑项目 recipe、展示绑定配置和调用结果，向 daemon 请求 discussion |

新增 runtime 选择 port，按解析后的 agent 和 role 取得适配器；实现只在现有 live
wiring 和宿主装配。Conductor 不根据字符串导入具体 CLI。不要把 daemon 变成模型
选择器或把 board 变成新的启动 agent 的宿主。

现有 Runtime 请求需表达 role、解析后的模型/limits、权限要求和调用标识。
`settingsPath` 不继续被理解成所有 agent 都接受的 Claude Code JSON：生成
agent-specific 设置由 agent 包负责，路径与生命周期仍由宿主/port 提供。
保留 Effect 在 I/O port 边界、actions 使用普通接口的现有分工。

### Codex 适配器开发要求

- 完成初始化握手、新会话、开始执行、通知归并、最终状态和结果读取。
- 所有审批请求都有确定处理；职责外请求拒绝，不因无人回答而挂起。
- 错误以结构化状态与执行证据分类，保留原始 detail；不用英文句子猜测错误种类。
- 禁止复用开发会话做 review，继续使用 Lingtai 审查提示词与 JSON findings 格式，
  不用原生 review 模式改变现有 severity 或门禁语义。
- 记录 session/thread ID；它是运行后观察到的事实，不假设可从 run ID 推导。
- 接口读取和 stderr 都有界；支持分块、UTF-8、重复通知和流在最终事件前中断。
- 超时/取消先请求停止，给有界清理时间，再终止所属进程组并清理验证命令。
  未知终态、协议中断或提前退出不得当成成功。
- Hooks 与通知写入同一 trace 时按调用标识去重，不让一条工具调用出现两次。
  Trace 和角色设置在开发 worktree 外；持久事实仍写入事件流。

当前 stub 对 hooks 和能力的声明是历史设计假设，不能直接当成已经实现的能力。
当前 Codex 文档的 hook 集合已有变化，见
[官方 hooks 文档](https://learn.chatgpt.com/docs/hooks)。Fail-closed、文件沙箱和
各职责权限均以实际适配器验证结果声明；不要求 discussion 安装开发 hook。

## 5. 上限、失败和恢复

| 情况 | 行为 |
|---|---|
| CLI 缺失、未登录、职责或隔离能力不足 | 启动前拒绝，报告项目、角色和配置路径 |
| 显式或继承的限制无法兑现 | 配置错误；不 claim、不创建开发 worktree、不花 agent 费用 |
| 额度或其他运行环境故障 | 报告未能运行/完成审查，停下或进入既有有界等待恢复路径；不换 agent |
| Review 返回真实 blocker/major | 按既有规则进入 development agent 的 fix round |
| Review 回答不可解析 | 门禁没有有效审查结果；保留输出，不当成通过或伪造 findings |
| Reviewer 改变待审源码或 HEAD | 本次审查无效；保留原因，不把修改带回开发 |
| 超时或取消 | 区分 timeout/aborted，停止子进程，保留开发成果与失败记录 |
| 流中断、崩溃、缺少最终结果 | 明确失败，保留已观察的材料和用量，不填造结果 |

预检任务将会用到的开发与 review agent；未被当前任务使用的 discussion 不因
账号不可用而阻止开发。Discussion 在请求时按自己的角色和环境预检。预检通过
后额度仍可能变化，调用中的环境故障使用同样的分类。

环境故障、无效审查和解析错误不构造可供 agent 修复的代码 findings，不消耗
`rounds`、`restarts`。实际红检查和 git 冲突继续沿用 0039 的材料交接与修复规则。
不得为“不消耗修复次数”的失败建立立即重复调用的无限循环。

Codex 首版只宣称落实 `wall`，不宣称落实 `turns`。Codex protocol turn 与
Claude Code 的执行轮数不是同一单位；分别记录，无法获得可比较计数就为 null。
不把一次 Codex turn 标成“一次模型调用”，也不使用 tool call 数冒充模型轮数。

`never-started` 需要执行证据：Codex 的费用为 null 并不证明没有调用模型。
不能直接沿用 `costUsd ?? 0` 判断 Codex 是否开始。已经执行后的额度错误与启动前
拒绝要区分；无法判定时保留明确的运行失败和错误 detail。

扩展总时长计算、drain 文案和 `passCeiling`：纳入 development/fix、每个审查
门禁及复审的实际上限，以及现有命令门禁/point ceilings 和进程清理时间。
不能继续把一个 `runtime.limits.wall` 或旧乘积展示成整次 pass 的总等待上限。
需要等待人工批准或环境恢复时，明确显示该等待的边界。

## 6. 事件、日志和费用

每次实际 agent 调用需要一个唯一 `invocationId`，归属于开发 run、fix round、
门禁或者 discussion answer。统一调用记录至少包含：

| 数据 | 要求 |
|---|---|
| 归属 | project、work item、run/chat、role、gate point/action、fix round（适用时） |
| 配置 | configHash、字段来源、agent、请求 model、实际观察 model；默认模型未知就明确未知 |
| 执行 | invocationId、session/thread ID、工作目录、待审 SHA、实际 limits 和 containment |
| 生命周期 | 开始、结束、取消/超时原因、最终状态、结构化错误和原始 detail |
| 用量 | adapter 实际报告的输入、缓存输入、输出等 token 字段；缺失为 null |
| 金额 | agent 报告的 costUsd；缺失为 null，不按公开单价估算 |

实现统一的 `AgentInvocationStarted` / `AgentInvocationFinished` 调用事件，
既有 RunStarted/RunFinished、FixApplied、Gate 和 Discussion 事件继续表达流程事实，
通过 invocationId 关联。账本按调用记录计算新调用费用；旧事件的金额只作为旧运行
的兼容来源，不对同一次调用重复计费。失败调用也要有结束事实。

事件 schema/upcaster 的更新保留旧数据含义。旧调用未记录 agent、model、用量或
会话时显示“未记录”，不能读当前 recipe 回填历史事实。0053/0054 接受并不代表
旧事件经过了新隔离机制。

Trace 继续遵守 0034 的大小上限、生命周期和敏感值处理。CLI attach 与 board 看
同一份 trace，明确标识是谁在开发、修复或审查。事实和金额不能只藏在 evidence
字符串或临时日志里。模型返回正文、验证输出和最终 findings 各自保留对应关系。

费用汇总同时展示已知小计与未知调用数。例如“已知 $3.20，另有 2 次费用未知”，
不能把缺失金额的 Codex 调用算成免费，也不能把含未知值的总额说成完整账单。
Discussion 提供可用的用量反馈；没有美元金额时如实显示未知。

## 7. 旧配置迁移

只迁移本功能相关的机器 `runtime.agent`、`runtime.limits` 及
`projects.<project>.runtime` 对应字段。端口、存储、assignee、其他设置和用户
CLI 账号配置不搬迁。

1. 读取所有已注册项目、机器配置和对应 recipe，先生成迁移预览，不启动任务。
2. 对每个项目按旧优先级计算有效值：项目级机器覆盖 > 机器公共值 > 旧有效默认。
   已有且可解析的 recipe 值保持；与迁入值不同则列出字段和双方来源，拒绝覆盖。
3. 将旧单 agent 选择物化为 recipe 顶层默认，使旧 review 沿用原选择。旧 discussion
   固定 Claude Code，因此迁移时显式物化 `discussion.runtime.agent: claude-code`，
   保持原有行为，而不是随顶层 Codex 切换。其既有单次回答上限也独立保留。
4. 无已记录选择时，只在能唯一确定旧选择时迁移。不能静默从两个已登录 agent
   中选一个；需要在项目设置里明确完成选择。
5. 校验所有生成配置。旧 Codex 选择中无法落实的显式 turns 不删除，报告冲突与
   能力问题；用户调整后再运行。不以迁移为理由放宽预算。
6. 保存 0600 备份、保留 recipe 注释和无关字段，原子写入并读回验证。机器公共
   值要物化到每个注册项目，不能只写第一个项目就删除公共设置。
7. 全部受影响项目成功后，清理已搬迁的机器字段；中断可重入，同样输入不产生
   重复内容。有未解决项目就不启动依赖迁移完成的新调度路径。

升级后的解析器检测遗留机器字段时明确提示迁移，不长期同时接受两个有效来源。
新项目的引导把用户明确选择写进 recipe。迁移的默认值用于保留旧行为，不成为
新项目的静默跨项目默认。

## 8. 实施顺序和完成条件

| 步骤 | 修改范围 | 完成条件 |
|---|---|---|
| 1. 配置和解析 | recipe schema、local resolver、emit、presets/propose、wizard 数据模型 | 覆盖矩阵、来源和严格校验成立；两个 agent 的默认轮数不混淆 |
| 2. 迁移 | 机器配置拆分/保存路径、项目注册和升级入口 | dry-run、冲突、备份、幂等和中断恢复成立；discussion 保持原行为 |
| 3. 运行接口与记录 | agent Runtime、选择 port、domain events/upcasters | 宿主能按 role 选择；统一调用生命周期和未知金额可表达 |
| 4. Codex 适配器 | app-server client、角色设置、能力检测和进程管理 | 可返回正文、错误、用量；超时/取消清理；权限约束经验证 |
| 5. Review checkout | repo port 和 adapter、actions dependencies、conductor | 固定 SHA 的独立目录；源码变化使审查无效；不会污染开发 |
| 6. 调度与 discussion | run、conduct、run-once、讨论宿主 | 开发/fix、每个 gate 和 discussion 都使用正确的绑定配置 |
| 7. 用户界面与检查 | 项目引导/编辑、doctor、task/history/spend、attach | 能编辑和解释每个职责；检查实际 runtime；未知费用和历史信息如实呈现 |
| 8. 真实验收 | 支持平台上的 CLI、沙箱和进程验证 | 下列验收矩阵通过，验证材料可复核；再更新操作文档和架构图 |

实施可以分步提交，但功能只有在配置、调用、权限、记录和界面共同成立后才算完成。
不能只去掉 Codex stub 就声称支持所有职责。更新架构图时保留中英文同步/生成流程；
本次不把尚未实现的目标画成当前架构。

### 验收矩阵

| 场景 | 可观察的通过条件 |
|---|---|
| Claude Code 开发与 review | 既有任务流程成立，调用记录分别标识开发和独立审查 |
| Codex 开发与 review | 实际产出提交和有效审查结果，时间上限与沙箱符合声明 |
| Codex 开发，Claude Code review | review 的 agent/model 正确；被拒绝后由 Codex 修复并重新审查 |
| Claude Code 开发，Codex review | 反向组合成立；没有继承不适用模型或注入默认 turns |
| 两个不同 agent 的 reviewer | 每个 gate 单独调用；都通过才继续，首个拒绝时保留原停止规则 |
| 两种 discussion | 使用所配 agent；诱导执行命令、修改文件、间接执行都无法越界 |
| 模型与预算继承 | model-only、显式相同 agent、跨 agent、limits-only 和缺省各有确定结果 |
| 不支持的限制、隔离等级 | 在 claim 前拒绝，报告职责与路径；没有静默降级 |
| 缺 CLI、未登录、额度或网络故障 | 没有假 findings，不消耗修复次数，不换 agent，不无限重试 |
| Review 隔离与固定 SHA | 测试产物、源码修改、提交和异步 HEAD 变化不改变开发 worktree；无效审查不能放行 |
| 超时、取消、崩溃和截断流 | 记录明确终态；子进程/验证命令停止；review 目录清理；开发成果保留 |
| Recipe 执行中变更 | 当前 pass/对话保持绑定；新 pass/对话读取新配置；历史信息不被当前值覆盖 |
| 混合费用和用量缺失 | 已知小计与未知数正确；review/fix/discussion 不漏账、同一调用不重复计费 |
| 迁移与历史事件 | 旧有效选择和 discussion 行为保持；冲突不覆盖；旧事件重放不造新事实 |

纯解析与状态处理用现有 memory event store 和协议 fixture 验证；涉及进程组、
worktree、CLI 权限和平台沙箱的性质必须真实验证，不能仅用 mock 宣称成立。
受支持平台至少覆盖项目发布的 macOS、Linux；各职责能力按验证结果放行。

## 9. 已核对的资料与实现验证边界

设计期间检查了仓库当前实现、当前官方文档和本机 `codex-cli 0.144.1` 的
`exec --help`、`app-server --help`、feature 列表及其生成的协议 schema，未发起
模型调用。CLI 版本是核对样本，不在这里宣称它已经通过本项目兼容性验收。

没有找到帮助或 schema 字段不等于证明某能力永远不存在。本方案据此选择不宣称
Codex 轮数硬上限；未来只有实际实现、验证并明确计数单位后才能增加能力声明。
同样，协议可以配置权限不等于已经证明完整的 discussion 边界。

相关官方资料：

- [App Server](https://learn.chatgpt.com/docs/app-server)：本方案的结构化进程接口。
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)：一次性 exec 路径。
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)：配置能力与工具控制。
- [Hooks](https://learn.chatgpt.com/docs/hooks)：生命周期接入与工具覆盖边界。

产品行为、配置归属、继承、职责权限、预算和迁移方向已经确认。实现阶段还需完成
的是上述明确验收项的证明；没有以文档代替 CLI 兼容性、权限验证或运行结果。
