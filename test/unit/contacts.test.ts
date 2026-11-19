import assert from "node:assert/strict";
import test from "node:test";
import {
	ContactError,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	MAX_QUERY_CHARS,
	normalizeContactQuery,
	searchContacts,
	stripHighlight,
	toContacts,
} from "../../src/core/contacts.js";
import type { ContactQuery, ContactSearcher, RawContactPage } from "../../src/core/contacts.js";

function fakeSearcher(page: RawContactPage, seen: ContactQuery[] = []): ContactSearcher {
	return {
		async searchUsers(query) {
			seen.push(query);
			return page;
		},
	};
}

test("关键词去掉首尾空白，limit 缺省为 10", () => {
	const query = normalizeContactQuery({ query: "  张三  " });
	assert.equal(query.query, "张三");
	assert.equal(query.limit, DEFAULT_LIMIT);
});

test("空关键词在发请求前就被拒绝", () => {
	assert.throws(
		() => normalizeContactQuery({ query: "  " }),
		(error: unknown) => error instanceof ContactError && error.code === "empty_query"
	);
});

test("关键词过长与 limit 越界都给出明确错误码", () => {
	assert.throws(
		() => normalizeContactQuery({ query: "a".repeat(MAX_QUERY_CHARS + 1) }),
		(error: unknown) => error instanceof ContactError && error.code === "query_too_long"
	);
	for (const limit of [0, MAX_LIMIT + 1, 1.5]) {
		assert.throws(
			() => normalizeContactQuery({ query: "张三", limit }),
			(error: unknown) => error instanceof ContactError && error.code === "invalid_limit"
		);
	}
});

test("高亮标签会被去掉", () => {
	assert.equal(stripHighlight("<h>张</h>三"), "张三");
});

test("联系人条目归一化出名字、部门与单聊会话 id", () => {
	const hits = toContacts([
		{
			id: "ou_1",
			display_info: "<h>张三</h>\n研发部\n[3 天前聊过]",
			meta_data: { i18n_names: { zh_cn: "张三", en_us: "Zhang San" }, chat_id: "oc_chat_1" },
		},
	]);
	assert.deepEqual(hits, [{ openId: "ou_1", name: "张三", chatId: "oc_chat_1", department: "研发部" }]);
});

test("没聊过天的人没有 chat_id，名字退回 display_info 首行", () => {
	const hits = toContacts([
		{ id: "ou_2", display_info: "李四\n[未联系]" },
		{ id: "", display_info: "缺少 id 的条目" },
	]);
	assert.deepEqual(hits, [{ openId: "ou_2", name: "李四" }]);
});

test("searchContacts 透传 notice 与 hasMore", async () => {
	const seen: ContactQuery[] = [];
	const page = await searchContacts(fakeSearcher({ items: [], hasMore: true, notice: "仅显示同组织成员" }, seen), {
		query: "张三",
		limit: 5,
	});
	assert.deepEqual(seen, [{ query: "张三", limit: 5 }]);
	assert.equal(page.hasMore, true);
	assert.equal(page.notice, "仅显示同组织成员");
	assert.equal(page.hits.length, 0);
});
