import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileAppCredentialStore } from "../../src/core/app-credentials.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "feishu-aide-app-credentials-"));
}

test("应用凭据写入后可读回，clear 后回到空", async () => {
  const dir = await tempDir();
  try {
    const store = new FileAppCredentialStore(dir);
    await store.save({ appId: "cli_test", appSecret: "secret" });
    assert.deepEqual(await store.load(), { appId: "cli_test", appSecret: "secret" });

    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文件损坏按没有凭据处理", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "app.json"), "{ 不是 JSON", "utf8");
    assert.equal(await new FileAppCredentialStore(dir).load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 权限位在 Windows 上不适用（stat 不反映 ACL），显式跳过而不是断言一个假值。
test("POSIX 上应用凭据文件权限为 0600", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  try {
    await new FileAppCredentialStore(dir).save({ appId: "cli_test", appSecret: "secret" });
    assert.equal(((await stat(path.join(dir, "app.json"))).mode & 0o777).toString(8), "600");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
