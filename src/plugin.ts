import os from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { AuthManager } from "./core/auth.js";
import { resolveConfig, type FeishuAideConfig } from "./core/config.js";
import { FileDocumentCache } from "./core/cache.js";
import { OFFICIAL_ENDPOINTS } from "./core/device-flow.js";
import { FileAppCredentialStore } from "./core/app-credentials.js";
import { extractDocRef, readDocumentCached } from "./core/docx.js";
import { listChatMessages } from "./core/messages.js";
import { createSdkMessageReader } from "./core/sdk-messages.js";
import { createSdkReader } from "./core/sdk-reader.js";
import { createSdkSearcher } from "./core/sdk-searcher.js";
import { createSdkWriter } from "./core/sdk-writer.js";
import { searchDocuments } from "./core/search.js";
import { FileTokenStore } from "./core/token-store.js";
import { resolveDocumentId } from "./core/wiki.js";
import { runWrite } from "./core/write.js";

export const name = "feishu-aide";
export const inject = ["tools"];

/** 搜索走的是 Search v2 接口，需要独立权限；组织通常要管理员审批。 */
const SEARCH_SCOPE = "search:docs:read";

function resolveStorageDir(config: FeishuAideConfig): string {
  if (config.storage.dir) return config.storage.dir;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "feishu-aide");
}

function hasScope(scope: string | undefined, wanted: string): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(wanted);
}

export function apply(ctx: Context, input?: unknown): void {
  const config = resolveConfig(input);
  const storageDir = resolveStorageDir(config);
  const store = new FileTokenStore(storageDir);
  const appCredentials = new FileAppCredentialStore(storageDir);
  const documentCache = new FileDocumentCache(path.join(storageDir, "cache"));
  // 启动时先扫一遍：过期条目没有事件可依赖，只能靠这种必然发生的时机兜底。
  const cacheTtlMs = Math.max(0, config.read.cacheTtlSeconds) * 1000;
  void documentCache.prune(cacheTtlMs).catch(() => undefined);

  // 懒构造：查授权状态不需要应用凭据，真正联网的工具在调用前各自校验。
  let manager: AuthManager | null = null;
  const auth = (): AuthManager =>
    (manager ??= new AuthManager({
      domain: config.auth.domain,
      endpoints: OFFICIAL_ENDPOINTS[config.auth.domain],
      mode: config.auth.mode,
      configCredentials: { appId: config.auth.appId, appSecret: config.auth.appSecret },
      credentials: appCredentials,
      tokens: store,
    }));

  const reader = async () =>
    createSdkReader({
      ...(await auth().getAppCredentials()),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  const writer = async () =>
    createSdkWriter({
      ...(await auth().getAppCredentials()),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  const searcher = async () =>
    createSdkSearcher({
      ...(await auth().getAppCredentials()),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  const messages = async () =>
    createSdkMessageReader({
      ...(await auth().getAppCredentials()),
      domain: config.auth.domain,
      userAccessToken: () => auth().getAccessToken(),
    });

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_status",
      description: "查看飞书授权状态：是否已授权、访问令牌过期时间、已授予的 scope，以及是否还有待确认的步骤。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            authorized: { type: "boolean", required: true },
            expiresAt: { type: "number" },
            scope: { type: "string" },
            pending: { type: "string", description: "register | authorize：还有一步等用户确认" },
            domain: { type: "string", required: true },
          },
        },
        render: (_args, value) => {
          if (value.authorized) {
            return [
              {
                type: "text",
                text: `已授权（${value.domain}），令牌将于 ${new Date(value.expiresAt ?? 0).toLocaleString()} 过期`,
              },
            ];
          }
          if (value.pending === "register") {
            return [{ type: "text", text: "应用还在创建中：用户确认后再次调用 feishu_auth_login 继续" }];
          }
          if (value.pending === "authorize") {
            return [{ type: "text", text: "应用已创建，等待用户授权：再次调用 feishu_auth_login 继续" }];
          }
          return [{ type: "text", text: "未授权：调用 feishu_auth_login 开始" }];
        },
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
      description:
        "推进飞书接入：第一次调用创建应用（用户确认一次），之后调用发起用户授权或查询是否完成。按返回的地址操作后再次调用本工具即可。",
      parameters: {
        scope: { type: "string", description: "可选，空格分隔的权限范围，例如 docx:document wiki:wiki" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            stage: { type: "string", required: true, description: "register | authorize | authorized" },
            userCode: { type: "string" },
            verificationUri: { type: "string" },
            expiresIn: { type: "number" },
            scope: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.stage === "authorized") {
            return [{ type: "text", text: "已完成授权，可以开始读取飞书内容" }];
          }
          const minutes = Math.round((value.expiresIn ?? 0) / 60);
          if (value.stage === "register") {
            return [
              {
                type: "text",
                text: `第一步：请打开 ${value.verificationUri} 确认创建应用（用户码 ${value.userCode}，约 ${minutes} 分钟内有效），完成后再次调用 feishu_auth_login`,
              },
            ];
          }
          return [
            {
              type: "text",
              text: `第二步：请打开 ${value.verificationUri} 完成账号授权（用户码 ${value.userCode}，约 ${minutes} 分钟内有效），完成后再次调用 feishu_auth_login`,
            },
          ];
        },
      },
      async execute(args) {
        const result = await auth().login(args.scope);
        if (result.stage === "authorized") await documentCache.clear();
        return result;
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_logout",
      description: "撤销飞书授权：清掉本地保存的令牌与文档缓存，下次使用需要重新授权。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            authorized: { type: "boolean", required: true },
          },
        },
        render: () => [{ type: "text", text: "已撤销授权，并清空本地令牌与文档缓存" }],
      },
      async execute() {
        if (manager) await manager.logout();
        else await store.clear();
        await documentCache.clear();
        return { authorized: false };
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
            fromCache: { type: "boolean", description: "本次是否直接命中缓存" },
          },
        },
        render: (_args, value) => [
          { type: "text", text: value.fromCache ? `（缓存命中，版本 ${value.revisionId}）\n${value.markdown}` : value.markdown },
        ],
      },
      async execute(args) {
        const ref = extractDocRef(args.ref);
        const sdkReader = await reader();
        const documentId = await resolveDocumentId(sdkReader, ref);

        return readDocumentCached(
          sdkReader,
          documentId,
          {
            maxBlocks: args.maxBlocks ?? config.read.maxBlocks,
            maxBytes: config.read.maxBytes,
          },
          { cache: documentCache, ttlSeconds: config.read.cacheTtlSeconds }
        );
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
        const status = await auth().status();
        if (!hasScope(status.scope, SEARCH_SCOPE)) {
          throw new Error(
            "当前授权不含 search:docs:read，无法搜索文档。该权限需要企业管理员在应用上审批；" +
              "已知文档的链接仍可直接用 feishu_doc_read 读取。"
          );
        }
        const sdkSearcher = await searcher();
        return searchDocuments(sdkSearcher, {
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
      name: "feishu_chat_messages",
      description:
        "读取一个会话（群聊或单聊）在时间区间内的历史消息，按时间正序返回发送人、时间与可读文本。会话 id 是 oc_ 开头的 chat_id。",
      parameters: {
        chatId: { type: "string", required: true, description: "会话 id（oc_ 开头的 chat_id）" },
        startTime: { type: "string", description: "起始时间，ISO 格式或秒级时间戳；缺省不限" },
        endTime: { type: "string", description: "结束时间，ISO 格式或秒级时间戳；缺省不限" },
        limit: { type: "number", description: "返回条数，1 到 50，缺省 20" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            messages: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  messageId: { type: "string", required: true },
                  type: { type: "string", required: true },
                  text: { type: "string", required: true },
                  senderName: { type: "string" },
                  senderId: { type: "string" },
                  sentAt: { type: "number", required: true },
                },
              },
            },
            hasMore: { type: "boolean", required: true },
            pageToken: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.messages.length === 0) {
            return [{ type: "text", text: "该时间区间内没有消息" }];
          }
          const lines = value.messages.map((message) => {
            const time = new Date(message.sentAt).toLocaleString();
            const who = message.senderName ?? message.senderId ?? "未知发送人";
            return `[${time}] ${who}: ${message.text}`;
          });
          if (value.hasMore) lines.push("还有更多消息，可以收窄时间区间或调大 limit");
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args) {
        const sdkMessages = await messages();
        return listChatMessages(sdkMessages, {
          chatId: args.chatId,
          ...(args.startTime === undefined ? {} : { startTime: args.startTime }),
          ...(args.endTime === undefined ? {} : { endTime: args.endTime }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
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
        const sdkReader = await reader();
        const documentId = ref ? await resolveDocumentId(sdkReader, ref) : null;

        return runWrite(
          {
            reader: sdkReader,
            writer: await writer(),
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
