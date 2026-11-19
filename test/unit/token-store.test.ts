import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
