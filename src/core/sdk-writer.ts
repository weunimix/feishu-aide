import * as lark from "@larksuiteoapi/node-sdk";
import { asRecord, unwrap } from "./feishu-json.js";
import type { Domain } from "./device-flow.js";

/**
 * 写回的 SDK 适配层。和 sdk-reader 一样，只有这里直接依赖 SDK：
 * 插件层依赖下面这个窄接口，测试用假实现即可覆盖校验与编排逻辑。
 */

export interface PatchTextInput {
  documentId: string;
  blockId: string;
  text: string;
  clientToken: string;
}

export interface CreateChildrenInput {
  documentId: string;
  /** 父块 id；往文档根插入时传 document_id。 */
  parentBlockId: string;
  texts: string[];
  index?: number;
  clientToken: string;
}

export interface DocxWriteApi {
  patchTextBlock(input: PatchTextInput): Promise<void>;
  createTextChildren(input: CreateChildrenInput): Promise<string[]>;
  createDocument(title: string): Promise<{ documentId: string }>;
}

export interface WriterOptions {
  appId: string;
  appSecret: string;
  domain: Domain;
  userAccessToken: () => Promise<string>;
  /** 测试注入用：把 SDK 指向本地 fake server。 */
  domainOverride?: string;
}

function textElements(text: string): Array<{ text_run: { content: string } }> {
  return [{ text_run: { content: text } }];
}

/** 一个文本块；飞书的块类型 2 是正文文本块。 */
function textBlock(text: string) {
  return { block_type: 2, text: { elements: textElements(text) } };
}

export function createSdkWriter(options: WriterOptions): DocxWriteApi {
  const client = new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domainOverride ?? (options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu),
    loggerLevel: lark.LoggerLevel.warn,
  });

  const requestOptions = async () => lark.withUserAccessToken(await options.userAccessToken());

  return {
    async patchTextBlock(input: PatchTextInput): Promise<void> {
      const response = await client.docx.documentBlock.patch(
        {
          path: { document_id: input.documentId, block_id: input.blockId },
          params: { client_token: input.clientToken },
          data: { update_text_elements: { elements: textElements(input.text) } },
        },
        await requestOptions()
      );
      unwrap(response);
    },

    async createTextChildren(input: CreateChildrenInput): Promise<string[]> {
      const response = await client.docx.documentBlockChildren.create(
        {
          path: { document_id: input.documentId, block_id: input.parentBlockId },
          params: { client_token: input.clientToken },
          data: {
            children: input.texts.map(textBlock),
            ...(input.index === undefined ? {} : { index: input.index }),
          },
        },
        await requestOptions()
      );
      const data = unwrap(response);
      const children = Array.isArray(data.children) ? data.children : [];
      const ids = children
        .map((child) => asRecord(child))
        .map((block) => block.block_id)
        .filter((id): id is string => typeof id === "string");
      return ids;
    },

    async createDocument(title: string): Promise<{ documentId: string }> {
      const response = await client.docx.document.create(
        { data: { title } },
        await requestOptions()
      );
      const data = unwrap(response);
      const document = asRecord(data.document);
      const documentId = document.document_id;
      if (typeof documentId !== "string" || documentId.length === 0) {
        throw new Error("新建文档的响应里没有 document_id");
      }
      return { documentId };
    },
  };
}
