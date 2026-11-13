# CI 与仓库工程设计复用方案

Status: proposal (2026-11-14)

本方案把 [mmw-tools](https://github.com/mmw-devs/mmw-tools) 现有的两个 workflow
和 CI 调用的脚本，拆成“直接复制 / 改路径后复制 / 需要重写 / 暂不引入”四档，并给出
落地顺序。

## 1. 前提

假设（与实际不符时，按第 4 节调整）：

- feishu-aide 与 `dsh-mmw-tools` 同构：TypeScript + pnpm 10 + Node 24，作为
  DeepSeek Harness 插件分发。
- 包含一个 stdio MCP server，构建产物随 git 提交——`dsh plugin add git+...`
  读取的是提交的 bundle，而不是安装时现构建。
- 在 Windows 上开发，在 Linux CI 上验证。

短结论：

1. **分支清理三件套可以原样搬**。它只依赖 GitHub API 和 git，不读项目代码。
2. **CI 搬“形状”而不是“内容”**。触发、concurrency、最小权限、双 OS 矩阵、
   pnpm/Node 缓存、frozen lockfile、失败产物，都与业务无关。
3. **最值钱的是三个防假绿检查**：build-before-check、committed-bundle drift、
   stdio smoke。它们防的是“测试测的是刚构建的新文件，仓库里躺的是旧 bundle”
   这类 CI 绿但交付坏的情况。
4. **docs SSOT 和 contracts 很强，但不要第一天就上**。它们要求把文档/契约当
   源码维护，先有足够文档量和稳定工具表再引入，否则只是维护成本。

## 2. 逐条作用与价值

这一节回答“每条到底防什么、复用后买到什么”。价值按“不装会怎样 / 装了会怎样”写，
而不是“最佳实践要求”。

### 2.1 直接复制（零改动）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| 分支清理三件套 | 定时扫描远端分支；只有“PR 已合并、无 base 之外提交、无 open PR 引用、非保护分支、无 workflow/config 引用、合并超过 7 天”全部成立才删除；手动触发默认 dry run；纯决策函数 `decideBranch` 有单测。 | 不装：agent 每个任务开一条 `content/*` 分支，几个月后几百条，人工清理又怕误删。装了：只删“证据齐全”的分支，误删风险由 dry-run 和测试兜底，清理策略可安全迭代。 |
| `.gitattributes` | 强制脚本/工作流/文档使用 LF。 | 不装：Windows 检出 CRLF，Linux 上 `#!/usr/bin/env node` 变成 `node\r`，直接 `bad interpreter`。装了：本地和 CI 字节一致，drift/diff 检查也不会被行尾噪声干扰。新仓库第一天加，成本为零。 |
| `.gitignore` 的取舍 | 忽略依赖/秘密/日志，但明确**不**忽略 `lib/`、`dist/`。 | 防止新成员或 agent 顺手把构建产物加进 ignore，导致 git 安装和 pack 拿到空包。这是“提交产物”策略的一部分。 |

### 2.2 CI 骨架

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| 触发 + concurrency | `push main`、`pull_request main`、`workflow_dispatch`；同一 ref 的新 run 取消旧 run。 | 不装：一个 PR 连推 5 次跑 5 遍全量；旧 commit 的绿可能被当成新 commit 的绿。`workflow_dispatch` 让排障可以复跑，不必空提交。 |
| 最小权限 | 工作流默认 `contents: read`，需要写的 workflow 单独申请。 | PR 代码拿不到写 token；即使 workflow 被改，默认 token 也推不了代码；审计时一眼看出谁需要写。 |
| 双 OS 矩阵 + `fail-fast: false` + `shell: bash` | ubuntu 和 windows 并行；一边红不取消另一边；命令统一用 bash 写。 | 这个仓库在 Windows 开发，路径分隔符、大小写、CRLF、Git Bash 是真实 bug 源。不装：Windows 专属 bug 合并后才暴露。`fail-fast: false` 保证两个 OS 的证据都拿得到，而不是一个红了另一个被 cancel。 |
| `fetch-depth` 按需 | 默认浅克隆；需要 diff base 时才 `0`。 | 一刀切 `0`：每次全量拉历史，慢。该 `0` 却用 `1`：`doc-impact` 找不到 base commit，检查静默失效。只有基于 base 的 diff 检查需要 `0`。 |
| pnpm/Node + cache + frozen | 固定 pnpm 10 / Node 24；缓存 pnpm store；`--frozen-lockfile`。 | 不装 frozen：CI 可能解析到新依赖，昨天的绿今天红，本地却复现不了。缓存路径必须列全所有 lockfile——mmw-tools 踩过这个坑，少列一个就永远 miss。 |
| Fail-fast 顺序 | 静态检查（契约、文档规则、策略自测、无依赖核心测试）先跑，再 `pnpm install` / build。 | 不装：目录写错、文档规则违反要等两次 install + build 才报，反馈从几秒变几分钟。反馈越快，agent 越容易在当前上下文里修完。 |
| 分支保护（配套设置） | main 要求 `CI` 这个 check 通过。 | 不装：CI 红了也能合，main 不再可发布。与 concurrency 配合，保证合入的正是验证过的那个 commit。放在 CI 落地之后开。 |

### 2.3 构建一致性（防假绿，最值钱的一组）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| build-before-check | 先构建，再跑依赖产物的检查和测试。 | 测试对象和交付物同源；否则“测的到底是哪份文件”不确定。 |
| committed-bundle drift | build 之后用 `git diff` 检查 `lib/`、`dist/` 是否与源码同步提交。 | **整份方案里最高价值的一条。** 不装：改 `src` → 测试跑刚构建的新文件（绿）→ 忘记 build + commit bundle → 用户 `dsh plugin add git+...` 拿到旧代码。CI 绿，交付坏。装了：这个发布错误在 PR 就红。成本只有一次 build + diff。 |
| namespace consistency | 校验 `cordis.patch.yml`、`src/const.ts`、MCP `serverInfo`、`package.json` 四处标识符一致。 | 不装：插件能加载但设置面板空白，或 host 认不出 MCP 名字，往往到用户侧才暴露。这类配置/入口层错误，普通单测覆盖不到。 |
| pack contents | 离线模拟 `npm pack` 的文件清单。 | 不装：`.npmignore` 缺失时 npm 回退到 `.gitignore`，发布包缺 `lib/`，用户安装后才发现。只在真的发布 npm 包时需要。 |
| stdio smoke | 真的启动 stdio server，断言 `tools/list`。 | 单测 import 代码，不经过握手；只有 smoke 能证明“提交的入口起得来、工具广告得出去”。几秒钟的成本。 |
| real-git integration | 在临时仓库里真跑 clone/edit/pull/rollback。 | 不装：guard 单测全绿，但真正改用户仓库的代码路径从没执行过。沙箱 EPERM 时大声 SKIP，CI 的 ubuntu/windows 上真跑。 |
| 失败上传产物 | 失败时上传 `lib/`、`dist/`，保留 7 天。 | 不装：Windows-only 失败本地复现不了，只能盲猜。装了：直接下载产物对比。 |
| pre-install 无依赖测试 | 纯 Node 核心（协议、策略）在 `pnpm install` 前跑测试。 | 核心坏了秒级失败，不用等网络安装；核心与插件构建解耦，改核心不必等 install。 |

### 2.4 文档与契约（后期再上）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| docs SSOT | `doc-map.json` 登记每篇文档；`doc-impact` 把源码改动映射到文档；`check-docs` 拒绝已知漂移标识符；`AGENTS.md` 只链接不复制。 | 对 agent 协作，文档是输入不是装饰：文档说错，agent 就按错的规则改代码，错的不是排版而是行为。不装：改代码忘改文档，漂移慢慢累积。装了：PR 强制同步；写死测试数量这类必然过期的话进不了 living 文档。 |
| contracts | `tools.json` / `roles.json` 单一源，`check-contracts.mjs` 生成 REFERENCE + golden 路由表并校验漂移。 | 不装：工具表、权限矩阵、文档、fixture 各写一份，改一处漏三处。装了：只有一份真相，改 JSON 的影响面可审计，生成物漂移变红。 |
| 策略脚本自测 | 分支清理、文档映射的纯决策函数有单测。 | CI 自己也是代码。不测：改一行清理策略就可能误删分支，没人敢动。 |
| CI 注释解释 why | 每个 step 写明防的失败模式，而不是复述命令。 | 不装：后人/agent 把关键检查当冗余删掉，CI 慢慢腐化；review 时也无法判断检查是否仍然必要。 |

### 2.5 为什么不照搬另外几样

- **`check-docs.mjs` 的 `FORBIDDEN` / `STATUS_DOCS`**：这是 mmw-tools 自己的历史债
  （旧权限名、旧目录名、特定文档清单）。抄过来会把别人的历史债变成你的 CI 规则。
- **`doc-map.json` 的具体条目**：路径和职责都不同，照抄会立刻失败；要按 feishu-aide
  的实际文档重写。
- **双 lockfile 缓存、auth-core pre-install 顺序**：依赖 mmw-tools 的 monorepo 形态
  （插件 + MCP server + 独立 auth core）。单包项目不需要，照搬只会增加噪音。
- **全量 Windows 矩阵**：它值 2x Actions 分钟。预算紧时可以改成 PR 只跑 ubuntu、
  nightly 跑 windows，但路径类 bug 会延后暴露。

## 3. 怎么搬

### 3.1 分支清理

来源：

- [`.github/workflows/branch-cleanup.yml`](https://github.com/mmw-devs/mmw-tools/blob/main/.github/workflows/branch-cleanup.yml)
- [`scripts/prune-merged-branches.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/scripts/prune-merged-branches.mjs)
- [`scripts/prune-merged-branches.test.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/scripts/prune-merged-branches.test.mjs)

复制命令（在 feishu-aide 根目录）：

```powershell
New-Item -ItemType Directory -Force scripts, .github\workflows | Out-Null
Copy-Item ..\mmw-tools\scripts\prune-merged-branches.mjs scripts\
Copy-Item ..\mmw-tools\scripts\prune-merged-branches.test.mjs scripts\
Copy-Item ..\mmw-tools\.github\workflows\branch-cleanup.yml .github\workflows\
```

不需要改任何内容：

- 仓库名从 `GITHUB_REPOSITORY` 或 `origin` 推导，不写死。
- 删除条件是保守的“全部信号都干净”：PR 已合并、没有 base 之外的新提交、没有
  open PR 引用它、不是受保护分支、没有 workflow/config 引用、合并时间超过保留
  窗口（默认 7 天）；任何未知信号都保留分支。
- 手动触发默认 dry run，只有 `schedule` 才带 `--apply`。
- 测试的是纯决策函数 `decideBranch`，不碰 GitHub，可以随搬。

### 3.2 CI 骨架

来源：[`.github/workflows/ci.yml`](https://github.com/mmw-devs/mmw-tools/blob/main/.github/workflows/ci.yml)。
建议的起点：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  verify:
    name: verify (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

`fetch-depth` 先保持默认 1。只有引入基于 base 的 diff 检查（`doc-impact`）时
才改成 0，并加上 mmw-tools 里那段 base SHA 回退逻辑：

```yaml
env:
  DOC_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
run: |
  if [ -z "$DOC_BASE" ] || [ "$DOC_BASE" = "0000000000000000000000000000000000000000" ]; then
    DOC_BASE="origin/main"
  fi
  node scripts/doc-impact.mjs --base "$DOC_BASE"
```

### 3.3 构建一致性

**build-before-check + committed-bundle drift**（最值得搬的一条）：

```yaml
- name: Committed bundles match the source
  run: |
    set -e
    changed=$(git diff --name-only --ignore-cr-at-eol -- lib mcp-server/dist)
    stray=$(git status --porcelain --ignored -- lib mcp-server/dist | sed -n 's/^!! //p' | grep -v node_modules || true)
    if [ -n "$changed" ] || [ -n "$stray" ]; then
      echo "::error::lib/ or mcp-server/dist/ is stale relative to src/. Rebuild and commit the output."
      printf '%s\n' "$changed" "$stray"
      exit 1
    fi
```

落地时要改的：产物路径（`lib/`、`mcp-server/dist/`）换成 feishu-aide 的实际输出。
`--ignore-cr-at-eol` 保留——Windows 上重构建可能只改行尾，不应因此判红。顺序不能
反：先 build，再跑这个检查，最后跑测试。

**namespace consistency**：来源
[`check-namespace-consistency.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/scripts/check-namespace-consistency.mjs)。
它断言插件标识在四处一致：`cordis.patch.yml` 的 `id`/`name`、`src/const.ts`
的 `PLUGIN_ID`/`PLUGIN_DISPLAY_NAME`、MCP server 的 `serverInfo.name`、根
`package.json` 的 `name`。搬过来只需要改要读的文件路径和常量名。

**pack contents**：来源
[`check-pack-contents.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/scripts/check-pack-contents.mjs)。
只在 feishu-aide 真的发布 npm 包时需要；纯 git 安装可以跳过。

**stdio smoke**：`node mcp-server/tests/tools-list.test.mjs` 启动 stdio server，
断言 `tools/list` 返回预期的 publicName 集合。

**real-git integration**：来源
[`tests/integration-git.test.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/tests/integration-git.test.mjs)。
在临时目录造一次性仓库，直接执行工具函数体（含 rollback 路径）。沙箱禁止
`child_process` 管道时大声 SKIP，退出 0；CI 上真跑。

**失败上传产物**：

```yaml
- name: Upload built bundles
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: bundles-${{ matrix.os }}
    path: |
      lib
      mcp-server/dist
    if-no-files-found: ignore
    retention-days: 7
```

### 3.4 docs SSOT 与 contracts（后期）

docs SSOT 的组成：

- [`AGENTS.md`](https://github.com/mmw-devs/mmw-tools/blob/main/AGENTS.md)：硬规则，只链接地图，不复制表；
- [`scripts/doc-map.json`](https://github.com/mmw-devs/mmw-tools/blob/main/scripts/doc-map.json)：每个 tracked markdown 的职责、状态、触发它的源码 glob；
- [`scripts/doc-impact.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/scripts/doc-impact.mjs)：源码改了但对应文档没改 → 失败；
- [`scripts/check-docs.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/scripts/check-docs.mjs)：禁止 living 文档里出现已知会漂移的标识符/测试数量；
- [`docs/DOCUMENTATION.md`](https://github.com/mmw-devs/mmw-tools/blob/main/docs/DOCUMENTATION.md)：权威顺序与状态标签；
- [`.dsh/skills/docs-ssot/SKILL.md`](https://github.com/mmw-devs/mmw-tools/blob/main/.dsh/skills/docs-ssot/SKILL.md)：语义核对流程和 `Doc-Impact:` 记录格式。

什么时候值得上：文档超过 5 篇，或者不止一个人/agent 在写。它能把“改代码忘改
文档”变成红灯，但代价是每篇 markdown 都要登记、source glob 必须命中文件、
新增文档前先想清职责。

如果要上：

1. 复制三个脚本 + `docs/DOCUMENTATION.md` + `.dsh/skills/docs-ssot/`；
2. 重写 `doc-map.json`，不要照抄条目；
3. **删掉 `check-docs.mjs` 里 mmw-tools 的历史规则**（`FORBIDDEN` 列表、`STATUS_DOCS` 清单）；
4. CI 增加 `node --test scripts/doc-impact.test.mjs`、`node scripts/check-docs.mjs`、`node scripts/doc-impact.mjs --base ...`，checkout 改 `fetch-depth: 0`。

contracts：`contracts/tools.json` + `contracts/roles.json` 是唯一源；
`check-contracts.mjs` 生成 `contracts/REFERENCE.md` 和 `contracts/examples/`
golden 路由表，并校验漂移；生成物禁止手改。注意当前 `check-contracts.mjs` 直接
import 了 `mmw-tools-auth/src/policy.mjs`，要搬的话先抽出一个中立的 policy 模块，
或写项目内的 validator。如果 feishu-aide 不暴露带角色/operation 授权的工具集，
这一项可以完全跳过。

## 4. 如果 feishu-aide 不是 DSH 插件

- **保留**：触发/concurrency/权限/双 OS 矩阵、分支清理、`.gitattributes`、
  失败产物、docs SSOT（后期）。
- **删除**：bundle 构建、committed-bundle drift、namespace check、stdio smoke、
  pack check。
- **替换**：`pnpm test` 换成项目自己的测试入口；有 lint 就加一步。
- **内容仓库**（没有 `package.json`）：CI 可退化成 JSON/链接/拼写检查；
  分支清理仍然适用；docs SSOT 反而更值得早引入。

## 5. 落地顺序

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| P0（本次） | README / LICENSE / `.gitignore` / `.gitattributes` / 本方案 | 仓库可 clone，方案可评审 |
| P1（第一周） | 复制分支清理三件套；首个 `package.json` 出现后加最小 `ci.yml`（install + typecheck + test）；CI 有 check 后开 main 分支保护 | PR 上 CI 绿；手动分支清理是 dry run |
| P2（首个可构建切片） | `build:all` → committed-bundle drift → namespace → smoke；发布 npm 时加 pack check | 改 src 不重建 bundle 会让 CI 红 |
| P3（工具表稳定） | contracts + 生成物校验 | 手工改 `REFERENCE.md` 会让 CI 红 |
| P4（文档变多） | docs SSOT + doc-impact on PR base + `fetch-depth: 0` | 新增未登记 markdown 会让 CI 红 |

## 6. 验收清单

- [ ] `pnpm install --frozen-lockfile` 在 ubuntu 和 windows 都通过
- [ ] 改一处 `src/` 但不重新构建并提交 bundle → CI 红
- [ ] 删掉一个 MCP tool 的注册 → stdio smoke 红
- [ ] 手动触发的分支清理只打印候选，不删除
- [ ] 失败运行时能从 artifact 下载到构建产物
- [ ] （P4 后）新增未登记 markdown → doc-impact 红

## 7. 开放问题

- **首个交付形态**：DSH 插件 / 独立服务 / 内容仓库？这决定 P2 哪些检查成立。
- **是否发布 npm 包**：决定 pack check 和 release workflow。mmw-tools 目前只走
  git 安装，没有 release workflow。
- **Windows 矩阵成本**：Actions 分钟数紧张时，可以改成 PR 只跑 ubuntu、nightly
  跑 windows；代价是路径类 bug 延后暴露。
- **依赖自动升级**：mmw-tools 没有 Dependabot/Renovate；插件依赖 DSH pre-release，
  自动升级可能引入不兼容，暂不建议开。
