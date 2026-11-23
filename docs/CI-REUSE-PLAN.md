# CI 与工程约束

Status: v3 (2026-11-20)。本文只讲 CI 与仓库工程；产品形态、数据事实源与写回语义见 [DESIGN.md](DESIGN.md)。

## 1. 原则
<!-- src: none -->

三条约束决定这套 CI 的形状：

1. **PR 不碰真实飞书**。业务测试全部离线：飞书端点走注入 base URL 的 fake server，或录制后脱敏的 fixture 回放。真实租户验证是手动的，不进入 PR。
2. **最贵的错误是写回**。读错只是回答不准，写错会改坏用户的文档。测试重点因此从"能不能拉到"转向"写回是否幂等、是否守住版本、失败是否如实报告"。
3. **凭证只存在于用户机器**。设备流授权得到的是用户 token，仓库、CI、日志里都不能出现。secret scan 与日志脱敏是硬要求。

## 2. 直接复用的工程约束
<!-- src: none -->

| 条目 | 作用 | 不装会怎样 |
|---|---|---|
| `.gitattributes` 强制 LF | 脚本/文档字节一致 | Windows 检出 CRLF，`#!/usr/bin/env node` 变成 `node\r`，直接执行失败 |
| `.gitignore` | 忽略依赖、秘密、日志、本地缓存 | 新成员或 agent 顺手提交 `.env`、私钥、本地数据 |
| 分支清理 | 只删"PR 已合并、无 base 之外提交、无 open PR 引用、非保护分支、合并超过 7 天"的分支，默认 dry run | 每个任务开一条分支，几个月后几百条，人工清理又怕误删 |
| secret scan | 扫描凭证形态，拒绝 `.env`、私钥、本地数据库被跟踪；命中时不打印值 | 凭证泄漏比代码 bug 更贵 |
| 三 OS 矩阵 + `fail-fast: false` | ubuntu、windows 与 macos 并行，一边红不取消另一边 | Windows 是主开发环境，macOS 是插件用户的常见平台；路径、大小写、CRLF 与 POSIX 权限差异只在合入后暴露 |
| 最小权限 + PR 不引用 secret | 工作流默认 `contents: read` | 恶意 PR 改一行 workflow 就可能把凭证打出来 |
| action 固定到完整 SHA | 行尾注释版本号，依赖 Dependabot 升级 | 标签可被上游移动，供应链攻击面 |

## 3. 飞书场景新增
<!-- src: none -->

| 条目 | 作用 | 不装会怎样 |
|---|---|---|
| Fake Feishu server | `node:http` 实现文档、块、搜索、消息与块更新端点；按 `client_token` 去重，支持 5xx 与业务码注入；客户端 base URL 可注入 | 业务测试必须联网，PR 依赖租户与凭证 |
| Fixture 脱敏与回放 | 录制真实响应后替换 token、人名、正文 | 要么没有真实形状，要么把租户数据提交进仓库 |
| 块渲染降级 | 未知块类型转纯文本；断言不抛错 | 飞书新增块类型时直接崩 |
| 分页与游标 | 多页、空页、重复游标、`page_size` 边界、`has_more` | 漏页与死循环是取数最常见的线上 bug |
| 限流退避 | 429 按 `Retry-After`，指数退避带上限；不可重试的 4xx 不重试 | 真实调用时把任务拖死 |
| 写回幂等 | 同一请求重复执行两次，文档只变化一次 | 网络重试造成重复块 |
| 版本冲突 | `base_revision` 不匹配时拒绝，不静默覆盖 | 覆盖他人的修改，且无法恢复 |
| 部分失败 | 部分写入必须如实报告已写块 | "成功"的报告与文档实际状态不一致 |
| 日志脱敏 | 断言 token 与文档正文不出现在日志/错误里 | 日志会进终端、issue 与 CI 产物 |

## 4. CI 分层
<!-- src: none -->

PR CI 顺序按"失败最快、依赖最少"排列：

1. secret scan（无依赖）
2. 策略脚本单测（无依赖）
3. 文档块检查 `docs:check`（无依赖）
4. 版本一致性检查 `scripts/check-release-version.mjs`（无依赖）：README 安装地址里的 tag 与文件名必须等于 `package.json` 的版本
5. `pnpm install --frozen-lockfile --engine-strict`
6. `typecheck` → `test:unit` → `build`
7. `pack:check`（在 `build` 之后，校验 tarball 内容）

发版由 `release.yml` 在 tag 上执行：先校验 tag 与 `package.json` 版本一致，再重跑 typecheck、单测、文档检查、`build` 与 `pack:check`，最后用同一次运行产出的 tarball 建 Release，并附 `.sha256`。这样 Release 资产不可能来自未通过检查的提交，也不依赖本地机器的构建环境。

每个 job 都设了 `timeout-minutes`：卡住的步骤默认可以占满 6 小时，而这套检查在本机与 CI 都只需要一分钟量级。

PR 的 base 分支不设限制：基于未合并分支的堆叠 PR 同样要跑一遍，否则问题会拖到 rebase 到 `main` 之后才暴露。

`engine-strict` 同时写进 `.npmrc` 与 CI 的 install 命令：`engines` 声明 Node ≥24，版本不符时应该在安装阶段失败，而不是装完之后才在运行时出错。

真实飞书验证不放在 CI：设备流授权需要人在浏览器里点确认，无法无人值守复现。这部分由维护者在本地手动验证，结果写进 PR 的验证证据。

依赖布局固定为 hoisted（`.npmrc`）：Windows 上没有创建符号链接的权限时 pnpm 会退回 junction，而 Node 不把 junction 当作符号链接、不会 realpath，SDK 的传递依赖（axios → form-data）从 junction 路径向上查找时会失败。hoisted 布局让本地与 CI 走同一条解析路径。

## 5. 测试矩阵
<!-- src: none -->

| 层 | 网络 | 覆盖 | 频率 |
|---|---|---|---|
| unit | 无 | 参数校验、块渲染、写回计划、游标、退避 | 每次 PR |
| contract | 无 | fixture → typed model，未知字段容忍、必需字段断言 | 每次 PR |
| integration | 仅 localhost | fake server 上的读、写、冲突、幂等链路 | 每次 PR |
| bundle smoke | 无 | 插件装配后工具注册表与 schema 正确 | 每次 PR |
| live | 真实飞书 | 真实租户上的只读检查 | 手动 |

## 6. 落地顺序
<!-- src: none -->

- **P0（done）**：仓库骨架。
- **P1（done）**：CI 骨架、secret scan、策略单测、路径安全、文档块映射。
- **P2（done）**：fake Feishu server + integration；读、搜索、消息、块级写回，以及写冲突与幂等的端到端链路已覆盖；读文档按版本缓存并补齐生命周期；限流退避、未知块降级与插件装配 smoke 已覆盖；首次使用自动创建应用的两阶段授权在真实租户上手动验证通过。
- **P3（done）**：`pack:check` 校验 tarball 内容（入口、`cordis.patch.yml`、不含 `src/` 与 `test/`、无陈旧 `dist` 产物）；分发走 GitHub Releases 上的 tarball，发版由 `release.yml` 在 tag 上自动构建并附 SHA-256。

## 7. 验收
<!-- src: none -->

- [x] 没有凭证时也能跑读、搜索、消息与块级写回的请求往返（fake server）。
- [x] 同一写请求执行两次，文档只变化一次。
- [x] `base_revision` 不匹配的写被拒绝，并返回当前版本。
- [x] 同一版本重复读文档只拉一次块，版本变化后自动失效。
- [x] 未知块类型渲染为纯文本，不抛错。
- [x] 429 按 `Retry-After` 退避且有上限。
- [x] 日志与工具输出中无 token、无文档正文。
- [x] 插件装配后工具列表与 schema 与代码一致。
- [x] 首次使用的两个阶段（建应用、授权）各自可反复调用且不重复创建应用，缺少 `search:docs:read` 时搜索给出明确提示。
- [x] `pnpm pack` 的产物含入口与 `cordis.patch.yml`，不含 `src/`、`test/`，也没有源码已删除的陈旧 `dist` 产物。
- [x] README 安装地址里的版本与 `package.json` 一致；tag 与版本不一致时发布流程直接失败。

## 8. 决策记录
<!-- src: none -->

- 2026-11-14：仓库骨架与 CI 方案落地。
- 2026-11-15：文档块级 `src` 映射落地。
- 2026-11-20：产品形态改为 DSH 插件（见 DESIGN.md）。早期方案中的 MCP server、CLI 产品面、全量同步与本地索引不再在范围内，相关 CI 条目随之移除。
- 2026-11-20：分发先走 tarball、真实冒烟通过后再发 npm 公共包；`build` 前置清空 `dist`，`pack:check` 进 CI。
- 2026-11-20：接入方式改为「首次使用自动注册个人应用 + 设备流授权」，自建应用降级为可选覆盖；搜索因需管理员审批而列为可选能力，验收项随之调整。
- 2026-11-20：许可证由 MIT 改为 AGPL-3.0-only；发版交给 `release.yml`（tag 触发），并加 README 版本一致性检查、job 超时与 `engine-strict`。
- 2026-11-24：CI 矩阵加入 macOS（`macos-latest`），此前只有 ubuntu + windows。理由：仓库此前按 Windows 主开发、Linux 验证，macOS 从未进过门禁，而插件没有任何 Windows-only 运行时代码；POSIX 权限位（凭据 0600）与大小写/CRLF 差异需要 macOS 上的实际执行来兜底。同时在单测里补 POSIX 权限断言（Windows 跳过），让该 job 有判别力。
