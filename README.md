# feishu-aide

DSH 插件：让用户在会话里读取飞书文档、wiki 与消息，并让 agent 对内容做润色或修改后写回飞书。交互全部通过对话完成，不提供独立的客户端界面。

Status: P2 (2026-11-20) — 首次使用自动创建应用、设备流授权、docx/wiki 读取、文档搜索、联系人搜索、消息读取与块级写回已实现，含离线单测与 fake server 集成测试；读文档按版本缓存。形态与范围见 [设计](docs/DESIGN.md)，CI 与工程约束见 [CI 与工程约束](docs/CI-REUSE-PLAN.md)。

## 能力与进度

<!-- src: none -->
- 已实现：首次使用时自动创建个人应用并完成设备流授权（`feishu_auth_status` / `feishu_auth_login` / `feishu_auth_logout`），用户只需在飞书页面上确认两次，token 在本地保存并按需刷新；
- 已实现：读取 docx 文档与 wiki 节点（wiki 链接解析到背后的文档），返回块、版本与 Markdown（`feishu_doc_read`）；
- 已实现：按关键词搜索文档与知识库，返回标题、链接、类型与摘要（`feishu_doc_search`）；该能力需要管理员审批 `search:docs:read`，缺失时工具会明确提示；
- 已实现：按会话与时间区间读取群聊、单聊的历史消息，返回发送人、时间与可读文本（`feishu_chat_messages`）；
- 已实现：按名字搜索联系人，返回 open_id、部门与单聊会话 id，拿到会话 id 就能读聊天记录（`feishu_contact_search`）；
- 已实现：替换文本块、插入文本块、新建文档，写前校验版本，操作带幂等键（`feishu_doc_write`）；
- 已实现：读文档按 `(文档, 版本, 读取预算)` 缓存块内容，版本变化自动失效，TTL 到期即丢。

## 安装

<!-- src: none -->

插件由 DSH 的插件管理器安装，不需要常驻进程或本地服务。当前分发形态是 `pnpm pack` 产出的 tarball，等真实飞书冒烟通过后再改为 npm 公共包：

```sh
pnpm pack   # 产出 feishu-aide-<version>.tgz，prepack 会先重新构建 dist
```

在 DSH 的插件页或 `dsh plugin` 命令里安装时，把 spec 指向这个 tarball 的绝对路径（`file:<路径>` 或直接给路径）。插件管理器的 `installBundle` 也接受 registry 包名与 git 地址，但本仓库目前只验证 tarball 这一条。

插件对宿主声明了两条 peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`），范围对齐 DSH 0.2.1 线路；插件管理器安装时会校验，版本不符会直接拒绝。升级 DSH 后若提示不兼容，需要同步更新这两条范围。

装好后直接调用 `feishu_auth_login`：它会先返回一个创建应用的确认地址，用户在飞书页面确认一次，插件随即自动注册个人应用并把凭据存在本地；紧接着再调用一次 `feishu_auth_login`，按提示完成用户授权，之后 `feishu_auth_status` 应显示已授权。全程不需要进入开放平台，也不需要租户管理员权限。

组织已有自建应用时，可以把配置改成 `auth.mode: self-hosted` 并填写该应用的 App ID / App Secret，设备流授权会改用这个应用。

安装时 pnpm 会拦下 `@larksuiteoapi/node-sdk` 的传递依赖 `protobufjs` 的 postinstall，插件管理器把它列为待批准的构建脚本：允许并重试即可完成安装，拒绝则安装以错误结束（该脚本不影响运行时）。

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
pnpm pack:check   # 校验 pnpm pack 的产物内容
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

MIT © 2026 weunimix。见 [LICENSE](LICENSE)。
