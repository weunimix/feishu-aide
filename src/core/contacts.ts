/**
 * 联系人搜索：按名字找到人，并带回能直接读取的单聊会话 id。
 *
 * 飞书的会话列表接口不返回单聊，所以「按名字找会话」只能先走通讯录搜索；
 * 搜索结果里的 `meta_data.chat_id` 就是与这个人的单聊 id，前提是之前聊过。
 */

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 30;
export const MAX_QUERY_CHARS = 50;

export interface ContactQuery {
  query: string;
  limit: number;
}

export interface ContactHit {
  openId: string;
  name: string;
  /** 与这个人的单聊会话 id；从未聊过则为空。 */
  chatId?: string;
  department?: string;
}

export interface ContactPage {
  hits: ContactHit[];
  hasMore: boolean;
  notice?: string;
}

/** 适配层返回未经归一化的原始条目，归一化集中在下面做一次。 */
export interface RawContactPage {
  items: readonly unknown[];
  hasMore: boolean;
  notice?: string;
}

export interface ContactSearcher {
  searchUsers(query: ContactQuery): Promise<RawContactPage>;
}

export type ContactErrorCode = "empty_query" | "query_too_long" | "invalid_limit";

export class ContactError extends Error {
  readonly code: ContactErrorCode;

  constructor(code: ContactErrorCode, message: string) {
    super(message);
    this.name = "ContactError";
    this.code = code;
  }
}

export function normalizeContactQuery(input: { query?: unknown; limit?: unknown }): ContactQuery {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0) {
    throw new ContactError("empty_query", "需要提供要搜索的名字或关键词");
  }
  if ([...query].length > MAX_QUERY_CHARS) {
    throw new ContactError("query_too_long", `关键词最多 ${MAX_QUERY_CHARS} 个字符`);
  }

  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ContactError("invalid_limit", `limit 必须是 1 到 ${MAX_LIMIT} 之间的整数`);
  }
  return { query, limit };
}

const HIGHLIGHT_RE = /<\/?h>/g;

/** 搜索结果用 `<h></h>` 标出命中片段，界面展示时要去掉。 */
export function stripHighlight(text: string): string {
  return text.replace(HIGHLIGHT_RE, "").trim();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `display_info` 最多三段：命中高亮、部门、最近联系提示（方括号包裹）。
 * 该格式没有文档保证，因此按形状取值而不是按固定下标。
 */
function displayLines(displayInfo: unknown): string[] {
  if (typeof displayInfo !== "string") return [];
  return displayInfo
    .split("\n")
    .map((line) => stripHighlight(line))
    .filter((line) => line.length > 0);
}

function pickName(item: Record<string, unknown>): string {
  const meta = item.meta_data && typeof item.meta_data === "object" ? (item.meta_data as Record<string, unknown>) : {};
  const names = meta.i18n_names && typeof meta.i18n_names === "object" ? (meta.i18n_names as Record<string, unknown>) : {};
  const preferred = stringField(names, "zh_cn") ?? stringField(names, "en_us");
  if (preferred !== undefined) return preferred;
  for (const value of Object.values(names)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  const lines = displayLines(item.display_info);
  return lines[0] ?? "";
}

function pickDepartment(item: Record<string, unknown>): string | undefined {
  const lines = displayLines(item.display_info);
  const candidate = lines[1];
  if (candidate === undefined || /^\[.*\]$/.test(candidate)) return undefined;
  return candidate;
}

export function toContacts(items: readonly unknown[]): ContactHit[] {
  const hits: ContactHit[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const openId = stringField(record, "id");
    if (openId === undefined) continue;

    const meta = record.meta_data && typeof record.meta_data === "object" ? (record.meta_data as Record<string, unknown>) : {};
    const hit: ContactHit = { openId, name: pickName(record) };
    const chatId = stringField(meta, "chat_id");
    if (chatId !== undefined) hit.chatId = chatId;
    const department = pickDepartment(record);
    if (department !== undefined) hit.department = department;
    hits.push(hit);
  }
  return hits;
}

/** 统一入口：校验 → 取一页 → 归一化。 */
export async function searchContacts(
  searcher: ContactSearcher,
  input: { query?: unknown; limit?: unknown }
): Promise<ContactPage> {
  const query = normalizeContactQuery(input);
  const page = await searcher.searchUsers(query);
  const result: ContactPage = { hits: toContacts(page.items), hasMore: page.hasMore };
  if (page.notice !== undefined) result.notice = page.notice;
  return result;
}
