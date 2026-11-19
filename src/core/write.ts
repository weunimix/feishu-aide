import { createHash } from "node:crypto";
import { readDocument, type DocReader, type DocumentSnapshot, type ReadLimits } from "./docx.js";
import { planWrite, summarizePlan, type PlannedOp } from "./write-plan.js";
import type { DocxWriteApi } from "./sdk-writer.js";

/**
 * 写回编排：校验 → 版本比对 → 确认 gate → 逐个执行 → 汇报结果。
 * 依赖注入 reader/writer，配上假的实现就能离线覆盖整条链路。
 */

export interface WritePolicy {
  enabled: boolean;
  confirm: "diff" | "always" | "never";
  requireRevisionMatch: boolean;
  /** 允许的操作种类；缺省不限制。 */
  operations?: readonly string[];
}

export interface WriteRequest {
  documentId: string | null;
  baseRevision?: string;
  ops: unknown;
  apply?: boolean;
}

export interface WriteResult {
  op: string;
  ok: boolean;
  error?: string;
  /** 新建文档时回传新文档 id，调用方据此继续读取或写入。 */
  documentId?: string;
}

export interface WriteOutcome {
  applied: boolean;
  documentId?: string;
  revisionId?: string;
  plan: string[];
  results: WriteResult[];
}

export interface WriteDeps {
  reader: DocReader;
  writer: DocxWriteApi;
  policy: WritePolicy;
  limits: ReadLimits;
  /** 幂等键工厂；默认按内容哈希，测试可注入固定值。 */
  clientToken?: (seed: string) => string;
}

export type WriteConflictCode =
  | "write_disabled"
  | "missing_document"
  | "need_base_revision"
  | "revision_mismatch"
  | "need_confirmation"
  | "op_not_allowed";

export class WriteConflict extends Error {
  constructor(
    readonly code: WriteConflictCode,
    message: string
  ) {
    super(message);
    this.name = "WriteConflict";
  }
}

const MUTATING_OPS = new Set(["replace_text", "insert_text"]);

function defaultClientToken(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function needsDocument(ops: unknown): boolean {
  if (!Array.isArray(ops)) return true;
  return ops.some((op) => {
    const name = typeof op === "object" && op !== null ? (op as { op?: unknown }).op : undefined;
    return typeof name === "string" && MUTATING_OPS.has(name);
  });
}

function labelOf(planned: PlannedOp): string {
  if (planned.kind === "replace_text") return `replace_text ${planned.blockId}`;
  if (planned.kind === "insert_text") return `insert_text ${planned.texts.length} 个块`;
  return "create_document";
}

async function execute(
  deps: WriteDeps,
  planned: PlannedOp[],
  documentId: string | null,
  baseRevision: string
): Promise<WriteResult[]> {
  const token = deps.clientToken ?? defaultClientToken;
  const results: WriteResult[] = [];

  for (const [index, item] of planned.entries()) {
    try {
      if (item.kind === "create_document") {
        const created = await deps.writer.createDocument(item.title);
        results.push({ op: labelOf(item), ok: true, documentId: created.documentId });
        continue;
      }

      if (documentId === null) {
        throw new WriteConflict("missing_document", "写操作缺少文档 id");
      }

      if (item.kind === "replace_text") {
        await deps.writer.patchTextBlock({
          documentId,
          blockId: item.blockId,
          text: item.text,
          clientToken: token(`${documentId}|${baseRevision}|${index}|replace|${item.blockId}|${item.text}`),
        });
      } else {
        await deps.writer.createTextChildren({
          documentId,
          parentBlockId: item.parentBlockId || documentId,
          texts: item.texts,
          ...(item.index === null ? {} : { index: item.index }),
          clientToken: token(`${documentId}|${baseRevision}|${index}|insert|${item.parentBlockId}|${item.texts.join("\u0000")}`),
        });
      }
      results.push({ op: labelOf(item), ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ op: labelOf(item), ok: false, error: message });
    }
  }

  return results;
}

export async function runWrite(deps: WriteDeps, request: WriteRequest): Promise<WriteOutcome> {
  if (!deps.policy.enabled) {
    throw new WriteConflict("write_disabled", "写回未启用：请在插件配置里打开 feishuAide.write.enabled");
  }

  if (needsDocument(request.ops) && !request.documentId) {
    throw new WriteConflict("missing_document", "替换或插入操作需要 document_id");
  }

  let snapshot: DocumentSnapshot | null = null;
  if (request.documentId) {
    snapshot = await readDocument(deps.reader, request.documentId, deps.limits);
  }

  const planned = planWrite(snapshot, request.ops);
  const plan = summarizePlan(planned);

  if (deps.policy.operations) {
    const allowed = new Set(deps.policy.operations);
    const blocked = planned.find((item) => !allowed.has(item.kind));
    if (blocked) {
      throw new WriteConflict(
        "op_not_allowed",
        `写回不允许 ${blocked.kind}：当前配置只允许 ${[...allowed].join("、") || "（空）"}`
      );
    }
  }

  if (deps.policy.requireRevisionMatch && request.documentId) {
    if (!request.baseRevision) {
      throw new WriteConflict(
        "need_base_revision",
        "写回需要 base_revision：先调用 feishu_doc_read 拿到当前 revisionId，再带着它提交修改"
      );
    }
    if (snapshot && snapshot.revisionId !== request.baseRevision) {
      throw new WriteConflict(
        "revision_mismatch",
        `文档已变化：当前版本 ${snapshot.revisionId}，你提交的是 ${request.baseRevision}。请重新读取后再改`
      );
    }
  }

  if (deps.policy.confirm !== "never" && request.apply !== true) {
    return {
      applied: false,
      ...(request.documentId ? { documentId: request.documentId } : {}),
      plan,
      results: [],
    };
  }

  const results = await execute(deps, planned, request.documentId, request.baseRevision ?? "");
  const saved = results.some((result) => result.ok);
  const createdId = request.documentId ?? results.find((result) => result.documentId)?.documentId;

  let revisionId: string | undefined;
  if (saved && createdId) {
    revisionId = (await deps.reader.getDocument(createdId)).revisionId;
  }

  return {
    applied: saved,
    ...(createdId ? { documentId: createdId } : {}),
    ...(revisionId ? { revisionId } : {}),
    plan,
    results,
  };
}
