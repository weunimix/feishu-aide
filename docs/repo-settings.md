# 仓库设置基线（Repo settings as code）

Status: 2026-11-14 已应用并逐条核对（ruleset `27264463` / `27264465`）。**下列设置只存在于 GitHub 仓库设置里，不在 git 历史中；数值变化没有 diff，靠本文件的核对记录与将来的 `repo-audit.yml` 兜底。**

为什么要有这份文件：分支保护、合并方式、secret scanning 这些开关不随 `git clone` 走，在 UI 上改一次没有任何 diff，门禁被拆了也没人知道。P1 计划加每周 `repo-audit.yml` 用 API 断言这些值（见 §8），在那之前靠这份清单人工核对。

改设置 → 更新本文件；改本文档 → 同步 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [AGENTS.md](../AGENTS.md)。

## 1. 合并与分支（General）
<!-- src: none -->

| 设置 | 期望值 | 为什么 |
|---|---|---|
| Default branch | `main` | 单一主干，所有 PR 的 base |
| Allow merge commits | **off** | 线性历史；revert 粒度 = 一个 PR |
| Allow squash merging | **on（唯一）** | PR 标题即 commit 标题，提交信息可控 |
| Allow rebase merging | **off** | 避免“只合并了部分提交”的歧义 |
| Automatically delete head branches | **on** | 合并即删；周清理只兜底历史遗留 |
| Allow auto-merge | **on** | agent 可在 CI 绿后自动合，不用等人 |
| Issues | on | 阶段工作挂在 issue / milestone 上 |
| Projects / Wiki / Discussions | 按需，默认 off | 没有明确用途就不要多一个信息孤岛 |

核对：

```sh
gh api repos/mmw-devs/feishu-aide \
  --jq '{default_branch,allow_squash_merge,allow_merge_commit,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge,has_issues,has_wiki}'
```

一次性对齐（确认无误后再执行）：

```sh
gh api -X PATCH repos/mmw-devs/feishu-aide \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true
```

已于 2026-11-14 应用，当前值与上表一致（`has_wiki` / `has_projects` / `has_discussions` 同时关闭）。注意：PR #1 是在本规则生效前用手动 merge commit 合的，`main` 历史里因此有一个 merge commit；此后只允许 squash。

## 2. `main` 的分支规则（Ruleset）
<!-- src: none -->

用 ruleset 而不是旧版 branch protection：支持导出、支持 tag、语义更清楚。

| 规则 | 期望值 | 为什么 |
|---|---|---|
| Require a pull request before merging | **on** | 主干只接受经过 CI 的合并 |
| Required approvals | **0**（单人）/ **1**（有第二位维护者后） | 单人时强制 approve 只会诱发绕过 |
| Dismiss stale approvals | **on** | 新 push 后旧 approve 不应继续有效 |
| Require review from Code Owners | 暂 off（等 CODEOWNERS 落地） | 避免空转 |
| Require status checks to pass | **on** | 门禁的核心 |
| 必需 check | `verify (ubuntu-latest)`、`verify (windows-latest)` | 与 job 名逐字匹配 |
| Require branches to be up to date | **on** | 防“绿的是旧 base” |
| Require conversation resolution | **on** | 有未解决意见不允许合 |
| Require linear history | **on** | 与 squash-only 一致 |
| Block force pushes | **on** | 历史不可改写 |
| Restrict deletions | **on** | 误删 `main` 是最贵的事故 |
| Bypass list | **空**（管理员也不绕过） | 紧急修复也走 PR；真要绕过就先改规则，留下 diff |

核对：

```sh
gh api repos/mmw-devs/feishu-aide/rulesets
gh api repos/mmw-devs/feishu-aide/rulesets/<id>
```

现状（2026-11-14）：规则集 `main-protection`（id `27264463`），`enforcement: active`，`bypass_actors` 为空（管理员也不绕过）；`strict_required_status_checks_policy: true`；`allowed_merge_methods: ["squash"]`。注意 GitHub 默认开启了 `require_extra_approval_for_unattributed_changes`：将来的机器人/未归属提交若被判定为 unattributed，合入需要额外 approve，届时要么调整该参数，要么保证提交带有归属。

P1：把导出的 ruleset JSON 存到 `docs/rulesets/main.json` 作为漂移比对基线。

## 3. Tags
<!-- src: none -->

| 规则 | 期望值 | 说明 |
|---|---|---|
| 保护 `v*` | 禁止删除、禁止强制更新 | 发布标签一旦推出就不该被改指向 |
| 创建权限 | 维护者手动 | 发布流程落地后再自动化 |

现状（2026-11-14）：规则集 `tag-protection`（id `27264465`），匹配 `refs/tags/v*`，禁止删除与更新。**仓库尚无 tag，规则未实测**；第一个 `v*` tag 出现时再验证一次。

## 4. GitHub Actions
<!-- src: none -->

| 设置 | 期望值 | 为什么 |
|---|---|---|
| Default workflow permissions | **read** | PR 代码默认拿不到写权限 |
| Allow Actions to create/approve PRs | **off** | 否则 `GITHUB_TOKEN` 可以自批自合 |
| Fork PR 首次贡献需批准 | on（默认） | 防未知作者直接跑 |
| Allowed actions | GitHub-owned + verified 创作者（或明确 allowlist） | 供应链面 |
| Artifact / log retention | 7–14 天 | 够排障即可；日志可能含内容，别久留 |
| Actions 固定版本 | **固定到完整 commit SHA**（行尾注释版本），Dependabot 维护 | tag 可以被移动；SHA 不能 |
| `sha_pinning_required` | **on** | 新 workflow 写 `@vN` 直接失败，而不是靠 review 记得 |

核对：

```sh
gh api repos/mmw-devs/feishu-aide/actions/permissions
gh api repos/mmw-devs/feishu-aide/actions/permissions/workflow
```

现状（2026-11-15）：`allowed_actions: selected`，`github_owned_allowed: true`，`verified_allowed: true`，`patterns_allowed: ["pnpm/action-setup@*"]`；`default_workflow_permissions: read`，`can_approve_pull_request_reviews: false`；artifact/log retention 14 天（上限 90）；`sha_pinning_required: true`——workflow 里的 action 已固定到完整 SHA，升级由 [.github/dependabot.yml](../.github/dependabot.yml) 每周提 PR。

**实测坑**：只勾 GitHub-owned + verified 时，`pnpm/action-setup@v6` 不在 verified 名单，workflow 直接 `startup_failure`（0 job，run 43602247721），不是普通的 step 失败。必须显式加 `pnpm/action-setup@*` pattern；改 allowlist 后务必用 `gh workflow run ci.yml` 实测一次，别只看设置页。

## 5. 安全
<!-- src: none -->

| 设置 | 期望值 | 说明 |
|---|---|---|
| Secret scanning | **on** | 与 `scripts/check-secrets.mjs` 互补（本地脚本只扫当前树，不扫历史） |
| Push protection | **on** | 在 push 时拦截，而不是等 CI |
| Dependabot alerts | **on** | 依赖漏洞 |
| Dependabot security updates | **on** | 自动开升级 PR |
| Private vulnerability reporting | **on** | 配 `SECURITY.md` 使用（待补） |
| Code scanning / CodeQL | P1 再加 | TS 默认查询集即可 |

现状（2026-11-14）：secret scanning、push protection、Dependabot alerts、Dependabot security updates、private vulnerability reporting 均已开启并回读确认。**偏差**：`secret_scanning_validity_checks` 仍为 `disabled`（PATCH 返回 200 但值不变，疑似组织/计划限制），留在待办；`secret_scanning_non_provider_patterns` 未开。

## 6. 标签
<!-- src: none -->

| 标签 | 用途 | 建议颜色 |
|---|---|---|
| `bug` / `enhancement` / `docs` / `ci` | 类型 | `d73a4a` / `a2eeef` / `0075ca` / `fbca04` |
| `area:core` `area:sync` `area:search` `area:mcp` `area:cli` | 模块 | `5319e7` |
| `size/xs` … `size/xl` | PR 大小，自动打 | `cccccc` |
| `stale` / `needs-info` / `blocked` / `good-first-issue` | 状态与入口 | `ededed` / `fef2c0` / `e99695` / `7057ff` |

创建（bash；已存在的标签会报错，`|| true` 忽略）：

```sh
repo=mmw-devs/feishu-aide
for spec in \
  "bug|d73a4a|可复现的错误" \
  "enhancement|a2eeef|新能力或流程改进" \
  "docs|0075ca|文档" \
  "ci|fbca04|CI、脚本与仓库基建" \
  "area:core|5319e7|核心库与路径/存储" \
  "area:sync|5319e7|同步、分页、限流" \
  "area:search|5319e7|索引与检索" \
  "area:mcp|5319e7|MCP server 与契约" \
  "area:cli|5319e7|CLI" \
  "stale|ededed|长期无活动" \
  "needs-info|fef2c0|缺复现或信息" \
  "blocked|e99695|被外部条件阻塞" \
  "good-first-issue|7057ff|适合作为入门任务"
do
  IFS='|' read -r name color desc <<<"$spec"
  gh label create "$name" --repo "$repo" --color "$color" --description "$desc" || true
done
```

现状（2026-11-14）：18 个标签已创建/更新（`bug` `enhancement` `docs` `ci`、5 个 `area:*`、5 个 `size/*`、`stale` `needs-info` `blocked` `good-first-issue`）；GitHub 自带的 `documentation` `duplicate` `invalid` `question` `wontfix` `help wanted` `good first issue` 保留未删。

## 7. 里程碑
<!-- src: none -->

P1 已完成；P2/P3/P4 建 milestone，PR 用 `Closes #` 或 milestone 挂靠，进度才可查询。

```sh
gh api repos/mmw-devs/feishu-aide/milestones -f title="P2 fake Feishu + contract/integration"
gh api repos/mmw-devs/feishu-aide/milestones -f title="P3 index + retrieval + smoke"
gh api repos/mmw-devs/feishu-aide/milestones -f title="P4 docs SSOT + contracts + live canary"
```

现状（2026-11-14）：上述三个 milestone 已创建；P1 没有对应 milestone（已完成，不需要追溯）。

## 8. 自动化（P1）
<!-- src: none -->

新增 weekly `repo-audit.yml`：

- 用 `gh api` / octokit 读取 §1–§5 的值，与 `docs/repo-settings.json` 中的期望值比对；
- 不一致时 fail 并发通知（或自动开 issue，标签 `ci`）；
- 期望值只存一份，避免文档与脚本各写一份。

## 9. 核对记录
<!-- src: none -->

| 日期 | 核对人 | 结果 |
|---|---|---|
| 2026-11-14 | 起草 | **未核对**（本地工作副本读不到仓库设置） |
| 2026-11-14 | weunimix / agent（gh api） | **已核对并应用 §1–§5**：ruleset 27264463（main）/ 27264465（tag）、merge 设置、Actions allowlist、secret scanning、标签、milestone 均回读确认。偏差 3 处：`secret_scanning_validity_checks` 无法开启；Actions 必须显式放行 `pnpm/action-setup@*`；tag 规则尚无 tag 可测。 |
