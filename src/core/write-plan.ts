/**
 * 写回计划的纯逻辑：把调用方给的块级操作，校验成可执行的计划。
 *
 * 这里不做 I/O，也不做版本比较（版本比较需要重新读文档，放在插件层）。
 * 校验的是"这些操作在给定快照上是否说清楚了"，避免把含糊的操作发给飞书。
 */

import type { DocumentSnapshot } from "./docx.js";

/** 文本型块：只有这些块的文字能被整块替换。 */
const TEXT_LIKE_BLOCK_TYPES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);

export type WriteOp =
  | { op: "replace_text"; block_id: string; text: string }
  | { op: "insert_text"; texts: string[]; index?: number; parent_block_id?: string }
  | { op: "create_document"; title: string };

export type PlannedOp =
  | { kind: "replace_text"; blockId: string; text: string; before: string }
  | { kind: "insert_text"; parentBlockId: string; index: number | null; texts: string[] }
  | { kind: "create_document"; title: string };

export type WriteErrorCode =
  | "empty_ops"
  | "unknown_op"
  | "missing_block"
  | "unsupported_block"
  | "invalid_arguments";

export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WriteError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WriteError("invalid_arguments", `${field} 必须是非空字符串数组`);
  }
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new WriteError("invalid_arguments", `${field} 里每一项都必须是非空字符串`);
    }
    texts.push(item);
  }
  return texts;
}

/**
 * 校验一组操作。`snapshot` 是刚读到的文档（含块 id 与类型）；
 * 新建文档不依赖快照，因此 `snapshot` 可以为 null。
 */
export function planWrite(snapshot: DocumentSnapshot | null, ops: unknown): PlannedOp[] {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new WriteError("empty_ops", "至少需要一个写操作");
  }

  const blocks = new Map(snapshot?.blocks.map((block) => [block.block_id, block]));
  const planned: PlannedOp[] = [];

  for (const raw of ops) {
    if (!isRecord(raw)) throw new WriteError("unknown_op", "写操作必须是对象");
    const op = raw.op;

    if (op === "replace_text") {
      const blockId = raw.block_id;
      const text = raw.text;
      if (typeof blockId !== "string" || blockId.length === 0) {
        throw new WriteError("invalid_arguments", "replace_text 需要 block_id");
      }
      if (typeof text !== "string") {
        throw new WriteError("invalid_arguments", "replace_text 需要 text 字符串");
      }
      const block = blocks.get(blockId);
      if (!block) {
        throw new WriteError("missing_block", `快照里没有块 ${blockId}，请先重新读取文档`);
      }
      if (!TEXT_LIKE_BLOCK_TYPES.has(block.block_type)) {
        throw new WriteError(
          "unsupported_block",
          `块 ${blockId} 的类型 ${block.block_type} 不是文本型块，不能整块替换文字`
        );
      }
      planned.push({ kind: "replace_text", blockId, text, before: block.text });
      continue;
    }

    if (op === "insert_text") {
      const texts = stringArray(raw.texts, "texts");
      const parentRaw = raw.parent_block_id;
      if (parentRaw !== undefined && typeof parentRaw !== "string") {
        throw new WriteError("invalid_arguments", "parent_block_id 必须是字符串");
      }
      const parentBlockId = typeof parentRaw === "string" && parentRaw.length > 0 ? parentRaw : "";
      if (parentBlockId && !blocks.has(parentBlockId)) {
        throw new WriteError("missing_block", `快照里没有父块 ${parentBlockId}`);
      }
      const indexRaw = raw.index;
      if (indexRaw !== undefined && (typeof indexRaw !== "number" || !Number.isInteger(indexRaw) || indexRaw < 0)) {
        throw new WriteError("invalid_arguments", "index 必须是非负整数");
      }
      planned.push({
        kind: "insert_text",
        parentBlockId,
        index: typeof indexRaw === "number" ? indexRaw : null,
        texts,
      });
      continue;
    }

    if (op === "create_document") {
      const title = raw.title;
      if (typeof title !== "string" || title.trim().length === 0) {
        throw new WriteError("invalid_arguments", "create_document 需要非空 title");
      }
      planned.push({ kind: "create_document", title: title.trim() });
      continue;
    }

    throw new WriteError("unknown_op", `不认识的写操作：${String(op)}`);
  }

  return planned;
}

/** 给确认界面用的摘要；一行一个操作。 */
export function summarizePlan(planned: PlannedOp[]): string[] {
  return planned.map((item) => {
    if (item.kind === "replace_text") return `替换块 ${item.blockId}：${JSON.stringify(item.before)} → ${JSON.stringify(item.text)}`;
    if (item.kind === "insert_text") {
      const where = item.parentBlockId ? `块 ${item.parentBlockId} 之后` : "文档末尾";
      return `在${where}插入 ${item.texts.length} 个文本块`;
    }
    return `新建文档《${item.title}》`;
  });
}
