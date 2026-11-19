# feishu-aide 设计

Status: MVP 设计（2026-11-20）。本文是产品形态、数据事实源与写回语义的唯一说明；CI 工程方案见 [CI-REUSE-PLAN.md](CI-REUSE-PLAN.md)。

## 1. 定位与 MVP 范围
<!-- src: none -->

feishu-aide 是一个 DSH 插件：让用户在 **DSH 会话里**读飞书文档、wiki 与消息，并让 agent 对内容做润色、修改后**写回飞书**。用户不离开会话，也不需要打开飞书客户端。

MVP 范围：

- 读：docx 文档与 wiki 节点（wiki 链接解析到背后的文档）、会话历史消息；
- 写：已有文档的块级修改、插入与新建文档；
- 认证：设备流 OAuth，用户身份授权，token 由插件保存并刷新；
- 缓存：按需拉取，按版本缓存，不做本地全量同步与索引。

非目标（本阶段不做，也不为它们预留结构）：

- 客户端 UI：不提供侧边栏、面板或独立的文档浏览界面，交互全部通过对话完成；
- MCP server、独立 CLI 产品面、常驻进程；
- 表格、多维表格、审批、日历等非文档对象；
- 团队共享缓存、跨设备同步。

## 2. 形态选择
<!-- src: src/plugin.ts, src/index.ts -->

候选形态有三种：宿主插件、沙箱外的 broker + 沙箱内 CLI、纯沙箱内 CLI。选择插件的理由不是"更简单"，而是它的事实源结构最干净：

| 形态 | 运行时 | 状态存放 | 写者数量 |
|---|---|---|---|
| 宿主插件 | 一个（宿主进程） | 插件存储目录 | 一 |
| broker + CLI | 两个（守护进程与 CLI） | 两处（AppData 与工作区） | 二 |
| 纯沙箱 CLI | 一个 | 工作区 | 一 |

后两者都需要自己重建"谁说了算"：broker 方案要把策略、凭据与缓存各指定一个所有者，并用协议在两个进程间同步；纯沙箱 CLI 方案则受限于沙箱对凭据落盘的约束。插件形态下，一个运行时、一个存储目录、一个工具面，是平台直接提供的，不需要我们维护。

另一个不可回避的事实：沙箱约束的是 agent 的 shell 执行路径，插件工具在宿主进程内执行，不经过该路径。两条路径的边界由平台划分，插件不去改变它，也不把业务逻辑分散到两侧。

## 3. 数据域与事实源
<!-- src: src/core/docx.ts, src/core/wiki.ts, src/core/auth.ts, src/core/device-flow.ts, src/core/token-store.ts, src/core/cache.ts -->

| 数据域 | 事实源 | 插件的角色 | 规则 |
|---|---|---|---|
| 文档内容与块 | 飞书，按 `revision_id` 版本化 | 缓存与视图 | 缓存键是 `(document_id, revision_id, 读取预算)`，不能用文档 id 单独做键 |
| 消息 | 飞书时间轴，按 `message_id` | 缓存 | 按时间区间拉取，不维护"最新消息"游标 |
| wiki 树 | 飞书 wiki | 透传 | 不落地持久树 |
| 凭据 | 飞书 OAuth，根是 refresh token | 持有并刷新 | 只存一份，在插件存储目录的 `tokens.json`；不进配置 |
| 配置 | 宿主传入的插件配置 | 只读 | 装配时解析一次快照，不在多处解析 |
| 工具集 | 插件源码 | 唯一声明处 | 不另维护工具清单文档 |
| 缓存 | 插件存储目录下的文件 | 可丢弃 | 按 TTL 过期，条目数上限 200、超限淘汰最旧；启动、写缓存与登出触发清扫并回收残留临时文件；不做全量镜像 |

四条不变量：

1. **单一写者**：只有插件的存储模块写磁盘（`tokens.json` 与缓存目录）；工具之间不直接互写状态。
2. **派生可丢**：缓存、Markdown 渲染、搜索片段都可以整块删除后重建。
3. **引用闭合**：跨步骤引用一律写成 `(document_id, revision_id, block_id)`；写回必须以块为单位，不以文本偏移为单位。
4. **身份唯一**：文档读写只用 user token，禁止静默回落到 tenant token。身份漂移比报错更难排查。

Markdown 只是视图，块结构才是内容。读工具返回块与 Markdown，写工具只接受块级操作。

## 4. 维护性
<!-- src: src/core/sdk-reader.ts, src/core/sdk-searcher.ts, src/core/sdk-messages.ts, src/core/sdk-writer.ts, src/core/sdk-logger.ts, src/core/feishu-json.ts, src/core/retry.ts, src/core/search.ts, src/core/messages.ts, src/core/markdown.ts, src/plugin.ts -->

依赖面刻意收窄到平台两个 API：`ctx.tools.register`（工具注册）与壳层传入的配置（`resolveConfig`）。不依赖客户端包，不依赖插件管理器内部结构，不依赖 `ctx.agents` 的内部字段。

外部依赖有两个：飞书官方 SDK（`@larksuiteoapi/node-sdk`）与配置 schema 库（`@deepseek-ai/schemastery`，DSH 插件生态通用）。不引入 MCP SDK、不引入文档转换库；块到 Markdown 的渲染由本项目实现，因为它是视图，需要完全可控的降级行为。

SDK 自身的日志关掉：它记录错误时会带上请求与响应体，正文不能进日志，所以适配层传入一个不接收任何消息的 logger（`LoggerLevel.fatal` 不够——该枚举的 fatal 是 0，SDK 用 `||` 取默认值时会当成没传而落到 info）。错误由适配层上抛，最终只经过工具结果。

| 失效模式 | 后果 | 对策 |
|---|---|---|
| 网络超时、限流 | 工具挂起或失败 | 429、503 与业务码 99991400 按 `Retry-After` 退避，缺失时指数退避并封顶 10s，最多 3 次；其余 4xx 不重试 |
| 分页漏页或死循环 | 内容不完整 | 游标单测覆盖空页、重复游标、边界页大小 |
| 未知块类型 | 渲染失败 | 降级为纯文本，不抛错 |
| token 过期 | 调用失败 | 刷新用比较并交换，避免并发覆盖；失败时返回可操作的错误 |
| 写回冲突 | 覆盖他人修改 | 写前校验 `revision_id`，不匹配则拒绝 |
| 重试重复写入 | 重复块 | 写操作携带幂等键，重试不产生新块 |
| 工具输出过大 | 挤占上下文 | 分页返回，单次返回有字节上限 |

测试策略：业务测试全部离线。飞书端点用注入 base URL 的 fake server 或录制后脱敏的 fixture 回放；纯函数（参数校验、块渲染、写回计划）直接单测。真实租户只用于单独的手动或定时验证，不进入 PR。

## 5. 工具面
<!-- src: src/plugin.ts -->

工具是插件唯一的产品面。命名用飞书自身的词汇，不造新词。

| 工具 | 用途 | 读/写 | 状态 |
|---|---|---|---|
| `feishu_auth_status` | 查询授权状态、过期时间、已授予的 scope | 读 | 已实现 |
| `feishu_auth_login` | 发起设备流授权，返回验证地址与用户码 | 写（本地凭据） | 已实现 |
| `feishu_auth_logout` | 撤销授权，清空本地令牌与文档缓存 | 写（本地凭据） | 已实现 |
| `feishu_doc_read` | 读 docx 文档与 wiki 节点，返回块、版本与 Markdown | 读 | 已实现 |
| `feishu_doc_write` | 按块级操作写回或新建文档 | 写 | 已实现 |
| `feishu_doc_search` | 按关键词搜索文档与 wiki | 读 | 已实现 |
| `feishu_chat_messages` | 按会话与时间区间读消息 | 读 | 已实现 |

读工具返回结构固定包含 `document_id`、`revision_id`、`title`、`blocks`（含 `block_id`）、`markdown`、`truncated`，命中缓存时另带 `fromCache`。写工具接受 `ref`（文档 URL 或 token，新建文档时可省）、`baseRevision`、`ops` 与 `apply`；每个操作用 `op` 指明种类，其余字段随操作而定。

授权类工具只返回状态，不返回 token 值。

## 6. 写回语义
<!-- src: src/core/write.ts, src/core/write-plan.ts, src/core/sdk-writer.ts -->

写回分三步：读时记录版本与块、生成变更计划、校验后执行。

- **身份**：只用 user token。写回的作者必须是用户本人。
- **版本**：`baseRevision` 与当前版本不一致时拒绝执行，返回当前版本与重新读取的建议，不静默覆盖。
- **粒度**：以块为单位。当前实现支持替换文本块、在指定父块下插入文本块、新建文档；删除块与整篇文本覆盖都不支持。
- **范围**：允许的操作种类由配置 `write.operations` 收窄；未列出的操作直接拒绝（`op_not_allowed`），不会降级成别的操作。
- **幂等**：每次写操作带按内容计算的客户端幂等键；重试同一请求不会重复插入块。
- **确认**：由配置决定。`diff` 先返回变更计划等确认；`always` 每次写都要确认；`never` 直接执行，仅靠版本校验兜底。
- **失败**：部分成功必须如实报告哪些操作已写入，不谎报整体成功。

## 7. 配置
<!-- src: src/core/config.ts -->

配置由宿主在装配插件时传入，带默认值，缺省即可用。

```yaml
feishuAide:
  auth:
    domain: feishu          # feishu | lark
    appId: ""               # 自建应用的 App ID
    appSecret: ""           # 自建应用的 App Secret，secret 字段
  storage:
    dir: ""                 # 凭据与状态目录；空则用 $DSH_HOME/feishu-aide
  read:
    maxBlocks: 500          # 单次返回的块数上限
    maxBytes: 262144        # 单次返回的字节上限
    cacheTtlSeconds: 600    # 非写回路径的缓存有效期；0 表示不使用缓存
  write:
    enabled: true
    operations: [replace_text, insert_text, create_document]   # 允许的写操作种类
    confirm: diff           # diff | always | never
    requireRevisionMatch: true
```

设备流授权要求用户自建飞书应用（并在应用后台开通所需权限），插件不内置任何应用凭据。未配置时工具返回可操作提示，宿主启动不受影响。

`write.enabled=false` 时写工具直接返回禁用原因，不发起任何飞书请求。

## 8. 验收
<!-- src: none -->

MVP 完成的判据：

- 未配置时，所有工具给出可操作提示，不崩溃；
- 能完成"授权 → 读文档 → 修改一个块 → 回读确认"的完整链路；
- 版本不匹配时拒绝写回，并给出当前版本；
- 同一写请求重试两次，文档只变化一次；
- 离线测试覆盖分页、限流、未知块类型、token 过期、写回冲突；
- 工具输出与日志中不出现 token 值。

## 9. 决策记录
<!-- src: none -->

- 2026-11-20：形态定为 DSH 插件；MVP 不做客户端 UI；文档读写只用 user token；按需缓存；写回范围与确认方式可配置。
- 2026-11-20：配置由宿主装配时传入；凭据存插件存储目录的 `tokens.json`，不入配置，也不依赖 settings 服务的动态秘密能力。
- 同日作废：core library + stdio MCP server 的分发形态、`tenant_access_token` 首选、独立 CLI 产品面。以上来自本仓库早期方案，不再适用。
