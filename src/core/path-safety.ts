import path from "node:path";

/**
 * Long enough for a readable Chinese title, short enough to leave room for a
 * file extension and for Windows' 260-character legacy path limit when the
 * cache root is not deeply nested.
 */
export const MAX_SEGMENT_LENGTH = 120;

// Windows treats these names as devices even when an extension follows, so
// "CON.md" is still unusable. The trailing group also catches "CON.txt".
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_INVALID_CHARACTERS = /[<>:"/\\|?*]/g;
const HAS_WINDOWS_INVALID_CHARACTER = /[<>:"/\\|?*]/;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/;

/**
 * Turn an untrusted document title into one safe path segment.
 *
 * This is deliberately lossy: separators and Windows-invalid characters become
 * "-", trailing dots/spaces (silently stripped by Windows) are removed, and
 * reserved device names are prefixed. The caller is expected to add a stable
 * id when two titles sanitize to the same value.
 */
export function sanitizeSegment(input: string): string {
  let segment = input.normalize("NFC");
  segment = segment.replace(CONTROL_CHARACTERS, "-");
  segment = segment.replace(WINDOWS_INVALID_CHARACTERS, "-");
  segment = segment.replace(/\s+/g, " ").trim();
  segment = segment.replace(TRAILING_DOTS_OR_SPACES, "");

  if (segment.length > MAX_SEGMENT_LENGTH) {
    segment = segment.slice(0, MAX_SEGMENT_LENGTH).replace(TRAILING_DOTS_OR_SPACES, "");
  }

  if (segment === "" || segment === "." || segment === "..") {
    segment = "untitled";
  }
  if (WINDOWS_RESERVED_NAME.test(segment)) {
    segment = `_${segment}`;
  }

  return segment;
}

/**
 * Join path segments under `root` and refuse anything that could leave it.
 *
 * The segments are validated as single, portable path components: no dot
 * segments, separators, drive prefixes, NUL bytes, trailing dots/spaces, or
 * Windows device names. The final resolve/relative check is the backstop for
 * platform-specific path semantics.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  if (segments.length === 0) {
    throw new Error("safeJoin requires at least one path segment");
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error("path segments must not be empty");
    }
    if (segment === "." || segment === "..") {
      throw new Error(`path segment must not be a dot segment: ${segment}`);
    }
    if (segment.includes("\0")) {
      throw new Error("path segment must not contain a NUL byte");
    }
    if (/[/\\]/.test(segment)) {
      throw new Error(`path segment must not contain a separator: ${segment}`);
    }
    if (path.isAbsolute(segment) || /^[A-Za-z]:/.test(segment)) {
      throw new Error(`path segment must be relative: ${segment}`);
    }
    if (HAS_WINDOWS_INVALID_CHARACTER.test(segment)) {
      throw new Error(`path segment contains a Windows-invalid character: ${segment}`);
    }
    if (TRAILING_DOTS_OR_SPACES.test(segment)) {
      throw new Error(`path segment must not end with a dot or space: ${segment}`);
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error(`path segment is a Windows reserved name: ${segment}`);
    }
  }

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);

  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`path escapes the root: ${target}`);
  }

  return target;
}
