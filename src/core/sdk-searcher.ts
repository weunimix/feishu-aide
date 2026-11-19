import * as lark from "@larksuiteoapi/node-sdk";
import type { Domain } from "./device-flow.js";
import { unwrap } from "./feishu-json.js";
import { withRetry } from "./retry.js";
import { toHits } from "./search.js";
import type { DocSearcher, SearchQuery, SearchResult } from "./search.js";

/** 文档搜索的 SDK 适配层，与 `sdk-reader` 分开，避免读路径互相牵连。 */

export interface SearcherOptions {
  appId: string;
  appSecret: string;
  domain: Domain;
  userAccessToken: () => Promise<string>;
  /** 测试注入用：把 SDK 指向本地 fake server。 */
  domainOverride?: string;
}

const DOC_TYPES = [
  "DOC",
  "DOCX",
  "SHEET",
  "BITABLE",
  "MINDNOTE",
  "FILE",
  "WIKI",
  "FOLDER",
  "CATALOG",
  "SLIDES",
  "SHORTCUT",
] as const;

type DocType = (typeof DOC_TYPES)[number];

function asDocTypes(values: readonly string[] | undefined): DocType[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const result = values.filter((value): value is DocType => (DOC_TYPES as readonly string[]).includes(value));
  return result.length > 0 ? result : undefined;
}

export function createSdkSearcher(options: SearcherOptions): DocSearcher {
  const client = new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domainOverride ?? (options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu),
    loggerLevel: lark.LoggerLevel.fatal,
  });

  return {
    async search(query: SearchQuery): Promise<SearchResult> {
      const token = await options.userAccessToken();
      const docTypes = asDocTypes(query.docTypes);
      const data = unwrap(
        await withRetry(() =>
          client.search.v2.docWiki.search(
            {
              data: {
                query: query.query,
                page_size: query.limit,
                doc_filter: {
                  only_title: query.onlyTitle,
                  ...(docTypes === undefined ? {} : { doc_types: docTypes }),
                },
              },
            },
            lark.withUserAccessToken(token)
          )
        )
      );
      const units = Array.isArray(data.res_units) ? data.res_units : [];
      const result: SearchResult = {
        hits: toHits(units),
        hasMore: data.has_more === true,
      };
      if (typeof data.total === "number") result.total = data.total;
      if (typeof data.page_token === "string") result.pageToken = data.page_token;
      return result;
    },
  };
}
