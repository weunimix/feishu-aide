/** 飞书 SDK 响应的统一解包：code 非 0 视为失败，其余返回 data（没有 data 时返回整个 body）。 */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

export function unwrap(response: unknown): Json {
  const body = asRecord(response);
  const data = asRecord(body.data);
  if (typeof body.code === "number" && body.code !== 0) {
    const message = typeof body.msg === "string" ? body.msg : "飞书接口返回错误";
    throw new Error(`飞书接口错误（code=${body.code}）：${message}`);
  }
  return Object.keys(data).length > 0 ? data : body;
}
