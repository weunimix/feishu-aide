# feishu-aide

为 [mmw-tools](https://github.com/mmw-devs/mmw-tools) / DeepSeek Harness agent 提供飞书文档与知识库访问的工具项目：联网读取飞书文档、wiki 知识库内容，增量缓存到本地，并提供检索/读取能力，帮助 agent 定位用户需要的信息。

Status: P1 (2026-11-14) — 仓库骨架、离线 CI、secret scan、分支清理、路径安全单测已落地；飞书客户端、同步和检索尚未实现。方案见 [CI 与仓库工程设计复用方案](docs/CI-REUSE-PLAN.md)。

## 目标能力（尚未实现）

- 连接飞书开放平台，读取 wiki 空间、节点与 docx 文档内容；
- 增量同步到本地缓存，处理分页、限流、删除、权限与路径安全；
- 本地索引与检索（先 SQLite FTS5，语义检索后置）；
- 以 core library + stdio MCP server 提供给 agent 调用，CLI 后加。

## 当前已落地

- `.github/workflows/ci.yml`：ubuntu + windows 双 OS；secret scan、策略单测、typecheck、unit test、build；PR 不读取任何飞书凭证。
- `.github/workflows/branch-cleanup.yml` + `scripts/prune-merged-branches.mjs`：只删除证据齐全的已合并分支，默认 dry run。
- `scripts/check-secrets.mjs`：扫描飞书/GitHub/AWS 凭证形态，并拒绝 `.env`、私钥、本地 `.db` 被跟踪。
- `src/core/path-safety.ts`：不可信文档标题的路径清洗与根目录逃逸防护，含单测。

## 本地验证

需要 Node 24 + pnpm 10。

```sh
pnpm install
pnpm check   # secret scan + typecheck + unit + policy tests
pnpm build
```

## 文档

- [CI 与仓库工程设计复用方案](docs/CI-REUSE-PLAN.md) — 哪些 CI / 工程约束可复用、飞书场景新增哪些测试、按什么顺序落地。

## 许可

MIT © 2026 mmw-devs。见 [LICENSE](LICENSE)。
