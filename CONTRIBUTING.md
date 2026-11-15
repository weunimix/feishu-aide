# 贡献指南

本项目同时面向人和 agent。硬性技术约束见 [AGENTS.md](AGENTS.md)，这里写协作流程：**分支怎么活、PR 怎么进、坏了怎么退**。

## 1. 基本模型

- 主干开发（trunk-based）：`main` 始终可构建、可发布；所有改动经 PR 进入。
- 一个 PR 一个关注点，大小以“一个下午能认真 review 完”为上限；更大的改动先拆，或先开 issue 对齐方向。
- 分支是短命的临时载体，不是工作区。合并后即删除。
- 语言：文档、代码注释、commit、PR/issue 正文、review 回复一律用中文；标识符、命令、路径、API 名与上游专有名词保留原文（见 [AGENTS.md](AGENTS.md) 硬约束 9）。

## 2. 分支生命周期

| 阶段 | 规则 |
|---|---|
| 创建 | 从最新 `main` 开；命名 `<type>/<kebab-slug>`，type ∈ `feat` `fix` `docs` `ci` `refactor` `chore` `hotfix` |
| 开发 | 可以频繁 push；PR 先开 draft，让 CI 尽早跑 |
| 就绪 | 标记 ready-for-review；CI 全绿；分支已同步 `main`（`git rebase origin/main`） |
| 合并 | 只允许 **squash merge**；PR 标题成为最终的 commit 标题 |
| 合并后 | 删除 head 分支（仓库设置 `delete_branch_on_merge` 自动删，或人工删）；每周清理任务只兜底历史遗留 |
| 放弃 | 关 PR 并写明原因；分支由清理流程或人工删除，不留在远端自生自灭 |

- **寿命上限 7 天。** 超期说明拆分不够，或这件事还不该做。
- 不要建长期个人分支，也不要 `develop`；版本线用 tag，不用分支。
- `release/*`、`hotfix/*` 目前只是清理任务的保留模式，**尚未定义发布流程**。真正引入发布前不要使用它们。

## 3. 提交信息

```text
<type>(<scope>): <中文祈使句摘要>

<为什么需要这个改动>
```

- `type` 同分支类型；`scope` 可选：`core` `sync` `search` `mcp` `cli` `ci` `docs`。
- 标题用中文祈使句，≤72 字符，不加句号；`type` 与 `scope` 保持英文。
- 正文也用中文，解释动机、取舍与被否决的方案；破坏性变更写 `BREAKING CHANGE:`（这个标记本身是约定的关键字，保留英文）。
- squash merge 后 PR 标题就是提交信息，所以 **PR 标题必须符合本节格式**。PR 标题由 [.github/workflows/pr-title.yml](.github/workflows/pr-title.yml) 自动校验（本地可跑 `pnpm title:check "ci: 示例"`）：格式不符会阻止合并；它只校验格式、不校验语言，Dependabot 的英文标题也能通过。Dependabot 的 PR 跳过长度检查——分组标题由 bot 生成、长度不可控（例如 82 字符的 `chore(deps-dev): bump ...group across 1 directory with 2 updates`），格式仍会校验。
- 已经推送的英文提交不追溯改写；从本规范生效后新增的内容一律用中文。

## 4. PR 流程

1. **先开 draft PR**：尽早暴露方向，也让 CI 尽早跑。
2. 填完模板，尤其是“验证证据”和“风险与回滚”；用 `Closes #<issue>` 关联 issue。
3. ready 的条件：两个 OS 的 CI 全绿、分支已同步 `main`、review 意见已解决。
4. 合并方式：squash。合并人确认 PR 标题符合提交规范。
5. 合并后 `main` 变红：**先 revert**，再排查。不要在红的主干上继续叠改动。

### 必需检查

| check | 来源 |
|---|---|
| `verify (ubuntu-latest)` | [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| `verify (windows-latest)` | 同上 |

分支保护按 **job 名逐字匹配**，改名等于改门禁：必须在同一 PR 里更新仓库规则（见 [docs/repo-settings.md](docs/repo-settings.md)）。

### 评审关注点

- 会不会写坏用户磁盘：路径清洗、大小写冲突、Windows 保留名、超长路径、半写文件；
- 会不会把真实租户数据/凭证带进仓库、日志或 artifact；
- 分页、限流、增量、删除、权限这些“同步语义”是否有测试，失败时能否部分成功并报告；
- 有没有为了变绿而削弱检查。

单人维护期间允许自己合并，但**不跳过 CI**；有第二位维护者后把 required approvals 设为 1。

## 5. 废弃与清理

- 已合并分支：合并时即删除；每周 [branch-cleanup.yml](.github/workflows/branch-cleanup.yml) 只处理历史遗留。
- 清理策略保守：任何信号读不到就保留（见 [scripts/prune-merged-branches.mjs](scripts/prune-merged-branches.mjs)）。改规则必须同时改单测，并在 PR 里说明放开的是哪一条证据。
- 僵尸 PR：计划在 P1 启用 `actions/stale`（14 天无活动打 `stale`，30 天关闭，可随时重开）。启用前由维护者每周清理。关闭不等于否定，只是不让队列变成垃圾场。

## 6. 本地开发

```sh
pnpm install
pnpm check          # secret scan + docs:check + typecheck + unit + policy
pnpm docs:impact src/core/path-safety.ts   # 改源码前查受影响的文档块
pnpm build
```

- Node 24 + pnpm 10；Windows 上注意 CRLF 与文件名大小写。
- 测试一律使用临时目录；不要把缓存目录指到仓库里。
- 真实飞书凭证只用于将来的 live canary；本地调试也不要提交 `.env`。

## 7. 仓库设置

分支保护、合并方式、secret scanning 等**不在 git 里**，清单与核对命令见 [docs/repo-settings.md](docs/repo-settings.md)。改动流程时如果涉及设置，请同步更新那份清单。

## 8. 文档块与源码映射

`README.md` 和 `docs/**/*.md` 的每个二级标题（`##`）是一个文档块，必须在块内声明它描述的源码，否则 `pnpm docs:check` 会失败：

```md
## 增量同步与游标 {#sync-incremental}

<!-- src: src/sync/incremental.ts, src/sync/cursor.ts -->

正文……
```

- 不描述代码的块写 `<!-- src: none -->`，不要省略——省略会让“漏映射”和“无需映射”无法区分。
- 一个块可以列多个文件；路径以仓库根为基准、用 `/`，必须存在且是文件，不能逃出仓库。
- `src/` 下每个 `.ts` 至少被一个块引用；确实不需要文档的写进 `docs/doc-coverage-ignore.json` 并给出理由。豁免项已被引用、文件不存在或理由为空都会报错。
- 新增/移动/删除源码文件或改标题后，运行 `pnpm docs:map` 重新生成 `docs/doc-map.json` 并一起提交；CI 会比对生成物与文档是否一致。
- 改代码前用 `pnpm docs:impact <文件或目录>` 查出受影响的块，只更新这些块。
- 锚点默认由标题生成；标题重复时用 `{#anchor}` 显式指定。
- 这套检查只断言可验证的结构事实，不判断文档内容是否“写对了”；语义漂移检测仍在 P4 计划里，不要把它当成已经解决的问题。

## 9. 许可

贡献即同意以 MIT 许可发布，见 [LICENSE](LICENSE)。
