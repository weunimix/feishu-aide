import assert from "node:assert/strict";
import test from "node:test";
import { AuthManager, DEFAULT_SCOPES, type AuthManagerOptions } from "../../src/core/auth.js";
import { MemoryAppCredentialStore } from "../../src/core/app-credentials.js";
import { MemoryTokenStore } from "../../src/core/token-store.js";

const ENDPOINTS = { accounts: "https://accounts.test", open: "https://open.test" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  manager: AuthManager;
  tokens: MemoryTokenStore;
  credentials: MemoryAppCredentialStore;
}

type Responder = (url: string, form: URLSearchParams) => Response;

function makeManager(overrides: Partial<AuthManagerOptions> = {}, responder?: Responder): Harness {
  const { fetchImpl: overrideFetch, ...rest } = overrides;
  const tokens = new MemoryTokenStore();
  const credentials = new MemoryAppCredentialStore();
  const fetchImpl = (
    overrideFetch ??
    (responder
      ? async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          responder(String(input), new URLSearchParams(typeof init?.body === "string" ? init.body : ""))
      : async () => jsonResponse({}))
  ) as typeof fetch;

  const manager = new AuthManager({
    domain: "feishu",
    endpoints: ENDPOINTS,
    mode: "self-hosted",
    configCredentials: { appId: "cli_test", appSecret: "secret" },
    credentials,
    tokens,
    ...rest,
    fetchImpl,
  });
  return { manager, tokens, credentials };
}

test("没有令牌时报未授权", async () => {
  const { manager } = makeManager();
  assert.deepEqual(await manager.status(), { authorized: false });
  await assert.rejects(manager.getAccessToken(), /尚未授权/);
});

test("令牌未过期时直接返回，不发请求", async () => {
  let calls = 0;
  const { manager, tokens } = makeManager({}, () => {
    calls += 1;
    return jsonResponse({});
  });
  const expiresAt = Date.now() + 3_600_000;
  await tokens.save({ accessToken: "at", expiresAt });

  assert.equal(await manager.getAccessToken(), "at");
  assert.equal(calls, 0);
  assert.deepEqual(await manager.status(), { authorized: true, expiresAt });
});

test("令牌过期时用 refresh token 换新并落盘", async () => {
  const { manager, tokens } = makeManager({}, () =>
    jsonResponse({ access_token: "new", refresh_token: "rt2", expires_in: 3600 })
  );
  await tokens.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  assert.equal(await manager.getAccessToken(), "new");
  const saved = await tokens.load();
  assert.equal(saved?.accessToken, "new");
  assert.equal(saved?.refreshToken, "rt2");
});

test("并发取令牌只刷新一次", async () => {
  let calls = 0;
  const { manager, tokens } = makeManager({}, () => {
    calls += 1;
    return jsonResponse({ access_token: "new", refresh_token: "rt2", expires_in: 3600 });
  });
  await tokens.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  const results = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);
  assert.deepEqual(results, ["new", "new", "new"]);
  assert.equal(calls, 1);
});

test("刷新失败即清空授权，要求重新登录", async () => {
  const { manager, tokens } = makeManager({}, () => jsonResponse({ error: "invalid_grant" }, 400));
  await tokens.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  await assert.rejects(manager.getAccessToken());
  assert.equal(await tokens.load(), null);
});

test("登出清空本地令牌", async () => {
  const { manager, tokens } = makeManager();
  await tokens.save({ accessToken: "at", expiresAt: Date.now() + 3_600_000 });

  await manager.logout();
  assert.equal(await tokens.load(), null);
  assert.deepEqual(await manager.status(), { authorized: false });
});

test("刷新期间登出：在途结果不再写回令牌", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async () => {
    entered();
    await gate;
    return jsonResponse({ access_token: "new", refresh_token: "rt2", expires_in: 3600 });
  }) as typeof fetch;

  const { manager, tokens } = makeManager({ fetchImpl });
  await tokens.save({ accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

  const pending = manager.getAccessToken();
  await started;
  await manager.logout();
  release();
  await pending.catch(() => undefined);

  assert.equal(await tokens.load(), null);
});

test("自动模式：没有应用凭据时先返回创建应用的确认地址", async () => {
  const { manager } = makeManager(
    { mode: "auto", configCredentials: { appId: "", appSecret: "" } },
    (url, form) => {
      assert.equal(url, "https://accounts.test/oauth/v1/app/registration");
      assert.equal(form.get("action"), "begin");
      return jsonResponse({
        device_code: "dc-1",
        user_code: "UC-1",
        verification_uri: "https://reg.test/verify",
        expires_in: 3600,
        interval: 5,
      });
    }
  );

  const result = await manager.login();
  assert.equal(result.stage, "register");
  assert.equal(result.userCode, "UC-1");
  assert.equal(result.verificationUri, "https://reg.test/verify");
  assert.deepEqual(await manager.status(), { authorized: false, pending: "register" });
});

test("自动模式：注册还没确认时再调用仍停在 register", async () => {
  const { manager } = makeManager(
    { mode: "auto", configCredentials: { appId: "", appSecret: "" } },
    (_url, form) =>
      form.get("action") === "begin"
        ? jsonResponse({
            device_code: "dc-1",
            user_code: "UC-1",
            verification_uri: "https://reg.test/verify",
            expires_in: 3600,
            interval: 5,
          })
        : jsonResponse({ error: "authorization_pending", code: 20094 }, 400)
  );

  await manager.login();
  const again = await manager.login();
  assert.equal(again.stage, "register");
});

test("自动模式：注册确认后保存凭据并立刻发起用户授权", async () => {
  const { manager, credentials } = makeManager(
    { mode: "auto", configCredentials: { appId: "", appSecret: "" } },
    (url, form) => {
      if (url.endsWith("/oauth/v1/app/registration")) {
        return form.get("action") === "begin"
          ? jsonResponse({
              device_code: "dc-1",
              user_code: "UC-1",
              verification_uri: "https://reg.test/verify",
              expires_in: 3600,
              interval: 5,
            })
          : jsonResponse({ client_id: "cli_auto", client_secret: "secret_auto" });
      }
      assert.equal(url, "https://accounts.test/oauth/v1/device_authorization");
      return jsonResponse({
        device_code: "dev-1",
        user_code: "USER-1",
        verification_uri: "https://auth.test/verify",
        expires_in: 600,
        interval: 5,
      });
    }
  );

  await manager.login();
  const result = await manager.login();

  assert.equal(result.stage, "authorize");
  assert.equal(result.verificationUri, "https://auth.test/verify");
  assert.deepEqual(await credentials.load(), { appId: "cli_auto", appSecret: "secret_auto" });
});

test("授权轮询完成：返回 authorized 并保存令牌", async () => {
  const { manager, tokens } = makeManager({}, (url) => {
    if (url === "https://accounts.test/oauth/v1/device_authorization") {
      return jsonResponse({
        device_code: "dev-1",
        user_code: "USER-1",
        verification_uri: "https://auth.test/verify",
        expires_in: 600,
        interval: 5,
      });
    }
    return jsonResponse({
      access_token: "uat",
      refresh_token: "rt",
      expires_in: 7200,
      scope: "docx:document im:message",
    });
  });

  const first = await manager.login();
  assert.equal(first.stage, "authorize");

  const second = await manager.login();
  assert.equal(second.stage, "authorized");
  assert.equal(second.scope, "docx:document im:message");
  assert.equal((await tokens.load())?.accessToken, "uat");
});

test("self-hosted 模式缺凭据时报可操作错误", async () => {
  const { manager } = makeManager({ mode: "self-hosted", configCredentials: { appId: "", appSecret: "" } });
  await assert.rejects(manager.login(), /auth\.mode=self-hosted/);
  await assert.rejects(manager.getAppCredentials(), /auth\.mode=self-hosted/);
});

test("默认权限包含按会话读单聊与群聊所需的细分权限", () => {
  // 只申请 im:message:readonly 时，读单聊会回 230027 要求细分权限。
  assert.match(DEFAULT_SCOPES, /im:message\.p2p_msg:get_as_user/);
  assert.match(DEFAULT_SCOPES, /im:message\.group_msg:get_as_user/);
  assert.match(DEFAULT_SCOPES, /offline_access/);
  // 需要管理员审批的搜索权限不能混进默认集合，否则用户会卡在一个拿不到的权限上。
  assert.ok(!DEFAULT_SCOPES.includes("search:docs:read"));
});

test("发起授权时把默认权限一起发给飞书", async () => {
  const bodies: Record<string, string>[] = [];
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, string>);
    return jsonResponse({
      device_code: "dev-1",
      user_code: "USER-1",
      verification_uri: "https://auth.test/verify",
      expires_in: 600,
      interval: 5,
    });
  }) as typeof fetch;

  const { manager } = makeManager({ fetchImpl });
  await manager.login();
  assert.equal(bodies[0]?.scope, DEFAULT_SCOPES);
});
