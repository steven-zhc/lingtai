# 给 agent 一个出不去的沙箱：OpenSandbox 还是别的

**研究快照：2026-11-10**

## 结论先行

**现在没必要用 OpenSandbox。** 它是给大批量、多租户场景准备的沙箱平台，对 Lingtai"一个人、一台机器、本地跑 agent"的用法太重了。

要补 #339 说的"agent 出不去的沙箱"，推荐 Anthropic 开源的 **sandbox-runtime（srt）**：

- 不需要常驻服务，也不需要 Docker；
- TypeScript 写的，和 Lingtai 同一技术栈；
- agent 照样是本机子进程，现有的 hook、日志、超限终止都不用改。

按场景分：

| 场景 | 选择 | 状态 |
|---|---|---|
| 本机隔离 agent（#339） | sandbox-runtime（srt） | **推荐，先试** |
| 部署到服务器 | Lingtai 自己的 Docker 镜像，容器就是边界 | 随 Docker 镜像一起做 |
| 本机要虚拟机级隔离 | Docker Sandboxes（`sbx run claude`） | 观望 |
| 多机、高并发执行 | OpenSandbox | 观望，等 Lingtai 有这种模式再评估 |
| 云端沙箱（E2B、Daytona、Modal） | 不考虑 | 和本地优先的定位冲突 |

---

## 问题：Lingtai 今天的隔离到哪一步

[safety.md](../safety.md) 写得很直白：

- 默认情况下，Claude Code 能读你能读的任何文件，包括 `~/.lingtai/config.yml` 和 `~/.ssh`；能写你能写的任何目录。Lingtai 不提供文件系统沙箱。
- Lingtai 在每一档都做的只有三件事：agent 在自己的 worktree 里工作；环境变量过滤到 `PATH`、`HOME` 等几项加上项目声明的变量；recipe 放在 worktree 外面，agent 改不到自己的检查。
- `guarded` 这一档不是文件或网络的保护，只是"`UserPromptSubmit` hook 拒绝时能让运行停下"。`sandboxed` 这一档要求运行时自己强制一个文件系统边界：Codex 有（`--sandbox workspace-write`），Claude Code 没有。
- 原话："This is the state before a sandbox the agent cannot leave (#339)."

三档定义在 `packages/domain/src/events.ts:87`（`Tier = z.enum(['open', 'guarded', 'sandboxed'])`）。

所以要补的是：**一个 agent 自己出不去的文件系统和网络边界，Claude Code 和 Codex 都要有，macOS 和 Linux 都要能用。**

### 换沙箱时不能弄坏的东西

Lingtai 跑 agent 的方式决定了沙箱要满足哪些约束：

- **agent 是本机子进程。** Lingtai 直接起 `claude`、`codex`，跑在 worktree 里，按轮数和时长直接终止进程（`RuntimeCapabilities.enforces`，`packages/agent/src/runtime.ts:37`）。
- **hook 通过本机 Unix socket 回报**（`packages/agent/src/hook-socket.ts`）。沙箱必须让这个 socket 通。
- **agent 用的是你本机已登录的账号。** 沙箱要放行 `~/.claude` 或 Codex 的登录状态，以及模型服务的域名。
- **每次运行都会生成一个 settings 文件**（`RunRequest.settingsPath`），这是打开 Claude Code 自带沙箱的现成入口。
- **分发方式是一个不依赖 Node 的单文件二进制**（[0113](../decisions/0113-distribution-is-a-versioned-binary.md)）。多一个常驻服务或运行时依赖，就破坏这一点。

---

## 候选一：OpenSandbox

### 它是什么

- 阿里巴巴开源，Apache 2.0，GitHub 约 17k star。
- 架构分几块：
  - 一个用 Python 写的控制服务（`uvx opensandbox-server`）；
  - 每个沙箱是一个容器，里面注入一个 Go 写的 `execd`，通过 API 执行命令、读写文件；
  - 每个沙箱配一个出网控制的旁路容器，可以按域名设白名单（DNS 过滤，加上 nftables）。
- 还有一个 Credential Vault：在出网时注入凭证，真实密钥不进沙箱。
- 隔离默认是 Docker 容器。gVisor、Kata、Firecracker 可选，但要管理员自己装，基本只在 Linux 上可行。
- 本地有 Docker 就能起，也能部署到 Kubernetes。有 Claude Code、Codex 的示例。
- 成熟度上它自己也有提醒：README 说当前发布在签名和来源证明上有缺口，要求按 digest 固定镜像；有第三方评测提到它还没有稳定的 v1 API。

### 为什么不适合 Lingtai 现在用

1. **多出两个运行依赖：Python 服务和 Docker**，和单文件二进制的分发方式冲突。
2. **两个运行时适配器要大改。** agent 不再是本机子进程，而要经 `execd` 的 API 执行。hook socket 要挂进容器，agent 的登录状态也要带进去，日志读取和超限终止都得重写。
3. **macOS 上收益有限。** 容器跑在 Docker Desktop 的虚拟机里，更强的 gVisor、Firecracker 基本只在 Linux 上可用。
4. **它的强项用不上。** 批量创建、资源池、K8s、给强化学习和评测用的大量并发沙箱，这些都是为多租户、大规模准备的。Lingtai 默认一次只跑一个任务，[路线图](../roadmap.md)也说并发会放在最后做。

### 什么时候值得再看

Lingtai 将来如果有"放在服务器上、多机并发跑很多任务"的模式，它可以作为一个执行后端。它的按域名出网白名单和 Credential Vault，届时都是现成能用的东西。

---

## 候选二：sandbox-runtime（srt），推荐

### 它是什么

- npm 包 `@anthropic-ai/sandbox-runtime`，Apache 2.0，也是 Claude Code 自带沙箱用的同一层。
- macOS 上用系统自带的 Seatbelt（`sandbox-exec`），Linux 上用 bubblewrap 加独立的网络命名空间。
- 网络通过沙箱外的代理（HTTP 和 SOCKS5）按域名放行。

### 为什么合适

- 不需要常驻服务，也不需要 Docker。
- TypeScript 写的，和 Lingtai 同一技术栈。
- 它包住的是一个普通进程。agent 照样是本机子进程，现有的 hook、日志、超限终止都不用改。

### 两种接法

1. **包住整个 `claude` 进程。** Claude Code 自己的读文件工具也会被限制住，最彻底。
2. **在 Lingtai 每次运行已经生成的 settings 文件里，打开 Claude Code 自带的沙箱。** 改动最小。`doc/safety.md` 已经记录过这条路的坑：
   - 必须设 `allowUnsandboxedCommands: false`，否则在 Lingtai 下沙箱可以被绕过；
   - Linux 上没装 bubblewrap 就等于没有沙箱；
   - agent 运行时会丢掉 `CLAUDE_CONFIG_DIR`，Claude Code 读的是 `~/.claude`，放在自定义配置目录里的设置不生效。

Codex 这边已经有自带的 `workspace-write` 沙箱。加上 srt 之后，两个运行时在 macOS 和 Linux 上都能达到 `sandboxed` 这一档。

### 要注意

- srt 自己标着"研究预览"，API 可能变。
- 被包住的进程得放行 `api.anthropic.com` 和 `~/.claude`，也得放行 Lingtai 的 hook socket。Unix socket 能否放行要实测。
- Linux 上需要 bubblewrap，还要 socat 和 ripgrep。缺了要明确拒绝运行，不能悄悄退回到没有沙箱的状态：[0007](../decisions-archive/0007-dual-runtime.md) 关于档位的规则是"满足不了就拒绝，从不悄悄降级"。

---

## 候选三：Lingtai 自己的 Docker 镜像（服务器场景）

[vibe-kanban-demand-vs-lingtai.md](vibe-kanban-demand-vs-lingtai.md) 的 Docker 专题已经讨论过：把整个 Lingtai 连同 agent 放进一个容器部署到服务器。

- 容器本身就是边界：agent 看不到宿主机，只看得到挂进去的目录。这一层不需要 OpenSandbox。
- 想在容器里再对每次运行做隔离会比较麻烦：bubblewrap 在没有特权的容器里经常起不来。所以服务器场景先只靠容器这一层就够了。

---

## 候选四：Docker Sandboxes（观望）

- 每个 agent 一个 microVM，有自己的内核和 Docker 引擎，命令是 `docker sandbox run claude` 或新的 `sbx run claude`。
- microVM 版只支持 macOS 和 Windows，Linux 上是旧的容器版。
- 它是 Docker Desktop 的功能，面向人直接交互运行 agent，默认让 agent 全自主运行。Lingtai 的 hook、花费记账、超限终止能不能接进去还不清楚，暂时不建议接。

## 候选五：云端沙箱（不考虑）

E2B、Daytona、Modal 之类把 agent 放到别人的云上跑。这和 Lingtai"在你自己机器上跑、记录留在本地"的定位冲突。

---

## 建议的顺序

1. **先在一个任务里试用 srt**，把它做成 Claude Code 的 `sandboxed` 这一档。实测三件事：
   - `~/.ssh` 和 `~/.lingtai/config.yml` 读不到；
   - 只有白名单里的域名能访问；
   - hook socket 能通，`guarded` 的失败即停照常生效。
2. **Docker 镜像照原计划做**，容器就是服务器场景的隔离层。
3. **OpenSandbox 和 Docker Sandboxes 记入观察名单**，等 Lingtai 有多机或多并发的执行模式时再评估。

## 方法与局限

- open-sandbox.ai 不在写这篇文章的会话允许访问的网络范围内，没能打开。OpenSandbox 的信息来自它的 GitHub README、架构文档和第三方文章。
- srt 和 Docker Sandboxes 的信息来自官方仓库、官方文档和第三方文章，没有在 Lingtai 上实测。上面所有"要实测"的点都还没测。

## 来源

- [alibaba/OpenSandbox（GitHub README）](https://github.com/alibaba/OpenSandbox)
- [OpenSandbox 架构文档](https://github.com/alibaba/OpenSandbox/blob/main/docs/architecture/index.md)
- [OpenSandbox: Secure Agent Runtime and Sandbox Guide（agentpedia）](https://agentpedia.codes/blog/opensandbox-secure-agent-runtime-guide)
- [wavect：OpenSandbox 评测](https://wavect.io/zh/blog/opensandbox-ai-agent-sandbox-review.md)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Anthropic Sandbox Runtime 说明（agentic-ai docs）](https://agentic-ai.readthedocs.io/en/latest/SecurityFrameworks/anthropic-sandbox-runtime/)
- [Docker Sandboxes 官方文档](https://docs.docker.com/ai/sandboxes)
- [Docker 博客：Docker Sandboxes 运行 Claude Code 等 agent](https://www.docker.com/blog/docker-sandboxes-run-claude-code-and-other-coding-agents/)

## 相关

- [safety.md](../safety.md)：今天每个运行时能读什么、能写什么，以及 #339 之前的状态。
- [vibe-kanban-demand-vs-lingtai.md](vibe-kanban-demand-vs-lingtai.md)：Docker 专题里提到"放进容器能顺带隔离 agent"，本文把这条展开。
