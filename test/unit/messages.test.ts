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

test("段落包裹的文本消息剥掉 <p> 与 <br>，普通尖括号保持原样", () => {
  assert.equal(
    extractText("text", JSON.stringify({ text: "<p>看这个\nhttps://example.com/x</p>" })),
    "看这个\nhttps://example.com/x"
  );
  assert.equal(extractText("text", JSON.stringify({ text: "a<br>b<br/>c" })), "a<br>b<br/>c");
  assert.equal(extractText("text", JSON.stringify({ text: "1 < 2 按 <ps> 处理" })), "1 < 2 按 <ps> 处理");
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

test("发送人姓名优先取会话内的显示名，脱敏的 sender_name 只作兜底", () => {
  const messages = toMessages([
    {
      message_id: "om_a",
      msg_type: "text",
      create_time: "1760000000000",
      body: { content: '{"text":"一"}' },
      sender: { id: "ou_1", sender_name: "用户000000", sender_i18n_names: { zh_cn: "张三", en_us: "Zhang San" } },
    },
    {
      message_id: "om_b",
      msg_type: "text",
      create_time: "1760000001000",
      body: { content: '{"text":"二"}' },
      sender: { id: "ou_2", sender_name: "weunimix" },
    },
  ]);
  assert.equal(messages[0]?.senderName, "张三");
  assert.equal(messages[1]?.senderName, "weunimix");
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
