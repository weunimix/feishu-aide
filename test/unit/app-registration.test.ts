import assert from "node:assert/strict";
import test from "node:test";
import { pollAppRegistration, startAppRegistration, AppRegistrationError } from "../../src/core/app-registration.js";

const ENDPOINTS = { accounts: "https://accounts.test", open: "https://open.test" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchWith(responder: (url: string, form: URLSearchParams) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    return responder(String(input), form);
  }) as typeof fetch;
}

test("发起注册：发送 begin 表单并解析用户码", async () => {
  const seen: { url?: string; form?: URLSearchParams } = {};
  const fetchImpl = fetchWith((url, form) => {
    seen.url = url;
    seen.form = form;
    return jsonResponse({
      device_code: "dc-1",
      user_code: "UC-1",
      verification_uri: "https://reg.test/verify",
      verification_uri_complete: "https://reg.test/verify?user_code=UC-1",
      expires_in: 3600,
      interval: 5,
    });
  });

  const challenge = await startAppRegistration(ENDPOINTS, fetchImpl);

  assert.equal(seen.url, "https://accounts.test/oauth/v1/app/registration");
  assert.equal(seen.form?.get("action"), "begin");
  assert.equal(seen.form?.get("archetype"), "PersonalAgent");
  assert.equal(seen.form?.get("auth_method"), "client_secret");
  assert.equal(challenge.deviceCode, "dc-1");
  assert.equal(challenge.userCode, "UC-1");
  assert.equal(challenge.verificationUriComplete, "https://reg.test/verify?user_code=UC-1");
  assert.equal(challenge.interval, 5);
});

test("发起注册：缺字段时报无效响应", async () => {
  const fetchImpl = fetchWith(() => jsonResponse({ user_code: "UC-1" }));
  await assert.rejects(
    () => startAppRegistration(ENDPOINTS, fetchImpl),
    (error: unknown) => error instanceof AppRegistrationError && error.code === "invalid_response"
  );
});

test("发起注册：业务错误码原样抛出", async () => {
  const fetchImpl = fetchWith(() => jsonResponse({ error: "invalid_client", error_description: "bad" }, 400));
  await assert.rejects(
    () => startAppRegistration(ENDPOINTS, fetchImpl),
    (error: unknown) => error instanceof AppRegistrationError && error.code === "invalid_client"
  );
});

test("轮询注册：authorization_pending 是待确认，不是失败", async () => {
  const fetchImpl = fetchWith((_url, form) => {
    assert.equal(form.get("action"), "poll");
    assert.equal(form.get("device_code"), "dc-1");
    return jsonResponse({ error: "authorization_pending", error_description: "", code: 20094 }, 400);
  });

  assert.deepEqual(await pollAppRegistration(ENDPOINTS, "dc-1", fetchImpl), { status: "pending" });
});

test("轮询注册：确认后返回应用凭据", async () => {
  const fetchImpl = fetchWith(() =>
    jsonResponse({
      client_id: "cli_abc",
      client_secret: "secret-abc",
      user_info: { open_id: "ou_1", tenant_brand: "feishu" },
    })
  );

  const polled = await pollAppRegistration(ENDPOINTS, "dc-1", fetchImpl);
  assert.equal(polled.status, "registered");
  if (polled.status !== "registered") return;
  assert.equal(polled.app.appId, "cli_abc");
  assert.equal(polled.app.appSecret, "secret-abc");
  assert.equal(polled.app.openId, "ou_1");
  assert.equal(polled.app.tenantBrand, "feishu");
});

test("轮询注册：缺凭据时报无效响应", async () => {
  const fetchImpl = fetchWith(() => jsonResponse({ client_id: "cli_abc" }));
  await assert.rejects(
    () => pollAppRegistration(ENDPOINTS, "dc-1", fetchImpl),
    (error: unknown) => error instanceof AppRegistrationError && error.code === "invalid_response"
  );
});
