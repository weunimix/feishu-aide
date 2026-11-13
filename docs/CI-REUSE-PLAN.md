# CI 与仓库工程设计复用方案

Status: proposal v2.1 (2026-11-14) — P1 已落地；P2 起按本文顺序推进。

v1 假设 feishu-aide 是带客户端 bundle 的 DSH 插件。实际定位是**给 mmw-tools / DSH agent 用的飞书内容获取与本地检索工具**：联网读取飞书文档和 wiki 知识库，增量拉到本地，建立索引，供 agent 检索和读取。这个定位改变了 CI 的风险排序：最高风险不再是“提交的 bundle 过期”，而是“PR CI 依赖真实飞书”“同步/分页/限流逻辑错”“本地缓存路径与检索质量”。

## 1. 定位与三个直接后果

feishu-aide 做三件事：

- 联网读取飞书文档、wiki 知识库；
- 增量缓存到本地；
- 本地检索/读取，辅助 agent 定位信息。

三个直接后果：

1. **PR 的业务测试必须离线**（依赖安装仍走 npm registry）：飞书 API 全部走 fake server 或录制 fixture；真实凭证只用于定时 canary，不进入 PR workflow。
2. **测试重点转向同步正确性**：分页、429、增量、删除、权限、路径清洗、索引迁移，比“构建产物是否提交”更容易造成用户可见的错误。
3. **凭证与缓存是新的安全边界**：app_secret / user token 不进仓库和日志；本地缓存可能含敏感文档，测试和产物上传都要避开。

短结论：

1. 分支清理三件套、`.gitattributes`、CI 骨架仍可原样搬。
2. 最值钱的三条换成：**离线 fake Feishu 集成测试、同步幂等/分页/限流测试、检索 golden 集**。
3. `committed-bundle drift` / `pack` / `namespace` 只在选定分发形态后启用，不要先假设。
4. docs SSOT 和 contracts 仍后置，但 Feishu API 映射、同步语义、认证模型三类文档值得早写。

## 2. 已定决策（2026-11-14）

| 决策 | 结论 | 对 CI 的影响 |
|---|---|---|
| 分发形态 | core library + stdio MCP server；CLI 后加 | P3 加 MCP smoke + pack；若从 git 安装且提交 dist，再加 drift 检查 |
| 认证 | v1 用 tenant_access_token（应用机器人加入知识库）；user_access_token 后续 | fake token provider；refresh/expiry 测试 |
| 存储 | 本地文件 + SQLite FTS5（trigram）；v1 不做 embedding | 迁移/损坏恢复测试；检索确定性 |
| 同步范围 | wiki 空间 + docx；sheets/bitable 后置 | fake server 路由范围可控 |

认证补充：mmw-tools 的飞书 OAuth 只把 `access_token` 用于 `fetchUserInfo`，没有持久化（`mmw-tools-auth/src/auth.mjs:182-187`、`mmw-tools-auth/src/feishu.mjs:43-78`）。所以“复用现有登录直接拿文档权限”不能直接成立；要么给 auth core 加 token 存储/刷新，要么 feishu-aide 自己做 OAuth，要么 v1 用 tenant token。v1 已定为 tenant token；user token 需求出现时再补存储/刷新与对应测试。

存储补充：本机 Node 24.11 的 `node:sqlite` 已验证支持 FTS5 和 `tokenize='trigram'`，中文 substring 检索可用；CI 需要固定 Node 24，并覆盖一次 FTS5 建表，避免 runner 的 SQLite 构建差异到运行时才暴露。

## 3. 逐条作用与价值

这一节回答“每条到底防什么、复用后买到什么”。价值按“不装会怎样 / 装了会怎样”写。

### 3.1 直接复制（零改动）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| 分支清理三件套 | 定时扫描远端分支；只有“PR 已合并、无 base 之外提交、无 open PR 引用、非保护分支、无 workflow/config 引用、合并超过 7 天”全部成立才删除；手动触发默认 dry run；纯决策函数 `decideBranch` 有单测。 | 不装：agent 每个任务开一条分支，几个月后几百条，人工清理又怕误删。装了：只删“证据齐全”的分支，误删风险由 dry-run 和测试兜底。 |
| `.gitattributes` | 强制脚本/工作流/文档使用 LF。 | 不装：Windows 检出 CRLF，Linux 上 `#!/usr/bin/env node` 变成 `node\r`，直接 `bad interpreter`。装了：本地和 CI 字节一致，diff 检查不被行尾噪声干扰。新仓库第一天加，成本为零。 |
| `.gitignore` | 忽略依赖、秘密、日志、本地缓存；是否忽略 `dist/` 取决于分发形态。 | 防新成员或 agent 顺手把构建产物加进 ignore，导致 git 安装和 pack 拿到空包；同时防 `.env`、`*.db`、缓存目录被提交。 |

### 3.2 CI 骨架

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| 触发 + concurrency | `push main`、`pull_request main`、`workflow_dispatch`；同一 ref 的新 run 取消旧 run。 | 不装：一个 PR 连推 5 次跑 5 遍全量；旧 commit 的绿可能被当成新 commit 的绿。`workflow_dispatch` 让排障可以复跑，不必空提交。 |
| 最小权限 | 工作流默认 `contents: read`，需要写的 workflow 单独申请。 | PR 代码拿不到写 token；即使 workflow 被改，默认 token 也推不了代码；审计时一眼看出谁需要写。 |
| PR 不注入 secrets | PR workflow 不引用任何 environment secrets；真实凭证只在独立的定时 workflow 里。 | 不装：fork PR 或恶意 PR 改一行 workflow 就可能把凭证打出来。装了：泄露面从“所有 PR”缩到“受保护的 canary”。 |
| 双 OS 矩阵 + `fail-fast: false` + `shell: bash` | ubuntu 和 windows 并行；一边红不取消另一边；命令统一用 bash 写。 | 这个项目在 Windows 开发，缓存路径、文件名、大小写、CRLF 是真实 bug 源。不装：Windows 专属 bug 合并后才暴露。`fail-fast: false` 保证两个 OS 的证据都拿得到。 |
| `fetch-depth` 按需 | 默认浅克隆；需要 diff base 时才 `0`。 | 一刀切 `0`：每次全量拉历史，慢。该 `0` 却用 `1`：基于 base 的 diff 检查找不到 commit，静默失效。 |
| pnpm/Node + cache + frozen | 固定 pnpm 10 / Node 24；缓存 pnpm store；`--frozen-lockfile`。 | 不装 frozen：CI 可能解析到新依赖，昨天的绿今天红，本地却复现不了。缓存路径列全所有 lockfile。 |
| Fail-fast 顺序 | 无依赖检查（secret scan）先跑，再 install / typecheck / unit / build。 | 不装：目录写错、密钥泄漏要等两次 install + build 才报，反馈从几秒变几分钟。 |
| 分支保护（配套设置） | main 要求 `CI` 这个 check 通过。 | 不装：CI 红了也能合，main 不再可发布。与 concurrency 配合，保证合入的正是验证过的那个 commit。 |

### 3.3 飞书场景新增（核心）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| Fake Feishu server | 用 `node:http` 实现 auth、wiki nodes、docx 内容等端点；支持分页、429/5xx/403 注入；客户端 base URL 可注入。 | 业务测试完全离线、可复现；能跑完整“认证→遍历→拉取→落盘→索引”链路，不依赖真实租户和 secrets。 |
| Fixture 脱敏与回放 | 录制真实响应后替换 token、人名、文档正文；契约测试直接解析 fixture。 | 拿到真实 API 形状，又不把租户数据提交进仓库；fixture 可 review、可 diff。 |
| Feishu API 契约测试 | fixture → typed model；未知字段容忍，必需字段断言。 | 飞书 API 变更时在 parser 层红，而不是用户同步到一半崩。 |
| 分页/cursor | 多页、空页、重复 cursor、`page_size` 边界、`has_more`。 | 漏页和死循环是同步工具最常见的线上 bug；单测最便宜。 |
| 429/退避 | `Retry-After`、指数退避 + jitter、最大次数、不可重试的 4xx。 | 飞书限流严格；没测过的重试会在真实同步时把任务拖死或让应用被限。 |
| 增量同步幂等 | 连跑两次不重复；更新文档只更新一条；删除/移动文档产生 tombstone 或移动；cursor 持久化。 | 用户会反复同步；不幂等会重复、丢文档、索引膨胀。 |
| 部分权限失败 | 单节点 403 不终止全量；记录 skipped；退出码区分“全成功/部分成功/全失败”。 | 知识库常有不可见节点；全有或全无会让工具在真实空间里不可用。 |
| 本地路径安全 | 标题清洗；拒绝 `..`；Windows 保留名（`CON`、`AUX`、`NUL`、`COM1` 等）、尾随点/空格、超长路径、大小写冲突。 | 文档标题不可信；Windows 上这些会直接写失败，而开发者常在 Linux CI 上看不到。 |
| 索引迁移/损坏恢复 | v1→v2 schema 迁移；损坏 DB 可重建；写文件用临时文件 + rename。 | 本地索引会随版本演进；用户不会删库重来，半写状态会永久坏。 |
| 检索 golden 集 | 查询 → 期望文档 id；recall@k 阈值；中文 substring/trigram 用例。 | “帮用户找到信息”是产品价值本身；检索退化必须让 CI 红，而不是靠用户抱怨。 |
| MCP/CLI smoke | stdio server 真启动并断言 `tools/list`；CLI `--help`、`sync --dry-run`、退出码。 | 单测 import 代码不经过握手；只有 smoke 能证明“构建后的入口起得来、工具广告得出去”。 |
| Secret scan | 扫描 tracked 文件里的飞书 token 前缀和 `app_secret` 形态；禁止 `.env` 被跟踪。 | 凭证泄漏比代码 bug 更贵；在 PR 前拦截，成本几秒。 |
| 日志脱敏 | 测试断言 token、文档正文不出现在日志/错误/CI artifact。 | 日志会进终端、CI 产物和用户 issue；这是仅次于仓库的第二泄漏面。 |
| 定时 live canary | 每周用独立测试租户/应用，只读固定小 wiki 空间，跑真实 API。 | 只有真实调用能发现 API/权限/字段变化；隔离在定时任务，PR 不被网络波动卡住。 |

### 3.4 构建与分发（按形态启用）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| build-before-check | 先构建，再跑依赖产物的检查和测试。 | 测试对象和交付物同源；否则“测的到底是哪份文件”不确定。 |
| committed dist drift | build 后用 `git diff` 检查提交的 `dist/` 是否与源码同步。 | 仅当从 git 安装且提交 dist 时需要。不装：测试跑新构建，用户装到旧代码，CI 绿交付坏。 |
| namespace consistency | 校验 MCP `serverInfo.name`、`package.json` name、CLI bin、仓库名一致。 | 不装：host 认不出 MCP 名字，或 CLI 入口对不上，往往到用户侧才暴露。 |
| pack contents | 离线模拟 `npm pack` 的文件清单，断言入口和类型文件在内。 | 仅当发布 npm 包时需要。不装：`.npmignore`/`files` 配错，发布包缺 `dist/`。 |
| 失败上传产物 | 失败时上传 `dist/` 和已脱敏日志，保留 7 天。 | 不装：Windows-only 失败本地复现不了，只能盲猜。**不要上传本地缓存**，它含用户文档。 |
| pre-install 纯核心测试 | 无第三方依赖的协议/策略核心在 install 前跑。 | 核心坏了秒级失败，不用等网络安装；仅当 core 真的零依赖时成立。 |

### 3.5 文档与契约（后期再上）

| 条目 | 作用（机制） | 复用后的价值 |
|---|---|---|
| docs SSOT | `doc-map.json` 登记每篇文档；`doc-impact` 把源码改动映射到文档；`check-docs` 拒绝已知漂移标识符。 | 对 agent 协作，文档是输入不是装饰：文档说错，agent 就按错的规则改代码。这个项目尤其需要 `docs/feishu-api.md`（端点/scope/限流）、`docs/sync.md`（增量/删除/权限语义）、`docs/auth.md`（token 模型）。 |
| contracts | `tools.json` 单一源，生成工具参考，并校验 MCP `tools/list` 与契约一致。 | 不装：工具 schema、文档、测试各写一份，改一处漏三处。装了：agent 看到的工具定义就是服务端真实广告的。 |
| 策略脚本自测 | 分支清理、文档映射、secret scan 的纯决策函数有单测。 | CI 自己也是代码。不测：改一行清理策略就可能误删分支，没人敢动。 |
| CI 注释解释 why | 每个 step 写明防的失败模式，而不是复述命令。 | 不装：后人/agent 把关键检查当冗余删掉，CI 慢慢腐化。 |

### 3.6 不照搬

- **DSH 客户端 bundle 构建**（`build:client`、`cordis.patch.yml`、`window.__ModuleLoader__`）：没有设置面板/UI 就不需要。
- **real-git integration**：这个项目不 clone/edit 用户仓库；用 fake Feishu + 临时目录替代。
- **auth-core pre-install 测试**：只有 core 零依赖时才成立；否则先 install。
- **双 lockfile 缓存**：单包项目一个 lockfile；monorepo 再按包列全。
- **`check-docs.mjs` 的 `FORBIDDEN` / `STATUS_DOCS`**：这是 mmw-tools 自己的历史债，抄过来会把别人的规则变成你的 CI 噪音。
- **全量 Windows 矩阵**：Windows 是主开发环境，至少保留一个 Windows job；不必每个 Node 版本都跑。

## 4. 推荐的 CI 分层

### 4.1 PR CI（业务测试离线，双 OS）

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
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4

      # 版本由 package.json 的 packageManager 固定；再传 version 会冲突
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Secret scan（无依赖，先跑）
        run: node scripts/check-secrets.mjs

      - name: Branch cleanup and secret-scan policy tests（无依赖）
        run: pnpm test:policy

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm build

      # P2 追加：test:contract / test:integration（fake Feishu）
      # P3 追加：test:smoke / test:retrieval；按分发形态决定 dist drift / pack

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: failure-${{ matrix.os }}
          path: |
            dist/
            logs/
          retention-days: 7
          if-no-files-found: ignore
```

说明：

- `fetch-depth` 先用默认 1；等 `doc-impact` 这类基于 base 的检查落地，再对该 job 设 `0`。
- 单测用 `tsx` 直接跑源码，所以 `build` 放在测试之后；它验证“能否产出 dist”，不是测试前置。
- 失败产物只传 `dist/` 和脱敏日志；本地缓存目录不进 artifact。
- 不给未实现的测试加空 step：没有断言的绿比红更糟。

### 4.2 定时 live canary（不进 PR）

```yaml
name: Feishu live canary
on:
  schedule:
    - cron: "0 2 * * 2"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  canary:
    runs-on: ubuntu-latest
    environment: feishu-live
    steps:
      - uses: actions/checkout@v4
      # 版本由 package.json 的 packageManager 固定；再传 version 会冲突
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test:live
        env:
          FEISHU_APP_ID: ${{ secrets.FEISHU_APP_ID }}
          FEISHU_APP_SECRET: ${{ secrets.FEISHU_APP_SECRET }}
          FEISHU_TEST_WIKI_SPACE: ${{ vars.FEISHU_TEST_WIKI_SPACE }}
```

说明：

- 用独立测试应用/租户，只读固定的小 wiki 空间，限制页数与文档数；不写飞书。
- `environment: feishu-live` 只允许 main 或受保护分支，最好加 required reviewer；PR workflow 不引用它。
- 失败就是 workflow 红，GitHub 通知；不在 PR 上跑，避免网络/权限波动误伤。
- `test:live` 默认 skip，只有显式设置 `FEISHU_LIVE=1` 和凭证才执行。

### 4.3 本地开发

- `.env.example` 只列变量名；`.env` 不进仓库。
- `pnpm dev:fake` 启动 fake Feishu；`FEISHU_BASE_URL` 指向本地端口。
- 缓存目录用 `FEISHU_AIDE_DATA_DIR`，测试一律用临时目录。
- `pnpm test:live` 需要真实凭证，默认跳过；不要在本地把测试租户的文档写进仓库。

## 5. 测试矩阵

| 层 | 网络 | 覆盖 | 频率 |
|---|---|---|---|
| unit | 无 | URL/分页/退避/路径清洗/解析 | 每次 PR |
| contract | 无 | fixture → typed model | 每次 PR |
| integration | 仅 localhost fake | auth→sync→index→search | 每次 PR |
| smoke | 无 | MCP `tools/list` / CLI | 每次 PR |
| retrieval | 无 | golden queries | 每次 PR |
| live | 真实飞书 | API/permission canary | 每周/手动 |

## 6. 落地顺序

### P1 落地清单（2026-11-14，done）

- `.github/workflows/ci.yml`：双 OS；secret scan + 策略单测在 install 前；typecheck / unit / build；失败只传 `dist/` 与脱敏日志。
- `scripts/check-secrets.mjs` + `scripts/check-secrets.test.mjs`：凭证形态扫描；禁止 `.env`、私钥、本地 `.db` 被跟踪；命中时不打印凭证值。
- `scripts/prune-merged-branches.mjs` + test、`.github/workflows/branch-cleanup.yml`：保守删除策略，默认 dry run。
- `src/core/path-safety.ts` + `test/unit/path-safety.test.ts`：标题清洗、Windows 保留名/尾随点/超长、根目录逃逸。
- `package.json` / `tsconfig*.json` / `pnpm-lock.yaml`：Node 24 + pnpm 10 + `tsx` + `tsc`；`dist/` 不进仓库。

- **P0（done）**：仓库骨架 + 本方案。
- **P1（done）**：CI 骨架 + secret scan + unit tests + 分支清理；PR 业务测试离线，不依赖业务代码形态。
- **P2**：fake Feishu server + contract/integration；分页、429、403、增量幂等、路径安全。
- **P3**：本地索引 + 迁移 + 检索 golden；MCP/CLI smoke；按分发形态加 dist/pack 检查。
- **P4**：docs SSOT + 工具契约 + 定时 live canary。

## 7. 验收清单

- [ ] PR 业务测试不访问飞书外网（`pnpm install` 除外）；没有 secrets 也能跑完整同步链路。
- [ ] 同一 wiki 同步两次 → 无重复、无丢失；更新/删除/移动各一条测试。
- [ ] 429 按 `Retry-After` 退避，有上限；不可重试的 4xx 不重试。
- [ ] 单节点 403 不终止全量，报告 skipped。
- [ ] 标题含 `../`、`CON`、尾随空格、超长 → 安全落盘（Windows 跑）。
- [ ] 索引 v1→v2 迁移；损坏 DB 可重建。
- [ ] 检索 golden 集达到阈值（含中文 substring/trigram）。
- [ ] 日志/artifact 无 token、无文档正文。
- [ ] 定时 live canary 能发现真实 API 变化。
- [ ] MCP/CLI smoke 通过。
- [ ] 若 git/npm 分发：dist 与源码同步，pack 含入口。

## 8. 决策记录

2026-11-14 已定：core library + stdio MCP server（CLI 后加）；`tenant_access_token` v1；本地文件 + SQLite FTS5 trigram，不做 embedding；wiki + docx，sheets/bitable 后置。

后续再定：

1. **user token**：个人文档或 bot 无权限的空间出现时，给 auth core 加 token 存储/刷新，还是 feishu-aide 自己做 OAuth。
2. **sheets/bitable**：是否扩展同步范围；扩展后 fake server 路由与契约测试随之增加。
3. **分发/常驻**：是否发布 npm、是否需要 Webhook/常驻服务；需要时再加 pack/drift、签名校验和常驻进程测试。
