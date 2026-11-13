# feishu-aide

为 [mmw-tools](https://github.com/mmw-devs/mmw-tools) / DeepSeek Harness agent 提供飞书文档与知识库访问的工具项目：联网读取飞书文档、wiki 知识库内容，增量缓存到本地，并提供检索/读取能力，帮助 agent 定位用户需要的信息。

Status: initial scaffold (2026-11-14) — 仓库刚创建，只有工程骨架与方案；业务代码和 CI 尚未落地。

## 目标能力（尚未实现）

- 连接飞书开放平台，读取 wiki 空间、节点与 docx 文档内容；
- 增量同步到本地缓存，处理分页、限流、删除、权限与路径安全；
- 本地索引与检索（先关键词，语义检索后置）；
- 以 MCP server / CLI 形式提供给 agent 调用。

## 文档

- [CI 与仓库工程设计复用方案](docs/CI-REUSE-PLAN.md) — 哪些 CI / 工程约束可复用、飞书场景新增哪些测试、按什么顺序落地。

## 许可

MIT © 2026 mmw-devs。见 [LICENSE](LICENSE)。
