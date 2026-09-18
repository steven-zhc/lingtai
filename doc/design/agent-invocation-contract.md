# Agent invocation 开发契约（#200）

本页说明 #200 已实现的接口和持久记录。产品选择、继承及权限要求以
[Agent runtimes 设计](agent-runtimes.md)、0053、0054 为准。
这是 #202–#205 的接入基础；当前开发、门禁和 discussion 生产流程仍使用旧接口，
未启用 Codex，也未改变 #196 的 review 故障处理政策。

## 接口与职责

`packages/agent/src/invocation.ts` 定义普通 Promise 接口 `InvocationRuntime`：

1. `supports(selection)` 检查 agent、role、有效 limits 和 required tier。
2. `prepare(request)` 生成 agent 专用设置，返回 `PreparedInvocation`。
3. `execute()` 执行一次调用，返回正文及可持久化的观察值。
4. `close()` 释放角色设置；宿主通过 scope 保证它在结束后执行。

Actions 可直接依赖这些普通接口，不需要 Effect。设置路径由宿主提供，内容由
adapter 生成；路径不意味着其他 agent 接受 Claude JSON。Prepare 必须有界；
adapter 在返回结果或执行错误前停止其拥有的进程，不能留下仍运行的验证命令。

Request 每次使用新的 `invocationId`，携带完整 resolved configuration（可空的
请求 model、effective limits、来源、configHash、required tier）、ownership、
cwd、待审完整 SHA、宿主已过滤的 env、trace 和 cancellation signal。

| Role | 材料 | 归属 |
|---|---|---|
| development | 开发 prompt | project / work item / run |
| fix | 修复 prompt、结构化 findings（保留 failureScenario） | run / gate point / action / fix round |
| review | 包含固定 rubric 的 brief、固定 diff | run / gate point / action / onSha，可记录复审 round |
| discussion | question、Lingtai 提供的历史与文件 context | work item / chat，可关联已有 run |

Review 的 brief 由 actions 按原 rubric 和 findings 契约组装，adapter 附加固定 SHA
与 diff。禁止原生 resume/review 模式复用开发会话。修复检查输出和 git 冲突可放在
fix prompt，findings 保持结构化；不把运行环境故障转换成代码 findings。

选择 port `RuntimeSelectorPort` 和 `AgentRuntimes` tag 位于 conductor 的 `ports.ts`。
Conductor 只向 port 请求实现，`live.ts` 注册 adapter；宿主提供对应 layer。
`liveRuntimeSelector` 当前只注册 Claude Code。缺 adapter、职责或能力不支持都会
返回带 agent、role 和原始 detail 的 `RuntimeSelectionRefused`，没有 fallback。
Codex 的历史 stub 不在新 registry 中，其旧 capabilities 不能作为已实现能力。

## Claude Code 适配与兼容

`createClaudeCodeRuntime()` 同时提供新接口和旧 `Runtime.run()`。
旧调用仍按原 settingsPath、权限模式、max-turns、模型和 auth 环境执行，便于
#204/#205 分步切换。`claudeCodeNeverStarted` 只分类 Claude receipt；保留旧导出
`neverStarted` 作为弃用兼容别名。不能把这条 null cost 规则用于 Codex。

新接口用 invocation ID 生成新请求 session ID，而事件中的 session ID 仅来自
native stream/receipt。没有观察到 model、session、tokens 或 turns 就记录 null。
Native turns 使用 `claude-agentic-turn` 单位；Codex 的 `codex-protocol-turn`
是另一种计数，不能互相替代。已观察金额原样保留，没有金额不按价格估算。

角色设置文件以 `wx` / 0600 写入，拒绝覆盖其他调用的文件，也拒绝 worktree
内部路径（检查 realpath）。新开发/fix/review 的 guarded 调用要求宿主提供已验证的
fail-closed hook wiring；不带 hook 的调用只声明 open。Sandboxed 请求明确拒绝。
新接口的 hook packet 使用 invocationId（沿用 native 环境字段名 LINGTAI_HOOK_RUN_ID）；
宿主必须将该 ID 注册并映射到 ownership，不能把 reviewer 的 hook 接到开发会话的绑定。
Review 的源码和 HEAD 是否改变由 #203 的 checkout 检查负责，adapter 不声称
Claude Code 自带文件沙箱或禁止了验证产物写入。

Discussion 使用空的宿主目录、default permission mode、safe mode、关闭 built-in
tools、strict MCP、关闭 skills 和专用 deny settings。忽略调用者的 extraArgs，
避免重新开放工具。Safe mode 保留 CLI 的账号和模型选择能力，不使用会改变登录
方式的 bare mode。实际机制逐项记录，filesystemSandbox 始终为 false；其 guarded
机制是 no-tools reader boundary，不安装开发 hook。工具与插件不能执行的真实 CLI
行为及受支持版本仍需 #209 在 macOS/Linux 验收，stand-in 测试只证明本接口施加了
这些设置。

超时/取消发送进程组 SIGTERM，等待 close，必要时在 5 秒后 SIGKILL；CLI 先退出
时，无论成功还是失败，都清理剩余验证子进程，包括仍持有 stdout/stderr 的子进程。
返回结果前最多等待 5 秒确认进程组消失；持续清理失败会记录 failure，保留原始
native 错误和清理 detail，不将清理失败报告为成功。
结束前观察到的 receipt、model、session 和 usage 保留；
没有 receipt 的取消不填 0 turns 或 0 cost。预先取消不会 spawn。

## 持久事件和生命周期

每次调用有自己的 `inv-{invocationId}` stream。它与 run/chat stream 分开，避免
独立职责的调用碰撞流程 stream 的版本。

- `AgentInvocationStarted` v1：ownership、configuration、实际 containment、cwd、
  完整 onSha 和 startedAt。Review 缺完整 SHA、错误归属、discussion 可执行命令或
  修改文件、实际 tier 低于 required tier 都不能写入。
- `AgentInvocationFinished` v1：唯一 ID、finishedAt、succeeded/failed/interrupted、
  exitCode、duration、结构化 failure 与原始 detail、观察 model/session/thread、
  nullable usage/cost、native 最终正文、processStarted / receiptReceived 的可空执行证据。

`invokeAgent` 的顺序为 select → prepare → append start → execute → append finish →
close。Start 表示一次调用已准备好进入执行，并非已调用模型的证明；native 执行
证据在 finish 中单独记录。Start 写入失败时不 execute；执行异常也写失败结束；
finish 无法写入时保留 start 供恢复，不能伪造成功。复用 ID 在 expected version 0
处冲突，不再次执行。Effect interruption 先取消 native 调用、等待其结果，再在
不可中断区写入终态。Prepare/start/projector 回调期间收到 interruption 时，先
abort 再向 adapter 获取预先取消的结果；Claude 此时不 spawn，记录明确的未执行
证据。宿主通过 `appended` 接上其持有的 projector。

`interruptAgentInvocation` 仅供宿主确认旧 owner 和其进程已停止后使用，不能扫描
并关闭活跃调用。它把未结束记录终结为 interrupted，保留调用原来的配置；未知
usage/cost/model/session/执行状态仍为 null。已终结记录不再追加，竞争写入由
expected version 拒绝；不自动重试调用。宿主若仍持有真实 observation 可传入，
不能把当前 recipe 或一个推导的 session ID 当作 observation。

## 旧事件和唯一费用来源

以下流程事件新增可空、可省略的 invocationId；缺省保留旧 producer 兼容性：

| Event | 新版本 | 旧版本的新增含义 |
|---|---:|---|
| RunStarted | 3 | invocationId = null |
| RunPrompted | 3 | invocationId = null |
| RunFinished / RunFailed | 2 | invocationId = null |
| FixRequested | 3 | invocationId = null |
| FixApplied | 2 | invocationId = null |
| GateRequested / GateStarted / GateFailed | 3 | invocationId = null |
| GatePassed | 4 | invocationId = null |
| GateNeverRan | 2 | invocationId = null |
| DiscussionAsked / DiscussionAnswered | 2 | invocationId = null |

各旧版本都有连续 upcaster，原有 rename、findings、argv 等兼容步骤继续存在。
不重写历史，不从当前 recipe 补历史 agent/model/isolation/session/金额。

`accountedAgentCalls` 是 #208 账本接入的兼容边界，输入完整的流程及相关 invocation
事件。存在 invocation record 时，该 ID 只计一次；start 无 finish、或 finish 金额
未知都计为未知调用，不能改用关联流程 receipt 的金额填空。
没有关联 invocation record 的 RunFinished、FixApplied、DiscussionAnswered 才保留
为 legacy 费用来源。DiscussionHeld 是整个对话的摘要，不能再计费；旧 gate evidence
中的美元文本不解析成结构化金额。历史没有录下的事实继续缺失。

消费者应输出已知金额小计和未知调用数，不能把未知调用当免费，不能将不完整
金额说成完整账单。这个 helper 未接入当前生产视图，实际接线属于 #208。

## 验证与后续接入

Domain 测试检查 schema、归属、native count unit、reducer 终态和 legacy upcast。
Conductor 使用 memory event store 与 fake port 验证四种职责、独立 ID、重复拒绝、
执行异常、Effect 取消、finish 写入失败、interrupted 恢复和费用去重。
Claude adapter 使用真实 stand-in 子进程验证 argv/settings、过滤 auth 环境、观察
receipt、未知字段、权限配置及进程组取消/正常退出清理。这些测试不调用模型、
不依赖 Postgres。

#202 注册 Codex adapter；#203 提供固定 SHA review checkout；#204 将开发、fix、
每个 gate 与其流程事件接入；#205 固定 discussion runtime 并按回答调用；#208 接入
账本与历史 UI；#209 验证真实 CLI、完整工具边界、平台沙箱和操作文档。
