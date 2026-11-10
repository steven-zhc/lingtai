# 给 agent 一个出不去的沙箱：OpenSandbox 还是别的

**研究快照：2026-11-10** · **计划版本：0.14.0**（安全）。0.15.0 是本地可靠交付，0.16.0 是承接 Vibe Kanban 用户。

## 结论先行

**现在没必要用 OpenSandbox。** 它是给大批量、多租户场景准备的沙箱平台，对 Lingtai"一个人、一台机器、本地跑 agent"的用法太重了。

要补 #339 说的"agent 出不去的沙箱"，推荐 Anthropic 开源的 **sandbox-runtime（srt）**：

- 不需要常驻服务，也不需要 Docker；
- TypeScript 写的，和 Lingtai 同一技术栈；
- agent 照样是本机子进程，现有的 hook、日志、超限终止都不用改；
- 构建检查执行的命令也能用同一个 srt 包住。

现状一句话：**Codex 的写到了 L2，Claude Code 停在 L1，构建命令只有 L0，网络和凭证（L3、L4）对谁都还没做**（分层见第二节，对照见第三节）。

按场景分：

| 场景 | 选择 | 状态 |
|---|---|---|
| 本机隔离 agent（#339） | sandbox-runtime（srt） | **推荐，先试** |
| 部署到服务器 | Lingtai 自己的 Docker 镜像，容器就是边界 | 随 Docker 镜像一起做 |
| 本机要虚拟机级隔离 | Docker Sandboxes（`sbx run claude`） | 观望 |
| 多机、高并发执行 | OpenSandbox | 观望，等 Lingtai 有这种模式再评估 |
| 云端沙箱（E2B、Daytona、Modal） | 不考虑 | 和本地优先的定位冲突 |

---

## 一、问题是什么

**安全沙箱要回答的是：agent 在你机器上跑的时候，能读什么、能写什么、能连到哪里。**

Lingtai 的几个特点让这个问题比"自己开个 Claude Code 写代码"更严重：

1. **agent 以你的身份、在你的机器上运行**（[safety.md](../safety.md) 第一句）。它能做的事，就是你的账号能做的事。
2. **Lingtai 关掉了 Claude Code 的逐次授权。** 启动时用的是 `--permission-mode bypassPermissions`（`packages/agent/src/claude-code.ts:255-268`）。原因是无人值守时没人能点"允许"：曾经有一次运行花了 45 轮、$3.35，一个文件都没能写成。代码注释说得很直白：放开之后，agent 写到 worktree 外面，Lingtai 的 hook 也不会拦。
3. **Lingtai 自己不拦任何工具调用。** [0016](../decisions-archive/0016-the-settled-model.md) §6 把原来的拦截规则整个删了，理由是工具限制应由运行时自己的配置负责。hook 现在只做记录，以及"连不上就让运行失败"（`packages/agent/src/hook-socket.ts:268-283`）。
4. **无人值守，没人看着每条命令。**
5. **agent 读到的东西来自外部。** issue 正文会直接成为 agent 的 prompt，能提 issue 的人就能往 prompt 里写东西。依赖包、网页也一样。这就是提示注入的入口。

把这些叠在一起，最坏情况是：

- **读走机密**：`~/.ssh`、`~/.aws`，以及 `~/.lingtai/config.yml`。后者里有 GitHub App 私钥和数据库地址。环境变量里虽然已经去掉了 `LINGTAI_*`，但这个文件本身 agent 读得到。
- **用你已登录的命令行工具**：`gh`、云平台 CLI。safety.md 里明写了"agent 可以以你的身份运行 `gh`"。
- **写到 worktree 外**：改别的仓库、改 `~/.zshrc` 留后门、改 Lingtai 自己的记录。
- **把东西发出去**：网络完全开放。

还有一点容易漏掉：**构建检查也在执行不受信的代码。** `build:` 跑的 `pnpm test`，跑的正是 agent 刚写的代码。它是一个普通子进程：在 worktree 里，用过滤过的环境变量，没有任何沙箱（`packages/actions/src/command.ts:445-462`）。所以沙箱只包住 agent 是不够的。

要区分两层防护：

- **检查和独立审查**防的是"坏代码合进 main"。
- **沙箱**防的是"agent 和它写的代码在运行时伤到这台机器"。

Lingtai 前一层做得很重，后一层几乎空着。

## 二、应该做成什么样

目标：**一个 agent 和它写的代码都出不去的边界。由 recipe 声明，满足不了就拒绝运行，每次运行都留下记录。**

按层次排，每一层叠加在前一层之上：

| 层 | 内容 |
|---|---|
| **L0 基本卫生** | 独立 worktree；过滤环境变量；recipe 不在 worktree 里，agent 改不到自己的检查 |
| **L1 记录不能被绕过** | hook 连不上 Lingtai 时运行必须失败，不能"什么都没记下却看起来做完了" |
| **L2 文件系统边界** | 写：只允许 worktree、临时目录、提交需要的 git 目录。读：默认拒绝一份机密清单（`~/.ssh`、`~/.lingtai`、`~/.aws`、`~/.config/gh`、钥匙串等） |
| **L3 网络白名单** | 只放行模型服务、包仓库，以及 recipe 声明的域名，其余一律拒绝 |
| **L4 凭证隔离** | agent 手里没有你或 Lingtai 的长期凭证；项目需要的密钥按需、限范围地注入（比如由代理在出网时注入），不落在 agent 能读的地方 |
| **L5 机器级隔离** | 容器或微型虚拟机，宿主机整体不可见。主要用于部署到服务器的场景 |

对应要提供的功能：

1. **一个边界同时包住 agent 和构建命令。** `build:` 下 `run:` 执行的代码和 agent 在同一个沙箱里。
2. **两个运行时（Claude Code、Codex）用同一个边界**，在 macOS 和 Linux 上都能用。
3. **recipe 里声明档位和白名单**：现有的 `runtime.tier`，加上 `network.allow` 这类新字段（字段名只是示意）。达不到就拒绝运行，不能悄悄降级。这条规则已经有了，见下文。
4. **违规可见**：被拦下的读、写、联网要写成事件，显示在看板上。让人知道 agent 试图做什么，比默默挡住更有价值。
5. **可审计**：每次运行在记录里写明当时用的是什么边界（档位、策略版本）。safety.md 那张表要按运行时版本实测，而不是凭推断。
6. **不加常驻服务**，保持单文件二进制的分发方式。下文推荐 srt，就是因为这一条。

## 三、现在做到哪一级

| | Claude Code（默认） | Codex | 构建检查的命令 |
|---|---|---|---|
| L0 基本卫生 | ✅ | ✅ | ✅ worktree 加过滤环境变量 |
| L1 记录不能被绕过 | ✅ `canFailClosed: true`，档位是 `guarded`（`claude-code.ts:69,76`） | ✅（`codex.ts:190`） | 不适用 |
| L2 写边界 | ❌ 哪里都能写 | ✅ `workspace-write`，档位是 `sandboxed`，已实测（`codex.ts:36,194`，#313） | ❌ |
| L2 读边界 | ❌ 能读 `~/.ssh` 和 `~/.lingtai/config.yml` | 🟡 要你自己在 profile 里配 `deny`；没配时未实测 | ❌ |
| L3 网络 | ❌ 完全开放 | 未实测 | ❌ |
| L4 凭证 | 🟡 Lingtai 不把自己的凭证放进环境变量，但凭证文件读得到，`gh` 登录态也能用 | 同左 | 同左 |
| L5 机器级 | ❌ | ❌ | ❌ |

三个档位定义在 `packages/domain/src/events.ts:87`（`Tier = z.enum(['open', 'guarded', 'sandboxed'])`），大致对应上表的 L1 和 L2。

另外两项已经有的：

- **档位强制已经实现。** recipe 要求的档位如果运行时提供不了，Lingtai 拒绝派发并暂停，提示"X 提供不了这个档位，缺少什么"（`packages/conductor/src/conduct.ts:1050-1098`），从不降级。这是 L2 以上做起来之后的基础，已经就位。
- **你现在能自己配的**：给 Claude Code 打开它自带的沙箱，用 `denyRead` 列出禁读路径，并且必须设 `allowUnsandboxedCommands: false`，否则在 Lingtai 下可以被绕过。这是用户自己的配置，Lingtai 不会帮你打开；而且只在 macOS 上测过一个临时目录，`~/.ssh` 本身和 Linux 都没测过。

**总结：Codex 的写到了 L2，Claude Code 停在 L1，构建命令只有 L0，网络和凭证（L3、L4）对谁都还没做。** safety.md 自己的说法是："This is the state before a sandbox the agent cannot leave (#339)."

所以要补的是：**一个 agent 和它写的代码都出不去的文件系统和网络边界，Claude Code、Codex 和构建命令都要有，macOS 和 Linux 都要能用。** 下文的候选方案按这个标准评估。

## 四、换沙箱时不能弄坏的东西

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

第二种接法只管得到 agent，**管不到构建检查的命令**。所以构建命令无论如何都要用 srt 包住：同一个 srt 既包 `claude` 进程，也包 `build:` 下的 `run:`，边界才是一个。

Codex 这边已经有自带的 `workspace-write` 沙箱。加上 srt 之后，两个运行时在 macOS 和 Linux 上都能达到 `sandboxed` 这一档，也就是上表的 L2；srt 的网络代理再把 L3 补上。L4（凭证隔离）srt 不管，要另做。

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

第 1 至 3 步是 0.14.0 的范围；第 4、5 步不在 0.14.0 到 0.16.0 之内。

1. **先在一个任务里试用 srt**，同时包住 Claude Code 进程和构建命令，把 Claude Code 做到 `sandboxed` 这一档。实测四件事：
   - `~/.ssh` 和 `~/.lingtai/config.yml` 读不到；
   - 写不出 worktree、临时目录和提交需要的 git 目录；
   - 只有白名单里的域名能访问；
   - hook socket 能通，`guarded` 的失败即停照常生效。
2. **在 recipe 里加网络白名单**，并把被拦下的读、写、联网写成事件，显示在看板上。
3. **凭证隔离（L4）单独设计**：至少让 agent 读不到 `~/.lingtai/config.yml` 和 `gh` 的登录态，再考虑出网时注入密钥。
4. **Docker 镜像照原计划做**，容器就是服务器场景的隔离层（L5）。
5. **OpenSandbox 和 Docker Sandboxes 记入观察名单**，等 Lingtai 有多机或多并发的执行模式时再评估。

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
