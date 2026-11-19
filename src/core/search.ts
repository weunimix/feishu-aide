/** 文档搜索：把飞书 Search v2 的命中项归一化成稳定形状，并做输入校验。 */

export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export interface SearchQuery {
	query: string;
	limit: number;
	onlyTitle: boolean;
	docTypes?: string[];
}

export interface SearchHit {
	title: string;
	url?: string;
	token?: string;
	type?: string;
	summary?: string;
	updateTime?: number;
	owner?: string;
}

export interface SearchResult {
	hits: SearchHit[];
	total?: number;
	hasMore: boolean;
	pageToken?: string;
}

export interface DocSearcher {
	search(query: SearchQuery): Promise<SearchResult>;
}

export type SearchErrorCode = "empty_query" | "query_too_long" | "invalid_limit";

export class SearchError extends Error {
	readonly code: SearchErrorCode;

	constructor(code: SearchErrorCode, message: string) {
		super(message);
		this.name = "SearchError";
		this.code = code;
	}
}

/** 校验调用方参数，非法输入在发请求之前就失败。 */
export function normalizeQuery(input: { query?: unknown; limit?: unknown; onlyTitle?: unknown; docTypes?: unknown }): SearchQuery {
	const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
	if (rawQuery.length === 0) {
		throw new SearchError("empty_query", "搜索词不能为空");
	}
	if (rawQuery.length > MAX_QUERY_LENGTH) {
		throw new SearchError("query_too_long", `搜索词不超过 ${MAX_QUERY_LENGTH} 个字符`);
	}

	const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new SearchError("invalid_limit", `limit 必须是 1 到 ${MAX_LIMIT} 之间的整数`);
	}

	const docTypes = Array.isArray(input.docTypes)
		? input.docTypes.filter((value): value is string => typeof value === "string" && value.length > 0)
		: undefined;

	const query: SearchQuery = { query: rawQuery, limit, onlyTitle: input.onlyTitle === true };
	if (docTypes !== undefined && docTypes.length > 0) {
		query.docTypes = docTypes;
	}
	return query;
}

/** 搜索结果是带高亮标签的片段，展示前去掉标签。 */
export function stripHighlight(text: string): string {
	return text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

export function toHits(units: readonly unknown[]): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const unit of units) {
		if (typeof unit !== "object" || unit === null) {
			continue;
		}
		const record = unit as Record<string, unknown>;
		const meta = (typeof record.result_meta === "object" && record.result_meta !== null ? record.result_meta : {}) as Record<string, unknown>;

		const hit: SearchHit = {
			title: typeof record.title_highlighted === "string" ? stripHighlight(record.title_highlighted).trim() : "",
		};
		if (typeof record.summary_highlighted === "string" && record.summary_highlighted.length > 0) {
			hit.summary = stripHighlight(record.summary_highlighted).trim();
		}
		if (typeof meta.url === "string" && meta.url.length > 0) {
			hit.url = meta.url;
		}
		if (typeof meta.token === "string" && meta.token.length > 0) {
			hit.token = meta.token;
		}
		if (typeof meta.doc_types === "string" && meta.doc_types.length > 0) {
			hit.type = meta.doc_types;
		} else if (typeof record.entity_type === "string" && record.entity_type.length > 0) {
			hit.type = record.entity_type;
		}
		if (typeof meta.update_time === "number") {
			hit.updateTime = meta.update_time;
		}
		if (typeof meta.owner_name === "string" && meta.owner_name.length > 0) {
			hit.owner = meta.owner_name;
		}
		if (hit.title.length === 0 && hit.token === undefined) {
			continue;
		}
		hits.push(hit);
	}
	return hits;
}

/** 统一入口：校验 → 交给搜索实现 → 截断到 limit。 */
export async function searchDocuments(searcher: DocSearcher, input: Parameters<typeof normalizeQuery>[0]): Promise<SearchResult> {
	const query = normalizeQuery(input);
	const result = await searcher.search(query);
	return {
		hits: result.hits.slice(0, query.limit),
		...(result.total === undefined ? {} : { total: result.total }),
		hasMore: result.hasMore,
		...(result.pageToken === undefined ? {} : { pageToken: result.pageToken }),
	};
}
