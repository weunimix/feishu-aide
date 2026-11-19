import * as lark from "@larksuiteoapi/node-sdk";
import type { ContactQuery, ContactSearcher, RawContactPage } from "./contacts.js";
import { OFFICIAL_ENDPOINTS, type Domain } from "./device-flow.js";
import { unwrap } from "./feishu-json.js";
import { withRetry } from "./retry.js";
import { guardSdkCall } from "./sdk-error.js";

/**
 * 通讯录搜索的 SDK 适配。
 *
 * `@larksuiteoapi/node-sdk` 1.76 还没有 `contact/v3/users/search` 的方法封装，
 * 这里复用 SDK 的 HTTP 实例（与其它请求共享 UA、超时与错误形态），只补这一条路径。
 */

export interface ContactSearcherOptions {
  domain: Domain;
  userAccessToken: () => Promise<string>;
  /** 测试注入用：把请求指向本地 fake server。 */
  domainOverride?: string;
}

const SEARCH_PATH = "/open-apis/contact/v3/users/search";

export function createSdkContactSearcher(options: ContactSearcherOptions): ContactSearcher {
  const base = options.domainOverride ?? OFFICIAL_ENDPOINTS[options.domain].open;

  return {
    async searchUsers(query: ContactQuery): Promise<RawContactPage> {
      const token = await options.userAccessToken();
      const data = unwrap(
        await guardSdkCall(() =>
          withRetry(() =>
            lark.defaultHttpInstance.request({
              url: `${base}${SEARCH_PATH}`,
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              params: { page_size: query.limit },
              data: { query: query.query },
            })
          )
        )
      );
      const items = Array.isArray(data.items) ? data.items : [];
      const page: RawContactPage = { items, hasMore: data.has_more === true };
      if (typeof data.notice === "string" && data.notice.length > 0) page.notice = data.notice;
      return page;
    },
  };
}
