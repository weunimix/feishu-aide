import assert from "node:assert/strict";
import test from "node:test";
import { checkReadmeVersion, checkTagVersion, versionsInReadme } from "./check-release-version.mjs";

const INSTALL = "https://github.com/weunimix/feishu-aide/releases/download/v0.2.2/feishu-aide-0.2.2.tgz";

test("从 README 取出安装地址", () => {
  const readme = ["dsh plugin --profile desktop add \\", `  ${INSTALL} \\`, "  --allow-build=protobufjs"].join("\n");
  assert.deepEqual(versionsInReadme(readme), [{ tag: "0.2.2", file: "feishu-aide-0.2.2.tgz" }]);
});

test("安装地址与版本一致时通过", () => {
  assert.deepEqual(checkReadmeVersion({ readme: INSTALL, version: "0.2.2" }), []);
});

test("README 落后于 package.json 时报错", () => {
  const problems = checkReadmeVersion({ readme: INSTALL, version: "0.2.3" });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => problem.includes("tag 是 v0.2.2")));
  assert.ok(problems.some((problem) => problem.includes("feishu-aide-0.2.2.tgz")));
});

test("多个安装地址必须全部对齐", () => {
  const stale = "https://github.com/weunimix/feishu-aide/releases/download/v0.2.1/feishu-aide-0.2.1.tgz";
  const problems = checkReadmeVersion({ readme: `${INSTALL}\n${stale}`, version: "0.2.2" });
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => problem.includes("0.2.1")));
});

test("README 没有安装地址时报错", () => {
  const problems = checkReadmeVersion({ readme: "没有安装说明", version: "0.2.2" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /没有 Releases 安装地址/);
});

test("tag 与版本一致时通过", () => {
  assert.deepEqual(checkTagVersion({ tag: "v0.2.2", version: "0.2.2" }), []);
});

test("tag 格式不对时拒绝", () => {
  for (const tag of ["0.2.2", "v0.2", "release-v0.2.2", "v0.2.2-rc.1", ""]) {
    const problems = checkTagVersion({ tag, version: "0.2.2" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /必须形如 v0\.2\.2/);
  }
});

test("tag 与 package.json 不一致时拒绝", () => {
  const problems = checkTagVersion({ tag: "v0.2.1", version: "0.2.2" });
  assert.deepEqual(problems, ["tag v0.2.1 与 package.json 的 0.2.2 不一致"]);
});
