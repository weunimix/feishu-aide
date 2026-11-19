import assert from "node:assert/strict";
import test from "node:test";
import { RATE_LIMIT_CODE, retryDelayMs, withRetry } from "../../src/core/retry.js";

function httpError(
  status: number,
  init: { headers?: Record<string, string>; data?: unknown } = {}
): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: {
      status,
      headers: init.headers ?? {},
      data: init.data,
    },
  });
}

test("429 优先按 Retry-After 的秒数等待", () => {
  assert.equal(retryDelayMs(httpError(429, { headers: { "retry-after": "2" } }), 0), 2000);
});

test("Retry-After 允许 HTTP 日期形式", () => {
  const at = new Date(Date.now() + 5000);
  const delay = retryDelayMs(httpError(429, { headers: { "retry-after": at.toUTCString() } }), 0);
  assert.ok(delay !== null);
  assert.ok(delay >= 4000 && delay <= 5200, `期望约 5s，实际 ${delay}`);
});

test("没有 Retry-After 时按指数退避", () => {
  const error = httpError(429);
  assert.equal(retryDelayMs(error, 0), 500);
  assert.equal(retryDelayMs(error, 1), 1000);
  assert.equal(retryDelayMs(error, 2), 2000);
});

test("退避不会无限增长", () => {
  assert.equal(retryDelayMs(httpError(503), 20), 10_000);
  assert.equal(retryDelayMs(httpError(429, { headers: { "retry-after": "120" } }), 0), 10_000);
});

test("业务码 99991400 同样算限流", () => {
  assert.equal(retryDelayMs(httpError(200, { data: { code: RATE_LIMIT_CODE } }), 0), 500);
});

test("非限流错误不重试", () => {
  assert.equal(retryDelayMs(httpError(400), 0), null);
  assert.equal(retryDelayMs(httpError(404), 0), null);
  assert.equal(retryDelayMs(httpError(200, { data: { code: 1310202 } }), 0), null);
  assert.equal(retryDelayMs(new Error("boom"), 0), null);
});

test("重试成功时返回结果并记录每次等待", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw httpError(429);
      return "ok";
    },
    { sleep: async (ms) => void sleeps.push(ms) }
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("不可重试的错误立刻上抛，不等待", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw httpError(403);
      },
      { sleep: async (ms) => void sleeps.push(ms) }
    ),
    /403/
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("尝试次数用尽后抛出最后一次失败", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw httpError(429);
      },
      { attempts: 2, sleep: async () => undefined }
    ),
    /429/
  );
  assert.equal(calls, 2);
});

test("attempts 为 1 表示完全不重试", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw httpError(429);
      },
      { attempts: 1 }
    )
  );
  assert.equal(calls, 1);
});
