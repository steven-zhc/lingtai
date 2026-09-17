# Agent runtime 实施计划

Root epic：[#198](https://github.com/steven-zhc/lingtai/issues/198)。所有实施 ticket 均为 `agent:hold`，review 后由项目负责人逐张放开。

依据：[开发文档](agent-runtimes.md)、[ADR 0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md)、[ADR 0054](../decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md)。

GitHub 的 native sub-issues 表达归属，native blocked-by 表达依赖。以下表格是便于阅读的镜像；排程以 GitHub 关系为准。

| Ticket | Independent outcome | Native blocked by | Wave |
|---|---|---|---|
| [#199](https://github.com/steven-zhc/lingtai/issues/199) | The recipe chooses an agent, model and limits for each role | — | 1 — contracts |
| [#200](https://github.com/steven-zhc/lingtai/issues/200) | Agent calls have a role, a runtime port and one durable invocation record | #199 | 1 — contracts |
| [#201](https://github.com/steven-zhc/lingtai/issues/201) | Old machine runtime choices migrate safely into every project recipe | #199 | 2 — migration and adapters |
| [#202](https://github.com/steven-zhc/lingtai/issues/202) | Codex runs through a dedicated app-server with enforced role boundaries | #200 | 2 — migration and adapters |
| [#203](https://github.com/steven-zhc/lingtai/issues/203) | Each review validates a fixed SHA in its own disposable worktree | #200 | 2 — migration and adapters |
| [#204](https://github.com/steven-zhc/lingtai/issues/204) | A pass dispatches development, fixes and each reviewer through its bound recipe | #201, #202, #203, #196 | 3 — workflow integration |
| [#205](https://github.com/steven-zhc/lingtai/issues/205) | Discussion binds its configured agent while keeping every answer tool-free | #201, #202 | 3 — workflow integration |
| [#206](https://github.com/steven-zhc/lingtai/issues/206) | Project setup and editing save role choices in the recipe | #204 | 4 — operator experience |
| [#207](https://github.com/steven-zhc/lingtai/issues/207) | Doctor checks the agents and limits each configured role will actually use | #204, #205 | 4 — operator experience |
| [#208](https://github.com/steven-zhc/lingtai/issues/208) | History, traces and the ledger show each agent call and unknown costs honestly | #204, #205 | 4 — operator experience |
| [#209](https://github.com/steven-zhc/lingtai/issues/209) | The agent-role matrix is proven on macOS and Linux and documented as shipped | #206, #207, #208 | 5 — release acceptance |

先完成配置和运行契约；迁移、Codex 适配器、review checkout 按各自前置依赖推进。之后接入开发/fix/review 调度与 discussion，再分别完善引导编辑、doctor 和历史费用展示，最后完成真实平台验收与操作/架构文档。不同分支之间不人为串行。

现有 #196 是调度任务的外部前置依赖，复用其无审查结论的失败语义；#195、#197 的修复需要保留，但不重复建票。#34、#160、#188 的更广范围不纳入此 epic。

每张 ticket 包含面向人的四行 Summary、面向 agent 的实现契约与代码证据，以及可验证的 Done when。验收必须包括 macOS/Linux 的真实进程、权限与 worktree 行为；单靠配置或 mock 不算完成。
