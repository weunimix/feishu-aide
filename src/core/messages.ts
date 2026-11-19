/** 会话历史消息：输入校验、消息体归一到可读文本。 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export interface MessageQuery {
  chatId: string;
  startTime?: number;
  endTime?: number;
  limit: number;
}

export interface ChatMessage {
  messageId: string;
  type: string;
  text: string;
  senderName?: string;
  senderId?: string;
  /** 消息发送时间，毫秒时间戳。 */
  sentAt: number;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  pageToken?: string;
}

/** 适配层返回未经归一化的原始条目，归一化集中在下面做一次。 */
export interface RawMessagePage {
  items: readonly unknown[];
  hasMore: boolean;
  pageToken?: string;
}

export interface MessageReader {
  listMessages(query: MessageQuery): Promise<RawMessagePage>;
}

export type MessageErrorCode = "invalid_chat_id" | "invalid_limit" | "invalid_time_range";

export class MessageError extends Error {
  readonly code: MessageErrorCode;

  constructor(code: MessageErrorCode, message: string) {
    super(message);
    this.name = "MessageError";
    this.code = code;
  }
}

/** 接受 ISO 8601 字符串或秒级时间戳，统一换成秒。 */
export function parseTime(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  throw new MessageError("invalid_time_range", `${name} 需要 ISO 时间（如 2026-11-20T10:00:00+08:00）或秒级时间戳`);
}

export function normalizeMessageQuery(input: {
  chatId?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  limit?: unknown;
}): MessageQuery {
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  if (chatId.length === 0) {
    throw new MessageError("invalid_chat_id", "需要提供会话 id（oc_ 开头的 chat_id）");
  }

  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new MessageError("invalid_limit", `limit 必须是 1 到 ${MAX_LIMIT} 之间的整数`);
  }

  const startTime = parseTime(input.startTime, "startTime");
  const endTime = parseTime(input.endTime, "endTime");
  if (startTime !== undefined && endTime !== undefined && startTime >= endTime) {
    throw new MessageError("invalid_time_range", "startTime 必须早于 endTime");
  }

  const query: MessageQuery = { chatId, limit };
  if (startTime !== undefined) query.startTime = startTime;
  if (endTime !== undefined) query.endTime = endTime;
  return query;
}

function textFromPost(content: Record<string, unknown>): string {
  const rows = content.content;
  if (!Array.isArray(rows)) {
    return "";
  }
  const lines: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const parts: string[] = [];
    for (const element of row) {
      if (typeof element !== "object" || element === null) continue;
      const item = element as Record<string, unknown>;
      if (typeof item.text === "string") {
        parts.push(item.text);
      } else if (item.tag === "a" && typeof item.href === "string") {
        parts.push(item.href);
      } else if (item.tag === "at" && typeof item.user_name === "string") {
        parts.push(`@${item.user_name}`);
      }
    }
    if (parts.length > 0) lines.push(parts.join(""));
  }
  const title = typeof content.title === "string" && content.title.length > 0 ? `【${content.title}】` : "";
  return title + lines.join("\n").trim();
}

/**
 * 有些客户端把段落包成 `<p>…</p>` 再作为文本消息发出（粘贴富文本时常见）。
 * 只剥这种整段包裹与其中的 `<br>`，不做通用 HTML 清洗，避免误删正文里的尖括号。
 */
function unwrapParagraphs(text: string): string {
  const match = /^<p>([\s\S]*)<\/p>$/.exec(text.trim());
  if (!match) return text;
  return (match[1] ?? "").replace(/<br\s*\/?>/gi, "\n");
}

/** 消息体是 JSON 字符串，按 msg_type 取出人能读的文本。 */
export function extractText(msgType: string, rawContent: unknown): string {
  let content: Record<string, unknown> = {};
  if (typeof rawContent === "string") {
    try {
      const parsed: unknown = JSON.parse(rawContent);
      if (typeof parsed === "object" && parsed !== null) content = parsed as Record<string, unknown>;
    } catch {
      return rawContent;
    }
  } else if (typeof rawContent === "object" && rawContent !== null) {
    content = rawContent as Record<string, unknown>;
  }

  switch (msgType) {
    case "text":
      return typeof content.text === "string" ? unwrapParagraphs(content.text) : "";
    case "post":
      return textFromPost(content);
    case "image":
      return "[图片]";
    case "audio":
      return "[语音]";
    case "media":
      return "[视频]";
    case "file": {
      const name = typeof content.file_name === "string" ? content.file_name : "";
      return name.length > 0 ? `[文件] ${name}` : "[文件]";
    }
    case "sticker":
      return "[表情]";
    case "interactive":
      return "[卡片]";
    case "share_chat":
      return "[群名片]";
    case "merge_forward":
      return "[合并转发]";
    default:
      return `[${msgType || "未知消息"}]`;
  }
}

export function toMessages(items: readonly unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.deleted === true) continue;

    const messageId = typeof record.message_id === "string" ? record.message_id : "";
    if (messageId.length === 0) continue;

    const msgType = typeof record.msg_type === "string" ? record.msg_type : "";
    const sender = (typeof record.sender === "object" && record.sender !== null ? record.sender : {}) as Record<string, unknown>;
    const body = (typeof record.body === "object" && record.body !== null ? record.body : {}) as Record<string, unknown>;
    const createdAt = Number(record.create_time ?? 0);

    const message: ChatMessage = {
      messageId,
      type: msgType,
      text: extractText(msgType, body.content),
      sentAt: Number.isFinite(createdAt) ? createdAt : 0,
    };
    if (typeof sender.sender_name === "string" && sender.sender_name.length > 0) message.senderName = sender.sender_name;
    if (typeof sender.id === "string" && sender.id.length > 0) message.senderId = sender.id;
    messages.push(message);
  }
  return messages;
}

/** 统一入口：校验 → 取一页 → 归一化。 */
export async function listChatMessages(
  reader: MessageReader,
  input: Parameters<typeof normalizeMessageQuery>[0]
): Promise<MessagePage> {
  const query = normalizeMessageQuery(input);
  const page = await reader.listMessages(query);
  return {
    messages: toMessages(page.items),
    hasMore: page.hasMore,
    ...(page.pageToken === undefined ? {} : { pageToken: page.pageToken }),
  };
}
