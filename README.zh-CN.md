[English](README.md) · 中文

> 这是 [README.md](README.md) 的中文本。**英文本是正本**；两者不一致时以英文本为准。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="doc/logo-dark.png">
  <img src="doc/logo.png" alt="" width="64">
</picture>

# Lingtai

Lingtai（灵台）接收一个由票组成的队列，把它们交给编码 agent——可以同时交给多个，每个都在各自的工作树里——并让每一处改动停在检查和冷审查处，直到通过为止。通过的改动它会合并，否则就停下来等你，每一个决定都会写进你本机上的日志。

## Install

你需要 Git 和已登录的 Claude Code，下面的示例还需要 Node.js 和 npm；其余要求见 [requirements](doc/requirements.md)。

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
```

## Quickstart

这一节带你从零开始，在本机上合并一张票，不需要 GitHub 账号。示例使用 [Chapter Garden](https://github.com/steven-zhc/chapter-garden)，一个小型 Astro 站点。这里给出的是 POSIX shell 命令；[tutorial](doc/tutorial.md) 里有 Fish 的写法，并逐一解释每个选项。

先克隆它，再在旁边建一个裸仓库，作为这份检出的 `origin`，这样 Lingtai 会推送并合并到那里，原仓库不会被碰到：

```sh
export CHAPTER_GARDEN_DIR="$HOME/workspace/chapter-garden"
mkdir -p "$(dirname "$CHAPTER_GARDEN_DIR")"
git clone https://github.com/steven-zhc/chapter-garden.git "$CHAPTER_GARDEN_DIR"
git clone --bare "$CHAPTER_GARDEN_DIR" "$CHAPTER_GARDEN_DIR.git"
git -C "$CHAPTER_GARDEN_DIR" remote set-url origin "$CHAPTER_GARDEN_DIR.git"
```

把它注册到 Lingtai，使用本地 SQLite 日志，并在任何合并之前等你批准：

```sh
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent claude-code --reviewer claude-code \
  --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

开一张票。下面的命令把一份完整的请求写进文件，再用它开票（表单保持英文，因为 agent 收到的就是原文）。等 Lingtai 打印出 `created #N` 再继续，这个编号就是下面你要批准的那个：

```sh
cat > "${TMPDIR:-/tmp}/chapter-garden-ticket.md" <<'EOF'
Add the next chapter to After the Rain
labels: feature

Find the latest chapter of this story and write one new chapter that continues it.
Follow the story's existing language, chapter numbering, and Markdown layout.
Keep earlier chapters unchanged. Done when the new chapter appears on the site.
EOF
VISUAL="cp ${TMPDIR:-/tmp}/chapter-garden-ticket.md" lingtai ticket new --project chapter-garden
```

`VISUAL="cp …"` 只是代替编辑器，并不是必须用 `cp`；单独运行 `lingtai ticket new --project chapter-garden` 会用你自己的编辑器打开同一份表单。想换一个故事，改第一行的标题即可：标题见[书架](https://cg.hczhang.com/en/)和 [tutorial 的表格](doc/tutorial.md#step-2--open-one-ticket)，`labels:` 可以是 `feature`、`bug` 或 `documentation`。

在一个终端里启动 Lingtai 并让它一直运行；它停留在前台。在第二个终端里打开看板：

```sh
lingtai start
lingtai board
```

当这张票在等你时，在看板上阅读这处改动并按下 **Approve**，也可以在终端里完成：

```sh
lingtai status chapter-garden --all
lingtai approve chapter-garden --issue <ticket-number>
```

在你的 Chapter Garden 检出里运行 `git pull`，就能看到合并后的改动。

如果要从 GitHub issue 工作，先用 GitHub CLI 登录，再登记仓库。Lingtai 的标签、评论和推送会以该账号的名义出现；提交的作者是这台机器的 git 身份（`user.name`、`user.email`），Lingtai 不会设置它。团队改用 GitHub App，见 [GitHub](doc/github.md)。

```sh
gh auth login --hostname github.com --scopes repo,workflow
lingtai init --project github --github-auth gh
lingtai add <owner>/<repo>
```

## What an agent can reach

Lingtai 派出的 agent 在你的机器上运行，以你的用户身份。下面说明这样做保护了什么，又没有保护什么。

**已隔离**

- agent 在它自己的 git 工作树里工作，而不是在你的检出里。
- 它的环境被过滤为 `PATH`、`HOME`、`TMPDIR`、`LANG`、`USER` 和 `LOGNAME`，再加上你的项目声明的变量。Lingtai 自己的 `LINGTAI_*` 凭据和数据库 URL 不会通过环境交给它，但它可以读取存放这些内容的文件（见下文）。
- 设定其关卡的 recipe 不在 agent 的工作树里，所以它提交的改动无法削弱它自己的检查。

**未隔离**

- Claude Code 运行时没有文件系统沙箱。该 agent 可以读取任何你能读的文件，包括 `~/.lingtai/config.yml`（数据库 URL 和 GitHub App 设置）和 `~/.ssh`，并且它可以访问网络。除非你自己配置了沙箱：你自己的 Claude Code 沙箱加上 `allowUnsandboxedCommands: false`，在 Lingtai 下确实有效，见 [what your own settings can narrow](doc/operating.md#what-your-own-runtime-configuration-can-narrow)。在 `gh` 方式下，你的 `gh` 登录也在这台机器上，所以没有沙箱的 agent 可以以你的身份运行 `gh`。Lingtai 不会把令牌交给它。
- Codex 运行时确实在沙箱中运行（`--sandbox workspace-write`），沙箱会拒绝在其工作目录、`$TMPDIR` 和 `/tmp` 之外的写入，以及 Lingtai 为提交而添加的少数几个目录之外的写入。带有 `tier: sandboxed` 的 recipe 只由这样的运行时提供服务，Claude Code 不行。不要假定沙箱涵盖读取或网络。在 #667 落地之前，你自己的 `~/.codex/config.toml` 里的权限配置会被这个 `--sandbox` 替换；见[测量结果](doc/operating.md#what-your-own-runtime-configuration-can-narrow)。

**如何限制**

Lingtai 自身不增加任何文件访问策略。agent 受 Claude Code 和 Codex 自己的配置限制；对 Claude Code，Lingtai 保留这些配置的效力，对 Codex，目前则会将其替换（见下）。测量于 2026-10-27，darwin，Claude Code 2.1.310 和 codex-cli 0.164.0；各行结果见 [what your own settings can narrow](doc/operating.md#what-your-own-runtime-configuration-can-narrow)（该文档只有英文版）。

- Claude Code：把下面这段原样放进 `~/.claude/settings.json`：

  ```json
  {
    "sandbox": {
      "enabled": true,
      "allowUnsandboxedCommands": false,
      "filesystem": { "denyRead": ["~/.lingtai-probe"] }
    }
  }
  ```

  把路径换成你想关闭的路径。测量只用了一个临时目录，没有测 `~/.lingtai/config.yml` 或 `~/.ssh`。它拦不住这些读取：
  - 单独的 `permissions.deny` 只覆盖 Claude Code 自己的 Read 工具，不覆盖子进程，所以它不是补救办法。
  - 沙箱若没有 `allowUnsandboxedCommands: false`，在 Lingtai 下可以被绕过：`bypassPermissions` 会不经询问就批准未沙箱化的重试。
  - 未测量：没有 bubblewrap 的 Linux（那里没有沙箱）；在该沙箱下完整跑一次 pass（提交会写入工作树之外，agent 可能明显失败）；其他运行时版本；以及 `CLAUDE_CONFIG_DIR`（pass 会丢弃它，于是 Claude Code 读取 `~/.claude`）。
  - `denyRead` 与网络无关，这项设置不限制网络。
- Codex：目前没有任何设置有效。`~/.codex/config.toml` 里的权限配置在 Lingtai 下不起作用，因为 Lingtai 的 `--sandbox` 会替换它；即使在 `read-only` 下读取也成功了（codex-cli 0.164.0）。修复是 #667，尚未落地。在此之前，请在一个你愿意让 agent 看到其文件的用户或机器下运行 Lingtai（见下）。

**该怎么做**

- 在一个用户或一台机器下运行 Lingtai，并且你愿意让 agent 看到该用户或机器上的文件。
- 要报告漏洞，请开一个标题为 "security" 的 issue，不要写任何细节，我们会私下联系你。见 [SECURITY.md](SECURITY.md)。

## Next

- [Why it is built this way](doc/why.md)：日志、目标与架构。
- [The tutorial](doc/tutorial.md)：同一条路径的完整版，含 Fish，以及把项目迁到 GitHub 的第 2 部分。
- [The ten steps of a pass](doc/the-pass.html)：一张票是如何被构建的。
- [Architecture](doc/architecture.html)：你在哪个进程里、谁在向日志追加、状态存放在哪里。
- [Operating](doc/operating.md)：你要输入的一切，以及每一次拒绝的含义。
- [Reference](doc/reference.md)：每个术语、事件类型和动作种类。
- [The decision log](doc/README.md) 和 [roadmap](doc/roadmap.md)。

## License

[Apache License 2.0](LICENSE)。见 [`NOTICE`](NOTICE)。
