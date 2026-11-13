import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { MAX_SEGMENT_LENGTH, safeJoin, sanitizeSegment } from "../../src/core/path-safety.js";

const ROOT = path.join(process.cwd(), "cache");

test("keeps ordinary titles unchanged", () => {
  assert.equal(sanitizeSegment("设计文档"), "设计文档");
  assert.equal(sanitizeSegment("API Guide"), "API Guide");
});

test("replaces separators and Windows-invalid characters", () => {
  assert.equal(sanitizeSegment("a/b\\c"), "a-b-c");
  assert.equal(sanitizeSegment('a<b>c:d"e|f?g*h'), "a-b-c-d-e-f-g-h");
});

test("replaces control characters", () => {
  assert.equal(sanitizeSegment("a\u0000b\u001fc"), "a-b-c");
});

test("collapses whitespace and strips trailing dots and spaces", () => {
  assert.equal(sanitizeSegment("a   b"), "a b");
  assert.equal(sanitizeSegment("name. . "), "name");
});

test("escapes Windows reserved device names", () => {
  for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
    assert.equal(sanitizeSegment(name), `_${name}`);
  }
  assert.equal(sanitizeSegment("con.md"), "_con.md");
});

test("falls back to untitled for empty and dot-only values", () => {
  for (const value of ["", " ", ".", "..", "...", "   . "]) {
    assert.equal(sanitizeSegment(value), "untitled");
  }
});

test("caps an over-long segment without leaving a trailing dot", () => {
  const result = sanitizeSegment("a".repeat(200));
  assert.equal(result.length, MAX_SEGMENT_LENGTH);
  assert.equal(result, "a".repeat(MAX_SEGMENT_LENGTH));
});

test("joins safe nested segments", () => {
  assert.equal(
    safeJoin(ROOT, "wiki", "space", "doc.md"),
    path.join(ROOT, "wiki", "space", "doc.md")
  );
});

test("rejects dot segments", () => {
  assert.throws(() => safeJoin(ROOT, ".."), /dot segment/);
  assert.throws(() => safeJoin(ROOT, "."), /dot segment/);
});

test("rejects separators inside a segment", () => {
  assert.throws(() => safeJoin(ROOT, "a/b"), /separator/);
  assert.throws(() => safeJoin(ROOT, "a\\b"), /separator/);
});

test("rejects absolute and drive-prefixed segments", () => {
  assert.throws(() => safeJoin(ROOT, path.resolve(ROOT, "outside")), /separator|relative/);
  assert.throws(() => safeJoin(ROOT, "C:evil"), /relative|invalid/);
});

test("rejects empty and NUL-containing segments", () => {
  assert.throws(() => safeJoin(ROOT), /at least one/);
  assert.throws(() => safeJoin(ROOT, ""), /must not be empty/);
  assert.throws(() => safeJoin(ROOT, "a\0b"), /NUL/);
});

test("rejects Windows-invalid characters, trailing dots, and reserved names", () => {
  assert.throws(() => safeJoin(ROOT, "a:b"), /relative|invalid/);
  assert.throws(() => safeJoin(ROOT, "name."), /dot or space/);
  assert.throws(() => safeJoin(ROOT, "CON"), /reserved/);
});
