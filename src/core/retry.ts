/**
 * 飞书接口的限流重试。
 *
 * 只重试「再来一次有机会成功」的失败：HTTP 429（限流）、HTTP 503（上游暂不可用），
 * 以及业务码 99991400（单应用 3 次/秒）。其余错误立即上抛，避免把真正的失败
 * 拖成超时，也避免把权限错误、参数错误重试到用户失去耐心。
 *
 * 退避时长优先取响应的 `Retry-After`，缺失时按指数退避，两者都受 `maxDelayMs` 约束。
 */

export interface RetryOptions {
  /** 总尝试次数，含第一次；默认 3。 */
  attempts?: number;
  /** 指数退避的基数，默认 500ms。 */
  baseDelayMs?: number;
  /** 单次等待上限，默认 10s。 */
  maxDelayMs?: number;
  /** 测试注入用，默认 `setTimeout`。 */
  sleep?: (delayMs: number) => Promise<void>;
}

export const RATE_LIMIT_CODE = 99991400;

const RETRYABLE_STATUS = new Set([429, 503]);
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;

interface ErrorResponse {
  status?: unknown;
  headers?: unknown;
  data?: unknown;
}

function responseOf(error: unknown): ErrorResponse | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  return response as ErrorResponse;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
    return undefined;
  }
  return undefined;
}

/** `Retry-After` 允许是秒数或 HTTP 日期；解析失败返回 null（退回指数退避）。 */
function parseRetryAfter(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000);
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - Date.now());
}

function businessCodeOf(data: unknown): unknown {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  return (data as { code?: unknown }).code;
}

/**
 * 判断一次失败值不值得重试，值得则返回要等待的毫秒数，不值得返回 null。
 * `attempt` 从 0 开始，只用于指数退避。
 */
export function retryDelayMs(error: unknown, attempt: number, options: RetryOptions = {}): number | null {
  const response = responseOf(error);
  if (response === undefined) {
    return null;
  }
  const status = typeof response.status === "number" ? response.status : undefined;
  const retryable = (status !== undefined && RETRYABLE_STATUS.has(status)) || businessCodeOf(response.data) === RATE_LIMIT_CODE;
  if (!retryable) {
    return null;
  }

  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryAfter = parseRetryAfter(headerOf(response.headers, "retry-after"));
  if (retryAfter !== null) {
    return Math.min(retryAfter, maxDelayMs);
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** 按 `retryDelayMs` 的判定重试；最后一次失败原样抛出，不包装、不改写错误信息。 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= attempts) {
        throw error;
      }
      const delayMs = retryDelayMs(error, attempt, options);
      if (delayMs === null) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}
