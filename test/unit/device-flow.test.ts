import assert from "node:assert/strict";
import test from "node:test";
import {
  FeishuOAuthError,
  isExpired,
  pollDeviceFlow,
  refreshAccessToken,
  startDeviceFlow,
  waitForDeviceFlow,
  type DeviceChallenge,
  type DeviceFlowEnv,
  type TokenSet,
} from "../../src/core/device-flow.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function envWith(responder: (call: Call) => Response): { env: DeviceFlowEnv; calls: Call[] } {
  const calls: Call[] = [];
  const env: DeviceFlowEnv = {
    appId: "cli_test",
    appSecret: "secret",
    endpoints: { accounts: "https://accounts.test", open: "https://open.test" },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        authorization: headers.Authorization ?? headers.authorization ?? null,
      };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  };
  return { env, calls };
}

const challenge: DeviceChallenge = {
  deviceCode: "dev-1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://accounts.test/verify",
  expiresIn: 600,
  interval: 1,
};

test("发起授权时带上 client_id 与 Basic 认证", async () => {
  const { env, calls } = envWith(() =>
    jsonResponse({
      device_code: "dev-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://accounts.test/verify",
      expires_in: 600,
      interval: 5,
    })
  );

  const result = await startDeviceFlow(env, { scope: "docx:document" });
  assert.equal(result.userCode, "ABCD-EFGH");
  assert.equal(result.interval, 5);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.url, "https://accounts.test/oauth/v1/device_authorization");
  assert.equal(first.body.client_id, "cli_test");
  assert.equal(first.body.scope, "docx:document");
  assert.match(first.authorization ?? "", /^Basic /);
});

test("轮询把 authorization_pending 映射为 pending", async () => {
  const { env } = envWith(() => jsonResponse({ error: "authorization_pending", error_description: "等待" }));
  const result = await pollDeviceFlow(env, challenge, 5);
  assert.deepEqual(result, { status: "pending" });
});

test("轮询把 slow_down 映射为更长的间隔", async () => {
  const { env } = envWith(() => jsonResponse({ error: "slow_down", error_description: "慢点" }));
  const result = await pollDeviceFlow(env, challenge, 5);
  assert.deepEqual(result, { status: "slow_down", interval: 10 });
});

test("access_denied 抛不可重试错误", async () => {
  const { env } = envWith(() => jsonResponse({ error: "access_denied", error_description: "拒绝" }));
  await assert.rejects(pollDeviceFlow(env, challenge, 5), (error: unknown) => {
    return error instanceof FeishuOAuthError && error.code === "access_denied" && error.retryable === false;
  });
});

test("轮询到 token 时换算成毫秒过期时间", async () => {
  const { env } = envWith(() =>
    jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "docx:document" })
  );
  const result = await pollDeviceFlow(env, challenge, 5);
  assert.equal(result.status, "done");
  if (result.status !== "done") return;
  assert.equal(result.token.accessToken, "at-1");
  assert.equal(result.token.refreshToken, "rt-1");
  assert.ok(result.token.expiresAt > Date.now());
});

test("waitForDeviceFlow 先 pending 后完成", async () => {
  let attempt = 0;
  const { env } = envWith(() => {
    attempt += 1;
    if (attempt === 1) return jsonResponse({ error: "authorization_pending", error_description: "等待" });
    return jsonResponse({ access_token: "at-2", expires_in: 60 });
  });

  const sleeps: number[] = [];
  const token = await waitForDeviceFlow(env, challenge, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(token.accessToken, "at-2");
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("waitForDeviceFlow 超时抛 expired_token", async () => {
  const { env } = envWith(() => jsonResponse({ error: "authorization_pending", error_description: "等待" }));
  await assert.rejects(
    waitForDeviceFlow(env, challenge, { sleep: async () => {}, timeoutMs: 0 }),
    (error: unknown) => error instanceof FeishuOAuthError && error.code === "expired_token"
  );
});

test("refresh 用 refresh_token 换新令牌并轮换 refresh token", async () => {
  const { env, calls } = envWith(() =>
    jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 })
  );
  const token: TokenSet = await refreshAccessToken(env, "rt-old");
  assert.equal(token.accessToken, "at-new");
  assert.equal(token.refreshToken, "rt-new");
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.body.grant_type, "refresh_token");
  assert.equal(first.body.refresh_token, "rt-old");
});

test("isExpired 提前 60 秒判定过期", () => {
  const now = Date.now();
  assert.equal(isExpired({ accessToken: "a", expiresAt: now + 120_000 }, now), false);
  assert.equal(isExpired({ accessToken: "a", expiresAt: now + 30_000 }, now), true);
});
