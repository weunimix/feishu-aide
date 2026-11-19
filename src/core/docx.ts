import { documentCacheKey, type DocumentCache } from "./cache.js";
import { renderMarkdown, summarizeBlocks, type FeishuBlock } from "./markdown.js";

/**
 * 文档读取的单一入口。这里不直接碰 SDK：SDK 细节收在 `SdkDocReader` 里，
 * 读文档的编排（分页、上限、截断）是纯逻辑，可以用假 reader 全离线测试。
 */

export interface DocumentMeta {
  title: string;
  /** 版本号。写回时用它做乐观锁。 */
  revisionId: string;
}

export interface BlockPage {
  items: FeishuBlock[];
  hasMore: boolean;
  pageToken?: string;
}

export interface DocReader {
  getDocument(documentId: string): Promise<DocumentMeta>;
  listBlocks(documentId: string, pageToken?: string): Promise<BlockPage>;
  /** 可选：把 wiki 节点 token 换成它背后的对象；不支持时由调用方给出提示。 */
  resolveWikiToken?: (wikiToken: string) => Promise<WikiNode>;
}

/** wiki 节点背后的真实对象。 */
export interface WikiNode {
  objToken: string;
  objType: string;
  title?: string;
}

export interface ReadLimits {
  maxBlocks: number;
  maxBytes: number;
}

export interface DocumentSnapshot {
  documentId: string;
  revisionId: string;
  title: string;
  blocks: Array<{ block_id: string; block_type: number; text: string }>;
  markdown: string;
  truncated: boolean;
  /** 这次读取是否直接来自缓存。 */
  fromCache?: boolean;
}

export class DocReadError extends Error {
  constructor(
    readonly code: "invalid_ref" | "unsupported_ref" | "too_large" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "DocReadError";
  }
}

/** 从 URL 或裸 token 里取出文档 token。wiki 链接先返回 wiki token，交由上层解析。 */
export function extractDocRef(input: string): { kind: "docx" | "wiki" | "token"; token: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new DocReadError("invalid_ref", "文档引用为空");

  const urlMatch = trimmed.match(/https?:\/\/[^\s]+\/(docx|wiki)\/([A-Za-z0-9]+)/);
  if (urlMatch) {
    const [, rawKind, token] = urlMatch;
    if (!token) throw new DocReadError("invalid_ref", `无法识别的文档引用：${trimmed.slice(0, 80)}`);
    return { kind: rawKind === "wiki" ? "wiki" : "docx", token };
  }

  if (/^[A-Za-z0-9]+$/.test(trimmed)) return { kind: "token", token: trimmed };
  throw new DocReadError("invalid_ref", `无法识别的文档引用：${trimmed.slice(0, 80)}`);
}

async function loadBlocks(
  reader: DocReader,
  documentId: string,
  limits: ReadLimits
): Promise<{ blocks: FeishuBlock[]; truncated: boolean }> {
  const blocks: FeishuBlock[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  for (;;) {
    const page = await reader.listBlocks(documentId, pageToken);
    for (const block of page.items) {
      if (blocks.length >= limits.maxBlocks) {
        truncated = true;
        break;
      }
      blocks.push(block);
    }
    if (truncated || !page.hasMore || !page.pageToken) break;
    pageToken = page.pageToken;
  }

  return { blocks, truncated };
}

function buildSnapshot(
  documentId: string,
  meta: DocumentMeta,
  blocks: FeishuBlock[],
  truncated: boolean,
  limits: ReadLimits
): DocumentSnapshot {
  const markdown = renderMarkdown(blocks);
  if (Buffer.byteLength(markdown, "utf8") > limits.maxBytes) {
    throw new DocReadError("too_large", `文档超过 ${limits.maxBytes} 字节上限，请缩小范围后重试`);
  }

  return {
    documentId,
    revisionId: meta.revisionId,
    title: meta.title,
    blocks: summarizeBlocks(blocks, limits.maxBlocks),
    markdown,
    truncated: truncated || blocks.length >= limits.maxBlocks,
  };
}

/**
 * 读一篇文档：先取元信息，再按页拉块，直到上限或读完。
 * 截断时明确置 `truncated`，让调用方知道后续还有内容。
 */
export async function readDocument(
  reader: DocReader,
  documentId: string,
  limits: ReadLimits
): Promise<DocumentSnapshot> {
  const meta = await reader.getDocument(documentId);
  const { blocks, truncated } = await loadBlocks(reader, documentId, limits);
  return buildSnapshot(documentId, meta, blocks, truncated, limits);
}

export interface ReadCacheOptions {
  cache: DocumentCache;
  /** 缓存有效期；小于等于 0 表示完全不使用缓存。 */
  ttlSeconds: number;
}

/**
 * 带缓存的读取。元信息每次都取，用来确认版本；块列表按 `(文档, 版本, 预算)`
 * 命中缓存，命中时不再翻页拉块。版本变了自然落到新键上，旧条目由 prune 清掉。
 */
export async function readDocumentCached(
  reader: DocReader,
  documentId: string,
  limits: ReadLimits,
  options: ReadCacheOptions
): Promise<DocumentSnapshot> {
  const ttlMs = Math.max(0, options.ttlSeconds) * 1000;
  const meta = await reader.getDocument(documentId);
  const useCache = ttlMs > 0;
  const key = documentCacheKey(documentId, meta.revisionId, limits);

  if (useCache) {
    const hit = await options.cache.get(key, ttlMs).catch(() => null);
    if (hit) return { ...hit.snapshot, fromCache: true };
  }

  const { blocks, truncated } = await loadBlocks(reader, documentId, limits);
  const snapshot = buildSnapshot(documentId, meta, blocks, truncated, limits);

  if (useCache) {
    await options.cache.set(key, snapshot).catch(() => undefined);
    await options.cache.prune(ttlMs).catch(() => undefined);
  }

  return snapshot;
}
