import assert from "node:assert/strict";
import test from "node:test";
import { guardSdkCall, toUserFacingError } from "../../src/core/sdk-error.js";

function axiosLike(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

test("把 HTTP 400 里的业务码还原成可读消息", () => {
  const error = toUserFacingError(
    axiosLike(400, {
      code: 230027,
      msg: "Lack of necessary permissions, ext=need scope: im:message.p2p_msg:get_as_user",
    })
  );
  assert.match(error.message, /code=230027/);
  assert.match(error.message, /im:message\.p2p_msg:get_as_user/);
  assert.ok(!error.message.includes("status code 400"));
});

test("code 为 0 或没有响应体时保留原错误", () => {
  const success = axiosLike(200, { code: 0, msg: "" });
  assert.equal(toUserFacingError(success), success);

  const network = new Error("socket hang up");
  assert.equal(toUserFacingError(network), network);
});

test("非 Error 值也能转成 Error", () => {
  assert.equal(toUserFacingError("boom").message, "boom");
});

test("guardSdkCall 只翻译抛出的错误，不改变成功结果", async () => {
  assert.equal(await guardSdkCall(async () => 42), 42);

  await assert.rejects(
    () =>
      guardSdkCall(async () => {
        throw axiosLike(400, { code: 230027, msg: "need scope: im:message.group_msg:get_as_user" });
      }),
    (error: unknown) => {
      assert.match((error as Error).message, /code=230027/);
      return true;
    }
  );
});
