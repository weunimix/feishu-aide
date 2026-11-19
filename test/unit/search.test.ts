import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_LIMIT,
	MAX_LIMIT,
	MAX_QUERY_LENGTH,
	SearchError,
	normalizeQuery,
	searchDocuments,
	stripHighlight,
	toHits,
} from "../../src/core/search.js";
import type { DocSearcher, SearchQuery, SearchResult } from "../../src/core/search.js";

function fakeSearcher(result: SearchResult, seen: SearchQuery[] = []): DocSearcher {
	return {
		async search(query) {
			seen.push(query);
			return result;
		},
	};
}

test("空搜索词在发请求前就被拒绝", async () => {
	assert.throws(
		() => normalizeQuery({ query: "   " }),
		(error: unknown) => error instanceof SearchError && error.code === "empty_query"
	);
});

test("搜索词过长给出明确错误码", () => {
	assert.throws(
		() => normalizeQuery({ query: "a".repeat(MAX_QUERY_LENGTH + 1) }),
		(error: unknown) => error instanceof SearchError && error.code === "query_too_long"
	);
});

test("limit 越界或非整数一律拒绝", () => {
	for (const limit of [0, MAX_LIMIT + 1, 1.5]) {
		assert.throws(
			() => normalizeQuery({ query: "周报", limit }),
			(error: unknown) => error instanceof SearchError && error.code === "invalid_limit"
		);
	}
});

test("缺省值补齐，且空 docTypes 不传给搜索实现", () => {
	const query = normalizeQuery({ query: " 周报 ", docTypes: [] });
	assert.equal(query.query, "周报");
	assert.equal(query.limit, DEFAULT_LIMIT);
	assert.equal(query.onlyTitle, false);
	assert.equal(query.docTypes, undefined);
});

test("高亮标签被去掉，命中项归一化", () => {
	const hits = toHits([
		{
			title_highlighted: "Q3 <em>周报</em>",
			summary_highlighted: "<em>周报</em>汇总",
			result_meta: {
				url: "https://x.feishu.cn/docx/AbC",
				token: "AbC",
				doc_types: "DOCX",
				update_time: 1760000000,
				owner_name: "张三",
			},
		},
		{ title_highlighted: "" },
	]);
	assert.equal(hits.length, 1);
	const [hit] = hits;
	assert.ok(hit);
	assert.equal(hit.title, "Q3 周报");
	assert.equal(hit.summary, "周报汇总");
	assert.equal(hit.url, "https://x.feishu.cn/docx/AbC");
	assert.equal(hit.type, "DOCX");
	assert.equal(hit.owner, "张三");
});

test("stripHighlight 只去掉标签，保留正文里的尖括号内容", () => {
	assert.equal(stripHighlight("<em>a</em> <br/> b"), "a  b");
	assert.equal(stripHighlight("a < b"), "a < b");
});

test("搜索实现收到的查询与调用方一致，结果按 limit 截断", async () => {
	const seen: SearchQuery[] = [];
	const searcher = fakeSearcher(
		{ hits: [{ title: "一" }, { title: "二" }, { title: "三" }], hasMore: true, total: 3 },
		seen
	);

	const result = await searchDocuments(searcher, { query: "周报", limit: 2, onlyTitle: true, docTypes: ["DOCX"] });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], { query: "周报", limit: 2, onlyTitle: true, docTypes: ["DOCX"] });
	assert.deepEqual(result.hits.map((hit) => hit.title), ["一", "二"]);
	assert.equal(result.hasMore, true);
	assert.equal(result.total, 3);
});
