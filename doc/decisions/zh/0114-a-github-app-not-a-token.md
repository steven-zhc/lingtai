# 0114 — GitHub 访问方式：个人用自己的 `gh` 登录，团队用 GitHub App

> 中文版，供阅读。以英文原文 [0114](../0114-a-github-app-not-a-token.md) 为准，两者不一致时按英文。

**状态** 已接受 · 2026-10-01，2026-10-28 修订（§1、§8：`gh` 登录）

Lingtai 用两种方式之一访问 GitHub，每台机器选定一次。**一个人单独使用**时，把自己的 GitHub CLI 登录借给 Lingtai：Lingtai 每次需要令牌时调用 `gh auth token` 取一个，什么都不保存。**团队**使用 GitHub App，装在 Lingtai 管理的每个仓库上；App 由 Lingtai 通过 GitHub 的 manifest 流程自己创建，所以没有人会把权限选错。无论哪种方式，凭据都属于运行 conductor 的那台机器，绝不交给 agent；Lingtai 访问不到的仓库会在添加时就被点名，而不是在合并到一半时才发现。

## 背景

Lingtai 要读 issue、写标签和评论、推送分支、开 pull request、合并。细粒度的个人访问令牌（PAT）能做到这些，但它也可能错得悄无声息：一个范围漏掉了某个仓库的令牌，会在干活中途直接返回一个 403。App 的安装让「能访问哪些仓库」成为明确的事实，Lingtai 也能在开工前检查 App 的权限。

App 同时也是安装 Lingtai 时最重的一步：要创建它、保管私钥、再把它装到每个仓库上。对于一个人用在自己仓库上的情况，这一步换来的东西很少。大多数开发者早就登录了 GitHub CLI，它的令牌能访问的正好就是这个人能访问的仓库；而当初促成 App 的那个问题（令牌范围悄悄漏掉一个仓库），通过在添加仓库那一刻检查它（§8）就能解决。手动粘贴的令牌仍然绝不接受：那正是会悄无声息出错的情况。

## 决定

1. **两种方式，每台机器选一次，绝不接受粘贴的令牌。** `~/.lingtai/config.yml` 里的 `github.auth`（或环境变量 `LINGTAI_GITHUB_AUTH`）取值为 `gh` 或 `app`，由 `lingtai init` 写入。
   - `gh`：这个人自己的 GitHub CLI 登录（§8），标注为「适合个人」。
   - `app`：GitHub App（§2–§7），适用于团队、禁止使用 CLI 的 OAuth 应用的组织，或者不希望 Lingtai 以自己名义操作的人。
   - 没有写这一项时：如果已经配置了 `app_id`，就按 `app` 处理，所以在这次修订之前配好的机器照常工作；否则不能从 GitHub 添加任何项目，拒绝时会提示运行 `lingtai init`。

   **什么时候问。** 设置一个项目时依次问：代码在哪里（这台机器上的一个目录，还是一个 GitHub 仓库）；如果是 GitHub 仓库，票从哪里来（它的 issues，还是 Lingtai 自己的表）；然后，只有当答案需要用到 GitHub 时，才问这台机器怎么连 GitHub。这台机器上的目录用这个人自己的 `git` 凭据推送，票是 Lingtai 自己的表，所以永远不会问。这个问题每台机器只问一次：`github.auth` 已经写了，或者已经配置了 App，就不再问，之后的 `lingtai add` 会说明正在用哪种方式。

   **怎么问。** 当 `gh auth status` 显示 CLI 已登录 github.com 且带 `repo` 和 `workflow` 权限范围时，默认选 `gh`，并在提示里说明 Lingtai 打的标签、写的评论、开的 pull request 和做的推送都会显示为这个账号（§8）。否则给两个选项：现在登录，或者创建一个 App。选择现在登录时，把终端交给 `gh auth login --hostname github.com --web --scopes workflow`（如果已登录、只缺 `workflow`，则交给 `gh auth refresh --hostname github.com --scopes workflow`），回来后再检查一次权限范围；登录失败或被中断，就回到选择。Lingtai 不传 `--git-protocol`，也不替 `gh` 回答它自己的任何问题：`gh` 在这台机器上怎么配置 git 是这个人自己的事，Lingtai 也不用它（§8）。只在有终端时提供这个选项。`gh` 没有安装时，说明怎么安装，同时仍然提供 App。命令行上用 `--github-auth <gh|app>` 回答；`--defaults` 不回答这个问题，因为它决定的是 Lingtai 以谁的名义操作。

   **暂不提供：这台机器上的目录，用它在 GitHub 上的 issues 作为票。** 本地项目没有 owner（#354），所以没有 GitHub 客户端；给它一个是另一个决定。想用 GitHub issues 的人，改为添加那个 GitHub 仓库。

   两种方式下，`packages/github` 都是唯一的客户端。两者都是一个按次调用的 `token()` 函数，所以 Lingtai 的其他部分不知道、也不需要知道用的是哪一种。

2. **App 装在每个仓库上。** `packages/github` 是唯一的客户端。它在本地用 RS256 签一个 App JWT（`packages/github/src/app.ts` 里的 `appJwt`，除了 `node:crypto` 不依赖任何东西），再用它换一个安装令牌。`installationToken` 缓存每个令牌，在过期前一分钟刷新，同一时间只刷新一次，所以令牌绝不会在合并到一半时过期。

3. **权限就是这五项，只有这五项。**

| Permission | Level | For |
|---|---|---|
| Issues | read + write | reading work items, writing `agent:*` labels and comments |
| Contents | read + write | cloning, pushing `agent/*`, merging into base |
| Pull requests | read + write | opening and reading pull requests |
| Workflows | read + write | pushing changes to `.github/workflows` |
| Metadata | read | required by GitHub for any App |

   （表格保留英文，与英文原文逐字一致：Issues 读写，用于读取工作项、写 `agent:*` 标签和评论；Contents 读写，用于克隆、推送 `agent/*`、合并到 base；Pull requests 读写，用于开 pull request 和读取它们；Workflows 读写，用于推送对 `.github/workflows` 的改动；Metadata 只读，GitHub 对任何 App 都要求这一项。）

   `packages/github/src/app.ts` 里的 `REQUIRED_PERMISSIONS` 就是这张表的代码版本，`packages/github/unit/manifest.test.ts` 从英文原文里解析这张表来比对。添加仓库时（`packages/conductor/src` 里的 `onboard.ts`、`pick-repository.ts`），`permissionGaps` 拿同一份清单检查安装，逐项点名缺少的权限，而不是留到之后变成一个 403。manifest 只在创建 App 时生效：在此之前创建的 App 要先由所有者在 App 的权限页（`github.com/settings/apps/<slug>/permissions`，组织的 App 在组织设置里）加上 Workflows，之后每个安装才会收到需要同意的请求；同意之前，`permissionGaps` 会点名这个缺口。

4. **App 只订阅 `issues` 事件。** `MANIFEST_EVENTS` 是 `["issues"]`，和 `packages/github/src/webhook.ts` 里接收端的 `ACTED_ON` 一致。不订阅 `push`，因为接收端会丢掉每一次 push 投递。webhook 是一种优化，绝不是依赖，因为 daemon 无论如何都会扫描 GitHub。没有公网 `https://` 地址时，manifest 把这个 hook 声明为**未启用**，也不会把它指向本机。`unreachableWebhook` 拒绝回环、私有、链路本地和只在局域网内的地址。接收端是 board 的 `/api/webhook`，它用常量时间校验 `x-hub-signature-256`，没有配置密钥时返回 503。

5. **App 在 board 里通过 manifest 创建。** board 的 `/setup/github-app` 页面（`packages/conductor/src/create-app.ts`，基于 `packages/github/src/manifest.ts`）自动提交一个 POST 表单到 `github.com/settings/apps/new`，或者组织对应的页面，查询字符串里带 `state`。由人在 GitHub 的页面上给 App 起名。随后 GitHub 带着一个 code 重定向回来，`POST /app-manifests/{code}/conversions` 用它换回凭据。整个流程必须在 GitHub 规定的一小时内完成。App 是私有的（`public: false`），每个团队只创建一次。安装流程通过 `setup_url` 回到仓库选择页。

6. **凭据存在运行 conductor 的机器上，每次从文件读最新的。** 它们是 `~/.lingtai/config.yml` 里的 `github:` 一节，每一项都可以被同名的环境变量覆盖（[0117](../0117-configuration-is-config-yml-and-the-environment.md)）：
   - `app_id` / `LINGTAI_GITHUB_APP_ID`：App ID。
   - `app_private_key_path` / `LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH`：PEM 文件的路径，默认 `~/.ssh/lingtai-agent.private-key.pem`，以 `0600` 权限写入；文件里写相对路径时，相对于 `~/.lingtai`。`app_private_key` / `LINGTAI_GITHUB_APP_PRIVATE_KEY` 则直接内联 PEM，给只能用一行传值的主机用。
   - `webhook_secret` / `LINGTAI_GITHUB_WEBHOOK_SECRET`：可选。没有它时，`/api/webhook` 返回 503，并用一句话说明它该放在哪里。

   设置页把 `github:` 写进 `config.yml`：以编辑文档的方式写，保留其他所有小节和注释；新建文件时权限为 `0600`；已经有 `app_id` 时拒绝写入。`packages/env/src/index.ts` 里的 `githubApp()` 和 `hasGitHubApp()` 在调用时读取文件的当前内容，所以运行中新建的 App 在每个正在运行的进程里都立即生效，不需要重启。**所有名字由同一个来源回答**（`electGithubApp`）：如果导出了 `LINGTAI_GITHUB_APP_ID`，私钥和密钥也从环境变量取；否则全部从文件取，所以绝不会把来自不同 App 的 ID、私钥和密钥配在一起。`config.yml` 解析失败或打不开时，会点名这个文件，绝不说成「没有设置」，也绝不说成日志读不了，设置页也不会在它上面提供创建 App。

7. **密钥绝不写进日志，也绝不打印。** 转换时在接口边界就丢掉 `client_id` 和 `client_secret`，因为 Lingtai 没有 OAuth 流程。日志只在它自己的 stream 上记录 `GitHubAppCreated { appId, slug }`，别的什么都不记。私钥和 webhook 密钥绝不打印，也绝不返回给页面。App 的凭据属于这台机器，由 `@lingtai/env` 持有。agent 的环境来自 `@lingtai/agent-env`，绝不包含它们。推送、合并和关闭是 conductor 的动作，不是 agent 的。

8. **`gh` 登录：按次借用，按仓库检查。**
   - **只借用保存的登录。** `gh` 会优先使用 `GH_TOKEN`，其次 `GITHUB_TOKEN`（以及对应的 `GH_ENTERPRISE_`/`GITHUB_ENTERPRISE_` 变量），而不是它保存的账号。环境变量里的令牌就是粘贴的令牌（§1），所以 Lingtai 运行的每一个 `gh`，无论 `gh auth status` 还是 `gh auth token`，都先去掉这些变量再运行；Lingtai 报告的账号和权限范围都是保存的那个登录的。
   - **令牌每次现取，从不保存。** `token()` 每次都运行 `gh auth token --hostname github.com`，拿到的结果只用于这一次调用。它绝不写进 `config.yml`、日志、远程地址，或 agent 的环境；只临时进入 conductor 启动的每个 `git` 子进程的认证环境，方式和安装令牌一样。`gh` 没有安装、没有登录、或者什么也没返回时，就照实说明，绝不表现成一个 403。
   - **添加仓库时检查。** `lingtai add` 用这个令牌读取仓库，要求 `permissions.push` 为真；令牌缺少 `repo` 或 `workflow` 权限范围，或者这个人没有推送权限时，点名拒绝。这样不需要 App 的安装，§3 的规则（缺少的权限在开工前就点名）照样成立。
   - **两种身份，令牌只决定其中一种。** Lingtai 通过 API 做的事（标签、评论、pull request）和推送者，是已登录的账号，而不是一个机器人。`init` 在推荐这种方式时会说明这一点，这也是团队要用 §2 的主要原因。提交的**作者**，无论是 agent 的提交还是合并提交（`packages/repo/src/integrate.ts:521` 里的 `git merge`），是运行 conductor 那台机器的 git 身份（`user.name`、`user.email`），Lingtai 不设置它；用 App 时也是这样。一个人用一个账号登录 `gh`、git 却配置成另一个身份时，会同时看到两个名字。要把它们统一，是另一个决定。
   - **没有 webhook。** 没有 App 可以订阅事件，靠 daemon 的扫描来发现工作，和任何 webhook 未启用的地方一样（§4）。
   - **agent 能接触到的东西不变。** 两种方式下 agent 都拿不到任何 GitHub 凭据（§7）。这个人的 `gh` 登录本来就在这台机器上，以前也是；防止 agent 去用它，靠的是 runtime 自己的沙箱，由这个人自己配置。

## 后果

- 一个人不需要在 GitHub 上创建任何东西就能开始：先 `gh auth login`，再 `lingtai init`。
- 在 `gh` 方式下，Lingtai 在 GitHub 上的 API 操作和推送与这个人本人的无法区分，令牌的有效期和他的 CLI 登录会话一样长。
- 两种方式下，提交的作者都是这台机器的 git 身份，而不是凭据。
- 修改 `.github/workflows/*` 需要单独的授权：`gh` 方式下是 `workflow` 权限范围，App 方式下是 `Workflows: write`。没有它，一张改 CI 的票会在推送时才被拒绝，而那时构建的钱已经花了，所以两种方式都提前要这项授权。
- 在 `app` 方式下，Lingtai 能访问哪些仓库在安装里一目了然，缺少的权限在添加仓库时就被点名；私钥是运行 conductor 的机器上一个真正长期有效的密钥，它不进入任何仓库，也不进入任何被管理项目的环境。
- 修改 App 申请的权限，必须同时改 §3 的表和 `REQUIRED_PERMISSIONS`。两者不一致时单元测试会失败。

---
*取代 [decisions-archive](../../decisions-archive/) 中已归档的 0006。*
