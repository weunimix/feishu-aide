/**
 * SDK 的错误翻译。
 *
 * 飞书把权限不足、参数非法等业务失败包装成 HTTP 4xx，axios 只留下
 * 「Request failed with status code 400」，真正的 `code` / `msg` 在响应体里。
 * 业务码才是能行动的信息（例如 `230027` + "need scope: im:message.p2p_msg:get_as_user"），
 * 所以在适配层边界把响应体还原成错误消息，不让它丢在路上。
 */

/** 与 axios 的错误结构对齐；只读需要的字段，避免依赖 axios 的类型。 */
interface HttpLikeError {
  response?: {
    status?: number;
    data?: unknown;
  };
}

export function toUserFacingError(error: unknown): Error {
  const response = (error as HttpLikeError | null)?.response;
  const data = response?.data;
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code : Number(record.code);
    const msg = typeof record.msg === "string" ? record.msg : "";
    if (Number.isFinite(code) && code !== 0 && msg.length > 0) {
      return new Error(`飞书接口错误（code=${code}）：${msg}`);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 包住一次 SDK 调用：重试与限流判断仍看原始错误，抛给上层的才是可读消息。 */
export async function guardSdkCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toUserFacingError(error);
  }
}
