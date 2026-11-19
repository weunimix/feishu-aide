import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MessageError,
  extractText,
  listChatMessages,
  normalizeMessageQuery,
  parseTime,
  toMessages,
} from "../../src/core/messages.js";
import type { MessageReader, RawMessagePage } from "../../src/core/messages.js";

function fakeReader(page: RawMessagePage): MessageReader {
  return { async listMessages() { return page; } };
}

test("缺少会话 id 时失败", () => {
  assert.throws(
    () => normalizeMessageQuery({ chatId: "  " }),
    (error: unknown) => error instanceof MessageError && error.code === "invalid_chat_id"
  );
});

test("limit 越界被拒绝，缺省取默认值", () => {
  assert.throws(
    () => normalizeMessageQuery({ chatId: "oc_1", limit: MAX_LIMIT + 1 }),
    (error: unknown) => error instanceof MessageError && error.code === "invalid_limit"
  );
  assert.equal(normalizeMessageQuery({ chatId: "oc_1" }).limit, DEFAULT_LIMIT);
});

test("时间支持 ISO 与秒级时间戳，结束早于开始被拒绝", () => {
  assert.equal(parseTime("2026-11-20T00:00:00Z", "startTime"), 1795132800);
  assert.equal(parseTime("1795133600", "startTime"), 1795133600);
  assert.equal(parseTime(undefined, "startTime"), undefined);
  assert.throws(
    () => normalizeMessageQuery({ chatId: "oc_1", startTime: "2026-11-21T00:00:00+08:00", endTime: "2026-11-20T00:00:00+08:00" }),
    (error: unknown) => error instanceof MessageError && error.code === "invalid_time_range"
  );
});

test("文本、富文本、附件按类型取可读内容", () => {
  assert.equal(extractText("text", JSON.stringify({ text: "你好" })), "你好");
  assert.equal(
    extractText("post", JSON.stringify({ title: "周报", content: [[{ tag: "text", text: "本周进度" }], [{ tag: "text", text: "下周计划" }]] })),
    "【周报】本周进度\n下周计划"
  );
  assert.equal(extractText("file", JSON.stringify({ file_name: "方案.pdf" })), "[文件] 方案.pdf");
  assert.equal(extractText("image", "{}"), "[图片]");
  assert.equal(extractText("todo", "not-json"), "not-json");
});

test("已删除消息与缺 id 的条目被跳过", () => {
  const messages = toMessages([
    { message_id: "om_1", msg_type: "text", create_time: "1760000000000", body: { content: '{"text":"一"}' }, sender: { id: "ou_1", sender_name: "张三" } },
    { message_id: "om_2", msg_type: "text", deleted: true, create_time: "1760000001000", body: { content: '{"text":"二"}' } },
    { msg_type: "text", create_time: "1760000002000", body: { content: '{"text":"三"}' } },
  ]);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.ok(message);
  assert.equal(message.messageId, "om_1");
  assert.equal(message.text, "一");
  assert.equal(message.senderName, "张三");
  assert.equal(message.sentAt, 1760000000000);
});

test("入口把查询交给适配层并归一化结果", async () => {
  const reader = fakeReader({
    items: [{ message_id: "om_9", msg_type: "text", create_time: "1760000000000", body: { content: '{"text":"结论"}' } }],
    hasMore: true,
    pageToken: "next",
  });
  const page = await listChatMessages(reader, { chatId: "oc_1", limit: 5 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]?.text, "结论");
  assert.equal(page.hasMore, true);
  assert.equal(page.pageToken, "next");
});
