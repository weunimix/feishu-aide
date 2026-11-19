import * as lark from "@larksuiteoapi/node-sdk";
import type { Domain } from "./device-flow.js";
import { unwrap } from "./feishu-json.js";
import type { MessageQuery, MessageReader, RawMessagePage } from "./messages.js";

/** 会话消息的 SDK 适配层：只负责取原始条目，归一化在 `messages.ts`。 */

export interface MessageReaderOptions {
  appId: string;
  appSecret: string;
  domain: Domain;
  userAccessToken: () => Promise<string>;
  /** 测试注入用：把 SDK 指向本地 fake server。 */
  domainOverride?: string;
}

export function createSdkMessageReader(options: MessageReaderOptions): MessageReader {
  const client = new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domainOverride ?? (options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu),
    loggerLevel: lark.LoggerLevel.warn,
  });

  return {
    async listMessages(query: MessageQuery): Promise<RawMessagePage> {
      const token = await options.userAccessToken();
      const data = unwrap(
        await client.im.message.list(
          {
            params: {
              container_id_type: "chat",
              container_id: query.chatId,
              page_size: query.limit,
              sort_type: "ByCreateTimeAsc",
              with_sender_name: true,
              ...(query.startTime === undefined ? {} : { start_time: String(query.startTime) }),
              ...(query.endTime === undefined ? {} : { end_time: String(query.endTime) }),
            },
          },
          lark.withUserAccessToken(token)
        )
      );

      const items = Array.isArray(data.items) ? data.items : [];
      const page: RawMessagePage = { items, hasMore: data.has_more === true };
      if (typeof data.page_token === "string") page.pageToken = data.page_token;
      return page;
    },
  };
}
