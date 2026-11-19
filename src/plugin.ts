import os from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { AuthManager } from "./core/auth.js";
import { resolveConfig, type FeishuAideConfig } from "./core/config.js";
import { OFFICIAL_ENDPOINTS, type DeviceFlowEnv } from "./core/device-flow.js";
import { extractDocRef, readDocument } from "./core/docx.js";
import { createSdkReader } from "./core/sdk-reader.js";
import { createSdkSearcher } from "./core/sdk-searcher.js";
import { createSdkWriter } from "./core/sdk-writer.js";
import { searchDocuments } from "./core/search.js";
import { FileTokenStore } from "./core/token-store.js";
import { resolveDocumentId } from "./core/wiki.js";
import { runWrite } from "./core/write.js";

export const name = "feishu-aide";
export const inject = ["tools"];

function resolveStorageDir(config: FeishuAideConfig): string {
  if (config.storage.dir) return config.storage.dir;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "feishu-aide");
}

function requireAppCredentials(config: FeishuAideConfig): { appId: string; appSecret: string } {
  const { appId, appSecret } = config.auth;
  if (!appId || !appSecret) {
    throw new Error(
      "未配置飞书自建应用：请在插件配置里填写 auth.appId 与 auth.appSecret（自建应用的 App ID / App Secret）"
    );
  }
  return { appId, appSecret };
}

export function apply(ctx: Context, input?: unknown): void {
  const config = resolveConfig(input);
  const store = new FileTokenStore(resolveStorageDir(config));

  const env = (): DeviceFlowEnv => ({
    ...requireAppCredentials(config),
    endpoints: OFFICIAL_ENDPOINTS[config.auth.domain],
  });

  // 懒构造：没配应用凭据时只有真正调用工具才报错，不影响宿主启动。
  let manager: AuthManager | null = null;
  const auth = (): AuthManager => (manager ??= new AuthManager(env(), store));

  const reader = () =>
    createSdkReader({
      ...requireAppCredentials(config),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  const writer = () =>
    createSdkWriter({
      ...requireAppCredentials(config),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  const searcher = () =>
    createSdkSearcher({
      ...requireAppCredentials(config),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_status",
      description: "查看飞书授权状态：是否已授权、访问令牌过期时间与授权范围。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            authorized: { type: "boolean", required: true },
            expiresAt: { type: "number" },
            scope: { type: "string" },
            domain: { type: "string", required: true },
          },
        },
        render: (_args, value) =>
          value.authorized
            ? [
                {
                  type: "text",
                  text: `已授权（${value.domain}），令牌将于 ${new Date(value.expiresAt ?? 0).toLocaleString()} 过期`,
                },
              ]
            : [{ type: "text", text: "未授权：调用 feishu_auth_login 发起设备授权" }],
      },
      async execute() {
        const status = await auth().status();
        return { ...status, domain: config.auth.domain };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_login",
      description: "发起飞书设备授权：返回用户码与验证地址，用户在浏览器完成授权后插件在后台保存令牌。",
      parameters: {
        scope: { type: "string", description: "可选，空格分隔的权限范围，例如 docx:document wiki:wiki" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            userCode: { type: "string", required: true },
            verificationUri: { type: "string", required: true },
            expiresIn: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `请在浏览器打开 ${value.verificationUri} 并输入用户码 ${value.userCode}（约 ${Math.round(
              value.expiresIn / 60
            )} 分钟内有效）`,
          },
        ],
      },
      async execute(args) {
        const current = auth();
        const challenge = await current.startLogin(args.scope);
        void current.completeLogin(challenge).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`飞书设备授权未完成：${message}`);
        });
        return {
          status: "pending",
          userCode: challenge.userCode,
          verificationUri: challenge.verificationUri,
          expiresIn: challenge.expiresIn,
        };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_doc_read",
      description: "读取一篇飞书文档（docx 或 wiki 链接、document_id），返回标题、版本号、块列表与渲染后的 Markdown。",
      parameters: {
        ref: { type: "string", required: true, description: "文档 URL 或 token" },
        maxBlocks: { type: "number", description: "本次最多读取的块数，缺省取插件配置" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            documentId: { type: "string", required: true },
            revisionId: { type: "string", required: true },
            title: { type: "string", required: true },
            markdown: { type: "string", required: true },
            blocks: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  block_id: { type: "string", required: true },
                  block_type: { type: "number", required: true },
                  text: { type: "string", required: true },
                },
              },
            },
            truncated: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.markdown }],
      },
      async execute(args) {
        const ref = extractDocRef(args.ref);
        const sdkReader = reader();
        const documentId = await resolveDocumentId(sdkReader, ref);

        return readDocument(sdkReader, documentId, {
          maxBlocks: args.maxBlocks ?? config.read.maxBlocks,
          maxBytes: config.read.maxBytes,
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_doc_search",
      description:
        "按关键词搜索当前用户可见的飞书云文档与知识库，返回标题、链接、类型与摘要。拿到链接后可以直接交给 feishu_doc_read。",
      parameters: {
        query: { type: "string", required: true, description: "搜索词" },
        limit: { type: "number", description: "返回条数，1 到 50，缺省 10" },
        onlyTitle: { type: "boolean", description: "只按标题匹配" },
        docTypes: {
          type: "array",
          items: { type: "string" },
          description: "限定类型，例如 DOCX、WIKI、SHEET；缺省不限",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            hits: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string", required: true },
                  url: { type: "string" },
                  token: { type: "string" },
                  type: { type: "string" },
                  summary: { type: "string" },
                  updateTime: { type: "number" },
                  owner: { type: "string" },
                },
              },
            },
            total: { type: "number" },
            hasMore: { type: "boolean", required: true },
            pageToken: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.hits.length === 0) {
            return [{ type: "text", text: "没有匹配的文档" }];
          }
          const lines = value.hits.map((hit, index) => {
            const meta = [hit.type, hit.owner].filter((item): item is string => typeof item === "string" && item.length > 0);
            const head = `${index + 1}. ${hit.title}${meta.length > 0 ? `（${meta.join(" · ")}）` : ""}`;
            const tail = [hit.url ?? (hit.token === undefined ? "" : `token: ${hit.token}`), hit.summary ?? ""]
              .filter((item) => item.length > 0)
              .join("\n   ");
            return tail.length > 0 ? `${head}\n   ${tail}` : head;
          });
          if (value.hasMore) lines.push("还有更多结果，可以收窄关键词或调大 limit");
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args) {
        return searchDocuments(searcher(), {
          query: args.query,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.onlyTitle === undefined ? {} : { onlyTitle: args.onlyTitle }),
          ...(args.docTypes === undefined ? {} : { docTypes: args.docTypes }),
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_doc_write",
      description:
        "把块级修改写回飞书文档：替换文本块、在指定块之后插入文本块、或新建一篇文档。默认只返回计划，需要再次调用并带 apply=true 才会真正执行。",
      parameters: {
        ref: { type: "string", description: "文档 URL 或 token；新建文档时不需要" },
        baseRevision: { type: "string", description: "写入前读到的版本号，用于防止覆盖别人的修改" },
        ops: {
          type: "array",
          required: true,
          description:
            "操作列表。replace_text 需要 block_id 与 text；insert_text 需要 texts（可选 index、parent_block_id）；create_document 需要 title",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", required: true },
              block_id: { type: "string" },
              text: { type: "string" },
              texts: { type: "array", items: { type: "string" } },
              index: { type: "number" },
              parent_block_id: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        apply: { type: "boolean", description: "缺省为 false；确认计划无误后传 true 才真正写入" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            applied: { type: "boolean", required: true },
            documentId: { type: "string" },
            revisionId: { type: "string" },
            plan: { type: "array", required: true, items: { type: "string" } },
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { type: "string", required: true },
                  ok: { type: "boolean", required: true },
                  error: { type: "string" },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [...value.plan];
          if (value.applied) {
            lines.push(`已执行 ${value.results.filter((item) => item.ok).length}/${value.results.length} 个操作`);
            for (const result of value.results) {
              if (!result.ok) lines.push(`失败：${result.op} — ${result.error ?? "未知错误"}`);
            }
            if (value.revisionId) lines.push(`新版本：${value.revisionId}`);
          } else {
            lines.push("以上是待执行计划；确认后带 apply=true 再调用一次");
          }
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args) {
        const ref = args.ref ? extractDocRef(args.ref) : null;
        const sdkReader = reader();
        const documentId = ref ? await resolveDocumentId(sdkReader, ref) : null;

        return runWrite(
          {
            reader: sdkReader,
            writer: writer(),
            policy: config.write,
            limits: { maxBlocks: config.read.maxBlocks, maxBytes: config.read.maxBytes },
          },
          {
            documentId,
            ...(args.baseRevision === undefined ? {} : { baseRevision: args.baseRevision }),
            ops: args.ops,
            ...(args.apply === undefined ? {} : { apply: args.apply }),
          }
        );
      },
    })
  );
}
