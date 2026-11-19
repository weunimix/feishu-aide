import assert from "node:assert/strict";
import test from "node:test";
import { FakeFeishuServer } from "../helpers/fake-feishu.js";
import { searchContacts } from "../../src/core/contacts.js";
import { createSdkContactSearcher } from "../../src/core/sdk-contacts.js";

async function withServer(run: (server: FakeFeishuServer) => Promise<void>): Promise<void> {
	const server = new FakeFeishuServer();
	await server.start();
	try {
		server.fixtures.contactItems["张三"] = [
			{
				id: "ou_1",
				display_info: "<h>张三</h>\n研发部\n[3 天前聊过]",
				meta_data: { i18n_names: { zh_cn: "张三" }, chat_id: "oc_p2p" },
			},
		];
		await run(server);
	} finally {
		await server.close();
	}
}

test("按名字搜索联系人走真实 HTTP：带用户令牌与页大小", async () => {
	await withServer(async (server) => {
		const searcher = createSdkContactSearcher({
			domain: "feishu",
			userAccessToken: async () => "u-token",
			domainOverride: server.url,
		});

		const page = await searchContacts(searcher, { query: "张三", limit: 5 });
		assert.deepEqual(page.hits, [{ openId: "ou_1", name: "张三", chatId: "oc_p2p", department: "研发部" }]);

		const [request] = server.requestsTo("/open-apis/contact/v3/users/search");
		assert.ok(request, "没有发搜索请求");
		assert.equal(request.method, "POST");
		assert.equal(request.headers.authorization, "Bearer u-token");
		assert.equal(request.query.get("page_size"), "5");
		assert.deepEqual(request.body, { query: "张三" });
	});
});

test("接口错误码原样上抛，不伪造空结果", async () => {
	await withServer(async (server) => {
		server.overrides.set("POST /open-apis/contact/v3/users/search", () => ({
			code: 99991672,
			msg: "Access denied. One of the following scopes is required: [contact:user:search]",
		}));
		const searcher = createSdkContactSearcher({
			domain: "feishu",
			userAccessToken: async () => "u-token",
			domainOverride: server.url,
		});

		await assert.rejects(
			() => searchContacts(searcher, { query: "张三" }),
			/contact:user:search/
		);
	});
});
