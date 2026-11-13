import assert from "node:assert/strict";
import test from "node:test";
import { checkTrackedPath, scanText } from "./check-secrets.mjs";

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const AWS_KEY = `AKIA${"1234567890ABCDEF"}`;
const APP_SECRET = `0123456789${"abcdef"}`;
const FEISHU_TOKEN = `t-${"a".repeat(24)}`;
const BEARER = `Bearer ${"a".repeat(24)}`;
const PRIVATE_KEY = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

function rules(text) {
  return scanText(text).map((finding) => finding.rule);
}

test("detects a GitHub token", () => {
  assert.deepEqual(rules(`token=${GITHUB_TOKEN}`), ["github-token"]);
});

test("detects an AWS access key", () => {
  assert.deepEqual(rules(`key=${AWS_KEY}`), ["aws-access-key"]);
});

test("detects an assigned Feishu app secret", () => {
  assert.deepEqual(rules(`FEISHU_APP_SECRET=${APP_SECRET}`), ["feishu-app-secret"]);
});

test("detects a Feishu access token", () => {
  assert.deepEqual(rules(`tenant_access_token: "${FEISHU_TOKEN}"`), ["feishu-access-token"]);
});

test("detects a bearer token", () => {
  assert.deepEqual(rules(`Authorization: ${BEARER}`), ["bearer-token"]);
});

test("detects a private key header", () => {
  assert.deepEqual(rules(PRIVATE_KEY), ["private-key"]);
});

test("does not flag placeholders or environment variable reads", () => {
  const text = [
    "FEISHU_APP_SECRET=replace-me",
    "app_secret: process.env.FEISHU_APP_SECRET",
    'tenant_access_token: "<token>"',
    "Authorization: Bearer <token>",
    "app_id: cli_a1b2c3d4e5f6g7h8",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("reports the line of each finding", () => {
  const findings = scanText(`clean line\nFEISHU_APP_SECRET=${APP_SECRET}\nclean line`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 2);
});

test("rejects local env files, private keys, and local caches", () => {
  assert.equal(checkTrackedPath(".env"), "env-file");
  assert.equal(checkTrackedPath("config/.env.local"), "env-file");
  assert.equal(checkTrackedPath("keys/server.pem"), "private-key-file");
  assert.equal(checkTrackedPath("keys/server.key"), "private-key-file");
  assert.equal(checkTrackedPath("cache/index.db"), "local-cache");
  assert.equal(checkTrackedPath("cache/index.db-wal"), "local-cache");
});

test("allows the documented env template", () => {
  assert.equal(checkTrackedPath(".env.example"), null);
  assert.equal(checkTrackedPath("docs/.env.example"), null);
  assert.equal(checkTrackedPath(".env.sample"), null);
});
