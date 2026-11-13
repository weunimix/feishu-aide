# CI 与仓库工程设计复用方案

Status: proposal (2026-11-14)

本方案把 [mmw-tools](https://github.com/mmw-devs/mmw-tools) 现有的两个 workflow
和 CI 调用的脚本，拆成“直接复制 / 改路径后复制 / 需要重写 / 暂不引入”四档，并给出
落地顺序。

## 1. 前提与结论

假设（与实际不符时，按第 6 节调整）：

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

## 2. 直接复制（零改动）

### 2.1 分支清理

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

测试的是纯决策函数 `decideBranch`，不碰 GitHub，可以随搬。

### 2.2 `.gitattributes`

已放入仓库根目录。理由：Windows checkout 的 CRLF 可能进入 shebang/YAML；
`*.mjs`、`*.yml`、`*.ts` 显式 `eol=lf` 后，本地和 CI 看到的是同一份字节。
mmw-tools 的这份文件还额外保护了 `AGENTS.md`、`doc-map.json` 和 skill 文档，
后续引入 docs SSOT 时可以照抄这些条目。

### 2.3 `.gitignore` 的取舍

已放入仓库根目录。注意：**不要忽略 `lib/` / `dist/`**。DSH 插件从 git 安装时
执行的是提交进仓库的 bundle；忽略构建产物会让“直接安装”这条路径失效。这也是
下面 committed-bundle drift 检查存在的前提。

## 3. CI 骨架（复制后只改路径）

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

每一块的理由：

| 块 | 为什么保留 |
|---|---|
| `push` + `pull_request` + `workflow_dispatch` | PR 是主入口；main 直推也要拦；`workflow_dispatch` 便于手动复跑和排障。 |
| `concurrency` + `cancel-in-progress` | 同一 PR 连续推只保留最新一次，省 runner，也避免旧提交的绿误导。 |
| 顶层 `permissions: contents: read` | PR 代码不应该拿到写权限；分支清理 workflow 单独申请 `contents: write`。 |
| `os: [ubuntu-latest, windows-latest]` + `fail-fast: false` | 两个 OS 是互补信号：Windows 抓路径分隔符/大小写/CRLF，Linux 抓大小写敏感和 shebang。`fail-fast: false` 让两边的结果都出来。 |
| `defaults.run.shell: bash` | GitHub 的 Windows runner 自带 Git Bash；同一段命令在两个 OS 上语义一致，省掉一套 PowerShell 分支。 |
| `pnpm/action-setup@v4` + `setup-node@v4` + `cache: pnpm` | 版本对齐 `packageManager`；缓存命中靠 `cache-dependency-path` 列全所有 lockfile。单包只写一个；如果以后拆 monorepo，必须把每个 lockfile 都列上，否则缓存打不中（mmw-tools 就是两个）。 |
| `pnpm install --frozen-lockfile` | 防止“本地能装、CI 偷偷升级依赖”。 |

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

## 4. 需要改路径/名字后复制

### 4.1 build-before-check + committed-bundle drift

这是最值得搬、也最容易被漏掉的一条。

`pnpm check` 跑的是构建后被覆盖的新文件；仓库里提交的是旧 bundle。没有下面
这个检查时，测试全绿，用户 `dsh plugin add git+...` 拿到的却是旧代码。

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
`--ignore-cr-at-eol` 保留——Windows 上重构建可能只改行尾，不应因此判红。

顺序不能反：先 build，再跑这个检查，最后跑测试。

### 4.2 namespace consistency

来源：[`check-namespace-consistency.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/scripts/check-namespace-consistency.mjs)。

它断言插件标识在四处一致：`cordis.patch.yml` 的 `id`/`name`、`src/const.ts`
的 `PLUGIN_ID`/`PLUGIN_DISPLAY_NAME`、MCP server 的 `serverInfo.name`、根
`package.json` 的 `name`。搬过来只需要改要读的文件路径和常量名。

价值：这些字符串不一致时，DSH 加载、设置面板、MCP 握手会分别失败，但单测
通常抓不到。

### 4.3 pack contents

来源：[`check-pack-contents.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/scripts/check-pack-contents.mjs)。

它是 `npm pack --dry-run` 的离线替代品，专门抓这个坑：没有 `.npmignore` 时
npm 回退到 `.gitignore`，而 `.gitignore` 排除了 `lib/`，发布包就缺了唯一的
产物。

只在 feishu-aide 真的发布 npm 包时需要。纯 git 安装可以跳过。

### 4.4 stdio smoke

来源：[`test:smoke`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/package.json)。

单测 import 代码，只有 smoke 能证明“提交的入口真的能起来，并且真的把工具
广告出来”。做法：`node mcp-server/tests/tools-list.test.mjs` 启动 stdio server，
断言 `tools/list` 返回预期的 publicName 集合。

### 4.5 real-git integration

来源：[`tests/integration-git.test.mjs`](https://github.com/mmw-devs/mmw-tools/blob/main/dsh-mmw-tools/tests/integration-git.test.mjs)。

在临时目录造一个一次性仓库，直接执行工具函数体（含 rollback 路径），验证
`execFile` 出去的 git 命令。关键设计：

- 沙箱禁止 `child_process` 管道时**大声 SKIP**，退出 0，而不是假装测过；
- CI 的 ubuntu/windows runner 上真跑。

如果 feishu-aide 会 shell out 到 git/npm，就值得保留这个模式；否则跳过。

### 4.6 失败时上传产物

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

只有“构建相关测试失败时想直接看产物”才有价值；纯粹的类型错误不需要。

### 4.7 无依赖核心的 pre-install 测试

mmw-tools 的 auth core 只用 Node 内置模块（`node:sqlite`），所以在
`pnpm install` 之前就能跑测试：核心坏了，几秒内失败，不必等网络安装。
如果 feishu-aide 有类似的纯 Node 模块（协议、策略、模板渲染），照这个顺序放。

## 5. 先别搬：docs SSOT 与 contracts

### 5.1 docs SSOT（文档影响检查）

组成：

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
3. **删掉 `check-docs.mjs` 里 mmw-tools 的历史规则**（`FORBIDDEN` 列表、`STATUS_DOCS` 清单），否则会把别人的历史债变成你的 CI 规则；
4. CI 增加 `node --test scripts/doc-impact.test.mjs`、`node scripts/check-docs.mjs`、`node scripts/doc-impact.mjs --base ...`，checkout 改 `fetch-depth: 0`。

即使暂不上系统，也建议保留两条写作规则：叙述文档不复述会漂移的数量/端点/TTL，
改为链接到源；人类可读的表要么生成，要么不写。

### 5.2 contracts（工具契约单一源）

组成：`contracts/tools.json` + `contracts/roles.json` 是唯一源；
`check-contracts.mjs` 生成 `contracts/REFERENCE.md` 和 `contracts/examples/`
golden 路由表，并校验漂移；生成物禁止手改。

价值：如果 feishu-aide 也暴露一组 MCP 工具 + 角色/operation 授权，这是最强的
设计——工具声明、权限矩阵、生成文档和测试 fixture 全部从一份 JSON 派生。

注意：当前 `check-contracts.mjs` 直接 import 了
`mmw-tools-auth/src/policy.mjs`，不是独立脚本。要搬的话，要么先抽出一个中立的
policy 模块，要么写一个项目内的 validator，不要整段复制后留一个悬空 import。

## 6. 如果 feishu-aide 不是 DSH 插件

- **保留**：触发/concurrency/权限/双 OS 矩阵、分支清理、`.gitattributes`、
  失败产物、docs SSOT（后期）。
- **删除**：bundle 构建、committed-bundle drift、namespace check、stdio smoke、
  pack check。
- **替换**：`pnpm test` 换成项目自己的测试入口；有 lint 就加一步。
- **内容仓库**（没有 `package.json`）：CI 可退化成 JSON/链接/拼写检查；
  分支清理仍然适用；docs SSOT 反而更值得早引入。

## 7. 落地顺序

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| P0（本次） | README / LICENSE / `.gitignore` / `.gitattributes` / 本方案 | 仓库可 clone，方案可评审 |
| P1（第一周） | 复制分支清理三件套；首个 `package.json` 出现后加最小 `ci.yml`（install + typecheck + test） | PR 上 CI 绿；手动分支清理是 dry run |
| P2（首个可构建切片） | `build:all` → committed-bundle drift → namespace → smoke；发布 npm 时加 pack check | 改 src 不重建 bundle 会让 CI 红 |
| P3（工具表稳定） | contracts + 生成物校验 | 手工改 `REFERENCE.md` 会让 CI 红 |
| P4（文档变多） | docs SSOT + doc-impact on PR base + `fetch-depth: 0` | 新增未登记 markdown 会让 CI 红 |

分支保护放在 P1 之后：先有 `CI` 这个 check，才能在 main 上要求它。

## 8. 验收清单

- [ ] `pnpm install --frozen-lockfile` 在 ubuntu 和 windows 都通过
- [ ] 改一处 `src/` 但不重新构建并提交 bundle → CI 红
- [ ] 删掉一个 MCP tool 的注册 → stdio smoke 红
- [ ] 手动触发的分支清理只打印候选，不删除
- [ ] 失败运行时能从 artifact 下载到构建产物
- [ ] （P4 后）新增未登记 markdown → doc-impact 红

## 9. 开放问题

- **首个交付形态**：DSH 插件 / 独立服务 / 内容仓库？这决定 P2 哪些检查成立。
- **是否发布 npm 包**：决定 pack check 和 release workflow。mmw-tools 目前只走
  git 安装，没有 release workflow。
- **Windows 矩阵成本**：Actions 分钟数紧张时，可以改成 PR 只跑 ubuntu、nightly
  跑 windows；代价是路径类 bug 延后暴露。
- **依赖自动升级**：mmw-tools 没有 Dependabot/Renovate；插件依赖 DSH pre-release，
  自动升级可能引入不兼容，暂不建议开。
