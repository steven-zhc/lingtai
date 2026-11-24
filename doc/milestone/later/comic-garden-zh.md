# Comic Garden 讨论稿（中文）：练习团队模式的第二个项目

*讨论稿，2026-11-23 起草。先用中文写，方便讨论和修改；定稿后翻成英文。仓库还没建，文档的第 2、3 章
也还没写。这里的东西都是提议，没有一条已经实现。*

## 一、为什么要它

文档改成一本书的读法（每页 600–800 词，从简单到深入）。第 1 章用 Chapter Garden，本地、全部默认，
十分钟看到一个 ticket land。**默认值就是我们推荐的团队模式**（`askMode` 默认 `team`，`apps/cli/src/team.ts:46`），
所以第 1 章本身就是本地 ticket 上的团队模式，讲清楚分支怎么分：`main` 不动，`lingtai-base` 是你的个人分支。
第 2 章用 Comic Garden 在 GitHub 上走完整的团队流程。solo 模式单独一章，放在靠后。（2026-11-23 修订）

团队模式要让读者亲眼看到五件事：

1. ticket land 到自己的分支（`branch.personal`）
2. 提交 PR，等 CI
3. 在 PR 上提出返工，变成一个 pr-fix ticket
4. 别人往 PR 分支推了提交，灵台先把它合进来（#1353）
5. 两个 ticket 改到同一处，冲突 agent 把它们合起来

Chapter Garden 做不了这件事，原因有两个：

- **重名。** 项目名只取仓库名，不带 owner（`apps/cli/src/add.ts:179` 的 `slugRepo`）；
  `alreadyAdded` 按名字比较、不分大小写（`packages/setup/src/apply-setup.ts:121`）。所以本地的
  `chapter-garden` 和 GitHub 上的 `<you>/chapter-garden` 在同一个 home 里会被拒绝：
  *chapter-garden is already added*（`add.ts:183`）。
- **fork 默认关掉 Issues。** 团队模式下 ticket 就是 issue，读者一 fork 就会卡住，而且没有任何提示。

所以第二个项目是一个**新的模板仓库**，名字不同，用 *Use this template* 创建，不用 fork。

## 二、它是什么

**Comic Garden：用户写笑话，系统配成条漫。**

- 一个 issue 就是一个笑话。正文是用户写的原文，agent 把它画成三到四格的条漫，作为网站上的一页。
- 好不好笑是用户自己的事。review 只检查**画得对不对**，不评判好不好笑。
- 内容是用户自己写的，放在用户自己的仓库里。

这正好教了第 6 章要讲的东西：**ticket 的正文就是 prompt**。

## 三、配图怎么配：素材包加分镜脚本

agent 不画图，只写分镜脚本。仓库里预先放好素材包，渲染器把脚本拼成 SVG。

**素材包（`assets/`）：**

| 类别 | 内容 | 数量 |
|---|---|---|
| 角色 | 猫、园丁、会说话的树、蜗牛 | 4 个 |
| 表情 | 平常、开心、吃惊、生气、困惑、得意 | 每个角色 6 种 |
| 道具 | 水壶、梯子、雨伞、铲子、花盆、手机、咖啡杯、书、灯泡 | 9 个 |
| 背景 | 花园、厨房、办公室、夜晚 | 4 个 |

允许 agent 偶尔自己画一个小道具 SVG，放在 `assets/props/extra/`，比如笑话里提到的东西素材包里没有。
自己画的道具有尺寸上限（见第五节），review 也会看一眼。

**分镜脚本（`comics/<slug>.yml`），一个笑话一个文件：**

```yaml
title: The top shelf
joke: |                       # 原文，逐字照抄 issue 正文
  Why did the gardener bring a ladder?
  Because the plants were growing on the top shelf.
issue: 12
lang: en
panels:
  - background: garden
    cast:
      - { who: cat, face: confused }
      - { who: gardener, face: plain, prop: ladder }
    say:
      - { who: cat, text: "Why the ladder?" }
  - background: garden
    cast:
      - { who: gardener, face: smug }
    say:
      - { who: gardener, text: "The plants are on the top shelf." }
```

渲染器是 Astro 的一个组件：读 `comics/*.yml`，每个笑话生成一页 `/comics/<slug>`，首页列出最新的十个。

## 四、首页和分类：冲突在哪里自然发生

- `src/data/latest.yml`：首页“最新漫画”的列表，**每个新笑话都要在最前面加一行**。
- `src/data/tags.yml`：分类（园艺、办公室、动物……），新笑话要加到对应的分类下。

两个 ticket 同时加笑话，就会改到这两个文件的同一处。第二个 land 时会遇到冲突，冲突 agent 把两边
都保留。这不需要刻意制造，只要读者同时投两个笑话就会发生。

## 五、`check`：会真的变红的规则

`npm run check` 是 build 步骤，也是 CI 的 `check` job：

| 规则 | 为什么 agent 会写错 |
|---|---|
| `joke` 必须和 issue 正文逐字相同 | agent 常顺手“润色”原文 |
| 格子数在 3 到 4 之间 | 长笑话容易被拆成 5、6 格 |
| 每个气泡不超过 60 个字符（英文） | 台词写长是最常见的错 |
| `who`、`face`、`prop`、`background` 必须在素材包里 | agent 会编出 `face: sleepy` 这种不存在的表情 |
| 自己画的道具 SVG 不超过 4 KB，`viewBox` 必须是 `0 0 64 64` | 防止画得太复杂 |
| `latest.yml` 里每个 slug 都有对应的文件，反过来也一样 | 冲突合并时容易漏掉一边 |
| `astro build` 通过 | 兜底 |

第一条最有用：它会真的变红，修起来又很便宜。build 红了就买一轮修复，读者会亲眼看到“红了自动修”。

## 六、review 看什么、不看什么

写在练习项目 recipe 的 review 提示里：

- **看**：包袱是否在最后一格；台词是否忠于原文；有没有漏掉笑话里的人物或道具；表情和台词对不对得上。
- **不看**：好不好笑。这一条明确写进提示里。否则 review 会一轮一轮地挑，读者的钱就白花了。

## 七、issue 表单

`.github/ISSUE_TEMPLATE/joke.yml` 是一个 GitHub issue form，三个字段：

- 笑话原文（必填，多行）
- 想要的角色（可选，多选，选项就是素材包里的角色）
- 语言（先只有 English）

提交后自动打上 `feature` 标签。仓库还预置了 `bug`、`tech-debt`、`documentation` 三个标签。

**表单没法把 issue 分配给读者本人**，因为模板里写死的用户名，在别人复制出来的仓库里就不对了。
所以教程要明确写一步“把它分配给你自己”。团队模式本来就只领分配给你的票：它拒绝 `take: all` 和
`take: unassigned`（`doc/recipe.md:246`）。这一步正好用来讲清楚 `take: mine` 的意思。

## 八、预置的 issue

仓库建好时自带这些 issue，都带 kind 标签，但都还没分配给人。读者分配哪个，灵台就做哪个：

| # | kind | 内容 | 演示什么 |
|---|---|---|---|
| 1 | `bug` | “夜晚”背景下，气泡的字是黑的，看不见 | 预埋的真 bug；`bug` 排在 `feature` 前面 |
| 2 | `feature` | 一个关于浇水的笑话 | 最普通的一个 ticket |
| 3 | `feature` | 一个关于咖啡的笑话 | 和 2 同时分配，演示冲突 |
| 4 | `documentation` | README 加一节“怎么新增一个角色” | kind 的优先级排最后 |

## 九、假同事

`.github/workflows/coworker.yml`：读者的 PR 一打开，它就按剧本做一件事。

- 往 PR 分支推一个提交：修正 README 里一个预埋的错别字。

接着读者在 PR 上提出返工，比如“第三格的猫应该是吃惊的表情”，变成一个 pr-fix ticket（具体怎么开，
以 ADR 0131 为准）。pr-fix land 之前，灵台会先把假同事的提交合进来（#1353）。读者能在 PR 的提交
历史里看到这一步。

**要注意的坑：**

- **用 `GITHUB_TOKEN` 推的提交不会再触发工作流**，所以假同事推完之后 CI 不会重跑。要等灵台下一次推送时才会触发。教程不能写成“假同事推完就能看到 CI 重新跑”。
- **它会往读者的仓库推提交、留评论**，所以 README 第一屏要写明它会做什么、怎么关掉它（删掉这个文件）。读者不知情时看到陌生的提交，会以为仓库被入侵了。
- **它只做一次。** 用 PR 上的一个标签记下“已经做过了”，不然每次推送都会再推一个提交。

## 十、练习项目的 recipe

`lingtai add <you>/comic-garden` 时的选择，教程里写成一条命令：

- `mode: team`，`branch.personal` 用默认值
- `source.assignee.take: mine`
- `build`：`npm ci` 和 `npm run check`
- `pr.ci.required: [check]`
- review 提示里加上第六节的那几句

## 十一、还没定的

1. **同一个 home 能不能直接再 `add` 一个 GitHub 项目？** 第 1 章是纯本地 `init`，没有设置 GitHub 认证。之后再 `add`，会不会顺利补问认证？从 `add.ts:226` 附近的注释看会，但还没实际跑过。要先在临时的 `LINGTAI_HOME` 里试跑一遍。
2. ~~#1343 怎么处理~~ **定了（2026-11-23）：重写 #1343 的正文**，改成第 2、3 章用 Comic Garden。
3. ~~仓库放在哪个账号下~~ **定了（2026-11-23）：`steven-zhc/comic-garden`**，不另开组织。
4. **中文。** 先只做英文；双语时，气泡的字数限制要按语言分别算。
5. **第 3 章什么时候写。** 要等 #1331 的验收结束、团队流程稳定以后，照着真实跑出来的结果写，不照 mock 写。
