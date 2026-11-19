import * as lark from "@larksuiteoapi/node-sdk";
import type { BlockPage, DocReader, DocumentMeta, WikiNode } from "./docx.js";
import type { FeishuBlock } from "./markdown.js";
import type { Domain } from "./device-flow.js";
import { asRecord, unwrap } from "./feishu-json.js";
import { withRetry } from "./retry.js";
import { guardSdkCall } from "./sdk-error.js";
import { silentLogger } from "./sdk-logger.js";

/**
 * SDK 适配层。整个插件只有这里直接依赖 `@larksuiteoapi/node-sdk`，
 * 其余模块都面向 `DocReader` 这类小接口，因此可以离线测试。
 */

export interface ReaderOptions {
  appId: string;
  appSecret: string;
  domain: Domain;
  userAccessToken: () => Promise<string>;
  /** 测试注入用：把 SDK 指向本地 fake server。 */
  domainOverride?: string;
}

const PAGE_SIZE = 500;

export function createSdkReader(options: ReaderOptions): DocReader {
  const client = new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domainOverride ?? (options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu),
    logger: silentLogger, // SDK 的错误日志会带上请求/响应体，正文不能进日志
  });

  return {
    async getDocument(documentId: string): Promise<DocumentMeta> {
      const token = await options.userAccessToken();
      const data = unwrap(
        await guardSdkCall(() =>
          withRetry(() =>
            client.docx.document.get({ path: { document_id: documentId } }, lark.withUserAccessToken(token))
          )
        )
      );
      const document = asRecord(data.document);
      return {
        title: typeof document.title === "string" ? document.title : "",
        revisionId: String(document.revision_id ?? ""),
      };
    },

    async listBlocks(documentId: string, pageToken?: string): Promise<BlockPage> {
      const token = await options.userAccessToken();
      const data = unwrap(
        await guardSdkCall(() =>
          withRetry(() =>
            client.docx.documentBlock.list(
              {
                path: { document_id: documentId },
                params: { page_size: PAGE_SIZE, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
              },
              lark.withUserAccessToken(token)
            )
          )
        )
      );
      const items = Array.isArray(data.items) ? (data.items as FeishuBlock[]) : [];
      const page: BlockPage = { items, hasMore: data.has_more === true };
      if (typeof data.page_token === "string") page.pageToken = data.page_token;
      return page;
    },

    async resolveWikiToken(wikiToken: string): Promise<WikiNode> {
      const token = await options.userAccessToken();
      const data = unwrap(
        await guardSdkCall(() =>
          withRetry(() =>
            client.wiki.space.getNode({ params: { token: wikiToken, obj_type: "wiki" } }, lark.withUserAccessToken(token))
          )
        )
      );
      const node = asRecord(data.node);
      const objToken = node.obj_token;
      const objType = node.obj_type;
      if (typeof objToken !== "string" || typeof objType !== "string") {
        throw new Error("wiki 节点响应里缺少对象信息");
      }
      const result: WikiNode = { objToken, objType };
      if (typeof node.title === "string") result.title = node.title;
      return result;
    },
  };
}
