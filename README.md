# feishu-aide

DSH 插件：把飞书文档、wiki 与会话消息接进 agent 会话。读、改、写回都在对话里完成，不需要打开飞书客户端，也没有独立的客户端界面。

当前版本 0.2.3。已实现授权、文档与 wiki 读取、文档搜索、联系人搜索、会话消息读取与块级写回；读文档按版本缓存。

## 它能做什么

<!-- src: none -->

- **读文档**：docx 与 wiki 链接都能直接读，返回块结构、版本号与 Markdown。
- **改内容**：替换文本块、在指定块下插入、新建文档；写前校验版本，重试不会重复写入。
- **找文档**：按关键词搜文档与知识库。需要管理员审批 `search:docs:read`，没有该权限时工具会明确说明，其余功能不受影响。
- **找人**：按名字搜联系人，返回 open_id、部门与单聊会话 id。
- **读消息**：按会话与时间区间读群聊、单聊历史，返回发送人、时间与可读文本。

## 安装

<!-- src: none -->

前置：DSH 0.2.1 线路（插件对宿主声明了 peer 依赖，版本不符会被插件管理器拒绝）。

```sh
dsh plugin --profile desktop add \
  https://github.com/weunimix/feishu-aide/releases/download/v0.2.3/feishu-aide-0.2.3.tgz \
  --allow-build=protobufjs
```

`--allow-build=protobufjs` 是必须的：`@larksuiteoapi/node-sdk` 的传递依赖带一个 postinstall，pnpm 默认拦下它并让安装失败。也可以在 DSH 插件页里安装同一个 tarball 地址，页面会提示「允许这些脚本并重试」。

Release 里同时提供 `.sha256`，需要核对产物时可以 `sha256sum -c feishu-aide-0.2.3.tgz.sha256`。

安装后重启 DSH，插件在宿主进程内加载，不需要常驻进程或本地服务。

## 授权

<!-- src: none -->

首次使用调用两次 `feishu_auth_login`：

1. 第一次返回创建应用的确认地址，在飞书页面上确认后，插件自动注册一个个人应用，凭据存到本地；
2. 第二次返回授权地址与用户码，确认后得到你本人身份的用户令牌。

全程不需要进入开放平台，也不需要租户管理员权限。凭据与缓存都在 `$DSH_HOME/feishu-aide/` 下：`app.json` 是应用凭据，`tokens.json` 是用户令牌，权限均为 0600。

组织已有自建应用时，可以把配置改成 `auth.mode: self-hosted` 并填写该应用的 App ID / App Secret。

## 使用

<!-- src: none -->

直接用自然语言提要求，agent 会选相应的工具：

- 「读一下这个文档：https://xxx.feishu.cn/docx/xxxx」
- 「把第三段改成……」
- 「在文档末尾加一节……」
- 「按『周报』搜一下文档」
- 「帮我看看张三最后给我发的消息」

写回默认先给变更计划，确认后才执行；这个行为由 `write.confirm` 控制。

## 工具

<!-- src: src/plugin.ts -->

| 工具 | 用途 | 备注 |
|---|---|---|
| `feishu_auth_status` | 查询授权状态、过期时间与已授予的 scope | |
| `feishu_auth_login` | 推进一步授权 | 首次使用调用两次 |
| `feishu_auth_logout` | 撤销授权，清空本地令牌与缓存 | 保留应用凭据 |
| `feishu_doc_read` | 读 docx 文档或 wiki 节点 | 返回块、版本、Markdown |
| `feishu_doc_write` | 按块写回或新建文档 | 校验 `baseRevision`，带幂等键 |
| `feishu_doc_search` | 按关键词搜文档与知识库 | 需要 `search:docs:read` |
| `feishu_contact_search` | 按名字搜联系人 | 返回 open_id 与单聊 `chat_id` |
| `feishu_chat_messages` | 读会话历史消息 | 支持时间区间与翻页 |

## 配置

<!-- src: src/core/config.ts -->

配置由宿主在装配插件时传入，全部有默认值，缺省即可用。

| 键 | 默认值 | 说明 |
|---|---|---|
| `auth.mode` | `auto` | `auto` 自动注册个人应用；`self-hosted` 使用组织自建应用 |
| `auth.domain` | `feishu` | `feishu` 或 `lark` |
| `auth.appId` / `auth.appSecret` | 空 | 仅 `self-hosted` 需要 |
| `storage.dir` | 空 | 凭据与缓存目录，空则用 `$DSH_HOME/feishu-aide` |
| `read.maxBlocks` | `500` | 单次返回的块数上限 |
| `read.maxBytes` | `262144` | 单次返回的字节上限 |
| `read.cacheTtlSeconds` | `600` | 缓存有效期，`0` 表示不使用缓存 |
| `write.enabled` | `true` | 关闭后写工具只返回禁用原因，不发请求 |
| `write.operations` | 三种操作全开 | 允许的写操作：`replace_text`、`insert_text`、`create_document` |
| `write.confirm` | `diff` | `diff` 先出计划、`always` 每次确认、`never` 直接执行 |
| `write.requireRevisionMatch` | `true` | 版本不一致时拒绝写回 |

完整说明见 [设计文档](docs/DESIGN.md)。

## 权限

<!-- src: src/core/auth.ts -->

默认申请：

- 文档与 wiki：`docx:document`、`docx:document:readonly`、`wiki:wiki`、`wiki:wiki:readonly`
- 消息：`im:message:readonly`，以及按会话读单聊、群聊所需的 `im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`
- 通讯录：`contact:user:search`（按名字搜联系人）
- `offline_access`（令牌刷新）

可选：`search:docs:read` 需要企业管理员审批，调用 `feishu_auth_login` 时显式传入才会申请。授权里没有它时，`feishu_doc_search` 返回明确提示，其他工具不受影响。

token 与应用密钥不会出现在工具返回值和日志里，授权类工具只返回状态与下一步的确认地址。

## 开发

<!-- src: scripts/check-secrets.mjs, scripts/prune-merged-branches.mjs, scripts/check-docs.mjs, scripts/doc-impact.mjs, scripts/check-release-version.mjs, .github/workflows/ci.yml, .github/workflows/release.yml, .github/workflows/branch-cleanup.yml, .github/dependabot.yml -->

需要 Node 24 + pnpm 10：

```sh
pnpm install
pnpm check         # secret scan + 文档块映射 + typecheck + 单测 + 策略测试
pnpm build
pnpm pack:check    # 校验 pnpm pack 的产物内容
pnpm release:check # 校验 README 安装地址里的版本与 package.json 一致
```

改 `src/**` 前先查影响哪些文档块：

```sh
pnpm docs:impact src/core/auth.ts
```

CI 在 ubuntu 与 windows 双 OS 上跑同一套检查，不读取任何飞书凭证；workflow 里的 action 固定到完整 commit SHA，由 Dependabot 维护。已合并分支由 `branch-cleanup.yml` 清理，默认 dry run。

发版：改完 `package.json` 的版本并同步 README 的安装地址，推 `vX.Y.Z` tag 即可，`release.yml` 会在该 tag 上重新构建、打包、附 SHA-256 并创建 Release。

## 文档

<!-- src: none -->

- [设计](docs/DESIGN.md)：产品形态、数据事实源、工具面、写回语义与配置的完整说明。
- [CI 与工程约束](docs/CI-REUSE-PLAN.md)：哪些约束可复用、飞书场景测什么、按什么顺序落地。
- [仓库设置基线](docs/repo-settings.md)：分支规则、合并方式、Actions allowlist 等不在 git 里的设置与核对命令。
- [CONTRIBUTING.md](CONTRIBUTING.md)：提交规范与文档块的 `src` 标注约定。

## 许可

<!-- src: none -->

AGPL-3.0-only © 2026 weunimix。见 [LICENSE](LICENSE)。

可以自由使用与修改；如果把修改后的版本分发出去，或把它作为网络服务提供给别人用，必须公开对应的源码。
