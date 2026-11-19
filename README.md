# feishu-aide

DSH 插件：让用户在会话里读取飞书文档、wiki 与消息，并让 agent 对内容做润色或修改后写回飞书。交互全部通过对话完成，不提供独立的客户端界面。

Status: P2 (2026-11-20) — 设备流授权、docx/wiki 读取与块级写回已实现，含离线单测；文档与消息的搜索读取、fake server 集成测试尚未实现。形态与范围见 [设计](docs/DESIGN.md)，CI 与工程约束见 [CI 与工程约束](docs/CI-REUSE-PLAN.md)。

## 能力与进度

<!-- src: none -->
- 已实现：设备流 OAuth 授权（`feishu_auth_status` / `feishu_auth_login`），token 在本地保存并按需刷新；
- 已实现：读取 docx 文档与 wiki 节点（wiki 链接解析到背后的文档），返回块、版本与 Markdown（`feishu_doc_read`）；
- 已实现：替换文本块、插入文本块、新建文档，写前校验版本，操作带幂等键（`feishu_doc_write`）；
- 未实现：文档搜索、消息读取，以及按需缓存。

## 当前已落地

<!-- src: src/core/path-safety.ts, src/index.ts -->
<!-- src: scripts/check-secrets.mjs, scripts/prune-merged-branches.mjs -->
<!-- src: scripts/check-docs.mjs, scripts/doc-impact.mjs -->
<!-- src: .github/workflows/ci.yml, .github/workflows/branch-cleanup.yml, .github/dependabot.yml -->

- `.github/workflows/ci.yml`：ubuntu + windows 双 OS；secret scan、文档块检查、策略单测、typecheck、unit test、build；PR 不读取任何飞书凭证。
- `.github/workflows/branch-cleanup.yml` + `scripts/prune-merged-branches.mjs`：只删除证据齐全的已合并分支，默认 dry run。
- `scripts/check-secrets.mjs`：扫描飞书/GitHub/AWS 凭证形态，并拒绝 `.env`、私钥、本地 `.db` 被跟踪。
- 工作流里的 action 固定到完整 commit SHA（行尾注释版本），Dependabot 每周检查 pin；仓库的 `sha_pinning_required` 已打开，新 workflow 写 `@vN` 会直接失败。
- `scripts/check-docs.mjs` + `scripts/doc-impact.mjs`：校验文档块的 `src` 标注、引用有效性与 `src/` 覆盖率，生成并比对 `docs/doc-map.json`；支持反查“改某个文件影响哪些文档块”。
- `src/core/path-safety.ts`：不可信文档标题的路径清洗与根目录逃逸防护，含单测。

## 本地验证

<!-- src: none -->

需要 Node 24 + pnpm 10。

```sh
pnpm install
pnpm check   # secret scan + 文档块映射 + typecheck + unit + policy tests
pnpm build
```

查某次改动会影响哪些文档块（改 `src/**` 前先跑）：

```sh
pnpm docs:impact src/core/path-safety.ts
```

## 文档

<!-- src: none -->

- [设计](docs/DESIGN.md) — 产品形态、数据事实源、工具面、写回语义与配置。
- [CI 与工程约束](docs/CI-REUSE-PLAN.md) — 哪些工程约束可复用、飞书场景测什么、按什么顺序落地。
- [仓库设置基线](docs/repo-settings.md) — 分支规则、合并方式、Actions allowlist 等不在 git 里的设置，以及核对命令。
- 文档块的 `src` 标注与 `doc-map.json` 约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

<!-- src: none -->

MIT © 2026 mmw-devs。见 [LICENSE](LICENSE)。
