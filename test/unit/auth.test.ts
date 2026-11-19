import assert from "node:assert/strict";
import test from "node:test";
import { AuthManager } from "../../src/core/auth.js";
import type { DeviceFlowEnv } from "../../src/core/device-flow.js";
import { MemoryTokenStore } from "../../src/core/token-store.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envWith(responder: () => Response): DeviceFlowEnv {
  return {
    appId: "cli_test",
    appSecret: "secret",
    endpoints: { accounts: "https://accounts.test", open: "https://open.test" },
    fetchImpl: (async () => responder()) as typeof fetch,
  };
}

test("没有令牌时报未授权", async () => {
  const store = new MemoryTokenStore();
  const auth = new AuthManager(envWith(() => jsonResponse({})), store);
  assert.deepEqual(await auth.status(), { authorized: false });
  await assert.rejects(auth.getAccessToken(), /尚未授权/);
});

test("令牌未过期时直接返回，不发请求", async () => {
  const store = new MemoryTokenStore();
  let calls = 0;
  const auth = new AuthManager(
    envWith(() => {
      calls += 1;
      return jsonResponse({});
    }),
    store
  );
  await store.save({ accessToken: "at", expiresAt: Date.now() + 3_600_000 });

  assert.equal(await auth.getAccessToken(), "at");
  assert.equal(calls, 0);
  assert.deepEqual(await auth.status(), {
    authorized: true,
    expiresAt: (await store.load())?.expiresAt,
  });
});

test("令牌过期时用 refresh token 换新并落盘", async () => {
  const store = new MemoryTokenStore();
  await store.save({
    accessToken: "old",
    refreshToken: "rt",
    expiresAt: Date.now() - 1000,
  });

  const auth = new AuthManager(
    envWith(() => jsonResponse({ access_token: "new", refresh_token: "rt2", expires_in: 3600 })),
    store
  );

  assert.equal(await auth.getAccessToken(), "new");
  const saved = await store.load();
  assert.equal(saved?.accessToken, "new");
  assert.equal(saved?.refreshToken, "rt2");
});

test("并发取令牌只刷新一次", async () => {
  const store = new MemoryTokenStore();
  await store.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  let calls = 0;
  const auth = new AuthManager(
    envWith(() => {
      calls += 1;
      return jsonResponse({ access_token: "new", refresh_token: "rt2", expires_in: 3600 });
    }),
    store
  );

  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ["new", "new", "new"]);
  assert.equal(calls, 1);
});

test("刷新失败即清空授权，要求重新登录", async () => {
  const store = new MemoryTokenStore();
  await store.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  const auth = new AuthManager(envWith(() => jsonResponse({ error: "invalid_grant" }, 400)), store);

  await assert.rejects(auth.getAccessToken());
  assert.equal(await store.load(), null);
});
