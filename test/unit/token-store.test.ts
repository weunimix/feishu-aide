import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTokenStore } from "../../src/core/token-store.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "feishu-aide-test-"));
}

test("写入后可读回，落盘内容与令牌一致", async () => {
  const dir = await tempDir();
  try {
    const store = new FileTokenStore(dir);
    await store.save({ accessToken: "at", refreshToken: "rt", expiresAt: 1234, scope: "docx:document" });

    const token = await store.load();
    assert.deepEqual(token, {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1234,
      scope: "docx:document",
    });

    const raw = await readFile(path.join(dir, "tokens.json"), "utf8");
    assert.match(raw, /"accessToken": "at"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有文件时返回 null", async () => {
  const dir = await tempDir();
  try {
    assert.equal(await new FileTokenStore(dir).load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文件损坏按未授权处理", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "tokens.json"), "{ 不是 JSON", "utf8");
    assert.equal(await new FileTokenStore(dir).load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clear 之后回到未授权", async () => {
  const dir = await tempDir();
  try {
    const store = new FileTokenStore(dir);
    await store.save({ accessToken: "at", expiresAt: Date.now() + 1000 });
    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("并发保存不会留下半截 JSON", async () => {
  const dir = await tempDir();
  try {
    const store = new FileTokenStore(dir);
    await Promise.all([
      store.save({ accessToken: "a1", expiresAt: 1 }),
      store.save({ accessToken: "a2", expiresAt: 2 }),
      store.save({ accessToken: "a3", expiresAt: 3 }),
    ]);
    const raw = await readFile(path.join(dir, "tokens.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal((await store.load())?.accessToken, "a3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 这条只守临时文件残留：save 用完 tmp 后目录里只剩 tokens.json；
// 它不证明 tmp+rename 的原子替换语义（那需要注入 rename 失败，当前没有覆盖）。
test("保存后不留临时文件", async () => {
  const dir = await tempDir();
  try {
    await new FileTokenStore(dir).save({ accessToken: "at", expiresAt: Date.now() + 1000 });
    assert.deepEqual(await readdir(dir), ["tokens.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 权限位在 Windows 上不适用（stat 不反映 ACL），显式跳过而不是断言一个假值。
test("POSIX 上令牌文件权限为 0600", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  try {
    await new FileTokenStore(dir).save({ accessToken: "at", expiresAt: Date.now() + 1000 });
    assert.equal(((await stat(path.join(dir, "tokens.json"))).mode & 0o777).toString(8), "600");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POSIX 上覆盖已有的宽松权限文件后仍是 0600", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "tokens.json");
    await writeFile(file, '{"accessToken":"old","expiresAt":1}', "utf8");
    // tmp + rename 会替换 inode；先显式放宽到 0644，确认替换后不带回旧权限。
    await chmod(file, 0o644);
    assert.equal(((await stat(file)).mode & 0o777).toString(8), "644");

    await new FileTokenStore(dir).save({ accessToken: "new", expiresAt: Date.now() + 1000 });
    assert.equal(((await stat(file)).mode & 0o777).toString(8), "600");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
