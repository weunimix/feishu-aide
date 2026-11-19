import type { DocReader, WikiNode } from "./docx.js";

/**
 * 文档引用的目标解析：`/docx/` 链接与裸 token 本身就是文档 id，
 * `/wiki/` 链接要先换成节点背后的对象（绝大多数是 docx）。
 *
 * 这里只做"能不能读"的判断，不读内容；解析失败与类型不支持都给出可操作的错误。
 */

export type { WikiNode };

export type WikiTargetCode = "resolver_missing" | "unsupported_obj";

export class WikiTargetError extends Error {
  constructor(
    readonly code: WikiTargetCode,
    message: string
  ) {
    super(message);
    this.name = "WikiTargetError";
  }
}

export type DocRef = { kind: "docx" | "wiki" | "token"; token: string };

/** 把任意文档引用解析成 docx 文档 id。 */
export async function resolveDocumentId(reader: DocReader, ref: DocRef): Promise<string> {
  if (ref.kind !== "wiki") return ref.token;

  if (!reader.resolveWikiToken) {
    throw new WikiTargetError(
      "resolver_missing",
      "当前读取器不支持解析 wiki 节点：请直接给出 /docx/ 链接或 document_id"
    );
  }

  const node = await reader.resolveWikiToken(ref.token);
  if (node.objType !== "docx") {
    throw new WikiTargetError(
      "unsupported_obj",
      `wiki 节点指向的是 ${node.objType}，当前只支持文档（docx）`
    );
  }
  return node.objToken;
}
