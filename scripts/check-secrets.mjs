#!/usr/bin/env node
/**
 * Fail fast when a tracked file contains a credential-shaped string or a file
 * that must never be committed (local env files, private keys, local caches).
 *
 * This is a heuristic, not a guarantee. It runs before dependency installation
 * so a leaked token fails in seconds instead of after a full build.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const RULES = [
  {
    id: "private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: "aws-access-key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "feishu-app-secret",
    re: /\b(?:FEISHU_APP_SECRET|APP_SECRET|app_secret)\b\s*[:=]\s*["']?[A-Za-z0-9]{16,}["']?/g,
  },
  {
    id: "feishu-access-token",
    re: /\b(?:tenant_access_token|user_access_token|authorization)\b\s*[:=]\s*["']?[tu]-[A-Za-z0-9_-]{20,}["']?/g,
  },
  {
    id: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
];

const FORBIDDEN_ENV_FILE = /^\.env(?:\.|$)/;
const ALLOWED_ENV_FILE = /^\.env\.(?:example|sample)$/;
const PRIVATE_KEY_FILE = /\.(?:pem|key)$/i;
const LOCAL_CACHE_FILE = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i;

/**
 * @param {string} file Repository-relative path, using either separator.
 * @returns {string|null} Rule id when the path must not be committed.
 */
export function checkTrackedPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;

  if (FORBIDDEN_ENV_FILE.test(base) && !ALLOWED_ENV_FILE.test(base)) return "env-file";
  if (PRIVATE_KEY_FILE.test(base)) return "private-key-file";
  if (LOCAL_CACHE_FILE.test(base)) return "local-cache";
  return null;
}

/**
 * @param {string} text
 * @returns {Array<{rule: string, line: number, column: number}>}
 */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(line)) !== null) {
        findings.push({
          rule: rule.id,
          line: index + 1,
          column: match.index + 1,
        });
        if (match[0].length === 0) rule.re.lastIndex += 1;
      }
    }
  }

  return findings;
}

function listTrackedFiles() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: ROOT, encoding: "utf8" }
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ls-files failed; run this from a git checkout: ${detail}`);
  }
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/check-secrets.mjs\n\n" +
        "Scans tracked and untracked (non-ignored) files for credential-shaped\n" +
        "strings and for paths that must never be committed.\n"
    );
    return;
  }

  const files = listTrackedFiles();
  const findings = [];

  for (const file of files) {
    const pathRule = checkTrackedPath(file);
    if (pathRule) findings.push({ file, line: 0, rule: pathRule });

    let buffer;
    try {
      buffer = readFileSync(path.join(ROOT, file));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read ${file}: ${detail}`);
    }

    if (buffer.length > MAX_SCAN_BYTES) {
      console.warn(`secret-scan: skipping ${file} (${buffer.length} bytes > ${MAX_SCAN_BYTES})`);
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) continue;

    const text = buffer.toString("utf8");
    for (const finding of scanText(text)) {
      findings.push({ file, ...finding });
    }
  }

  if (findings.length === 0) {
    console.log(`secret scan: ${files.length} tracked file(s), no findings`);
    return;
  }

  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`${location}: [${finding.rule}]`);
  }
  const affected = new Set(findings.map((finding) => finding.file)).size;
  console.error(`secret scan failed: ${findings.length} finding(s) in ${affected} file(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`secret-scan: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
