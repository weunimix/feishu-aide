# AGENTS.md

给在本仓库工作的 agent 和自动化工具：这里写**必须遵守的约束**和**如何自证**。
面向人的协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；CI 的取舍理由见 [docs/CI-REUSE-PLAN.md](docs/CI-REUSE-PLAN.md)。

## 项目现状（P1）

feishu-aide 为 mmw-tools / DeepSeek Harness agent 提供飞书文档与 wiki 的读取、增量缓存和本地检索，最终形态是 core library + stdio MCP server。

- 已有：仓库骨架、离线 CI（双 OS）、secret scan、分支清理、路径安全模块与单测、文档块 `src` 映射与 `doc-map.json`。
- **没有**：飞书客户端、同步、索引、检索、MCP server。除 [README.md](README.md) 和计划文档明确写出的内容外，不要假设某个能力已经存在。
- 计划与验收标准只在 [docs/CI-REUSE-PLAN.md](docs/CI-REUSE-PLAN.md)。要做超出当前阶段的事，先改计划再改代码。

## 硬约束

1. **不直接推 `main`，不改写已推送的历史**：不 force push `main`，不改写别人的分支。
2. **不提交**：`.env*`（`.env.example` / `.env.sample` 除外）、私钥、`*.db` / `*.sqlite*`、`dist/`、`node_modules/`、日志，以及任何真实租户文档内容或未脱敏 fixture。
3. **PR workflow 不接触真实飞书凭证**。真实凭证只允许出现在受保护的 environment（将来的 live canary）。
4. **不为了让 CI 变绿而删检查、放宽权限或跳过测试**。改 `.github/workflows/**` 或 `scripts/check-secrets.mjs`、`scripts/prune-merged-branches.mjs` 时，必须说明防的失败模式，并同步补/改测试。
5. **不添加没有断言的测试或空 step**。没有断言的绿比红更糟。
6. 扫描/日志类代码命中时**不打印凭证值与文档正文**。
7. 新增运行时依赖前说明用途；核心逻辑优先零依赖（CI 在 install 之前跑策略测试，依赖越少收益越大）。
8. 不确定的事实（飞书 API 行为、Node 能力、GitHub 设置）先验证再写进文档或断言，不要凭记忆下结论。
9. **一律用中文**：技术文档、代码注释、commit message、PR 标题与描述、issue、review 回复，以及日志/报错里的说明性文字，都用中文写。标识符、命令、路径、API 名、上游专有名词（如 `Conventional Commits`、`ruleset`）保持原文，不做硬翻译。历史英文提交不改写，但新内容不再用英文。
10. **文档块必须声明源码归属**：`README.md` 与 `docs/**/*.md` 的每个二级标题块都要有 `<!-- src: ... -->` 或 `<!-- src: none -->`；改 `src/**` 前先跑 `pnpm docs:impact <path>`，新增/移动/删除源码文件后跑 `pnpm docs:map` 并提交生成物。检查只断言引用、覆盖率与生成物一致，不能用改错别字或删映射绕过。

## 分支与提交

- 从 `main` 开分支：`feat/` `fix/` `docs/` `ci/` `refactor/` `chore/` + kebab-case slug，例：`ci/pr-title-lint`。
- 一个分支只做一件事，寿命 ≤7 天；做不完就拆。
- 提交信息用 Conventional Commits：`<type>: <中文祈使句>`，标题 ≤72 字符（`type` 与 `scope` 保持英文）；正文写“为什么”，不要复述 diff。
- 只推自己的分支；需要覆盖自己已推送的分支时用 `--force-with-lease`。

## 提交前自检

```sh
pnpm install --frozen-lockfile
pnpm check      # secret scan + docs:check + typecheck + unit + policy
pnpm build
```

- 新增 `test/**/*.test.ts` 会被 `test:unit` 自动收集；策略脚本测试放 `scripts/*.test.mjs` 并加入 `test:policy`。
- 改动 `src/**` 时先跑 `pnpm docs:impact <path>`，只更新受影响的文档块；新增/移动/删除源码文件后跑 `pnpm docs:map`。
- 因环境限制（无网络、沙箱禁止子进程、缺凭证）跑不了的命令，**必须在 PR 的“验证证据”里写明哪条没跑、为什么**，不能默认它通过。
- 测试一律使用临时目录，不要把缓存目录指进仓库。

## 改动风险分级

| 区域 | 要求 |
|---|---|
| `src/**`、`test/**` | 带测试，`pnpm check` 通过 |
| `scripts/**`（策略代码） | 纯决策函数 + 单测；默认行为必须在安全侧（dry run、宁可保留） |
| `.github/workflows/**` | 每个 step 说明防的失败模式；最小 `permissions`；不引用 secret |
| `docs/**`、`README.md` | 与现状一致；状态行过时就要改，下一个人/agent 会照着它做；块级 `src` 标注与 `docs/doc-map.json` 同步（`pnpm docs:map`） |
| 根配置（`package.json`、`tsconfig*`、lockfile） | 说明动机；lockfile 与 `package.json` 同一次提交 |

## 环境事实（2026-11-15，可能过期）

- 本仓库**未纳入 mmw-tools 插件工作区**（`mmw_tools_status` 显示 `workspace: unmanaged`），不要调用该插件的仓库工具；直接在工作副本操作，推送前人工确认。
- Windows 是主开发环境，CI 覆盖 Linux + Windows。路径、大小写、CRLF、Windows 保留名是真实 bug 源，不能只在 Linux 上验证。
- Node 24 + pnpm 10，以 `package.json` 的 `engines` / `packageManager` 为准。

## 完成定义

同时满足以下五条才算完成：

1. `pnpm check` 与 `pnpm build` 通过（或 PR 里写明未跑原因）；
2. 新增/修改的行为有测试，且测试在实现回退时真的会红；
3. 文档与代码一致（README 状态行、计划文档、注释、文档块 `src` 标注与生成的 `doc-map.json`）；
4. 没有把秘密、缓存、构建产物、租户数据带进提交；
5. PR 描述里有可复核的验证证据（命令 + 结果，或 CI run 链接）。
