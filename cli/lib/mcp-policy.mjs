/**
 * Path policy for the MCP server (mcp/notesqr-server.mjs).
 *
 * MCP tool arguments may come from a prompt-injected model, so every local path
 * the server reads (send file_paths, license_path) must resolve inside an
 * allow-listed root and must not touch well-known secret locations.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, parse, relative, resolve, sep } from 'node:path';

export const LICENSE_MAX_BYTES = 64 * 1024;

/** Directory names that are never read (anywhere in the resolved path). */
const DENY_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker'];
/** Multi-segment denials (matched as consecutive path segments). */
const DENY_SEGMENT_PAIRS = [['.config', 'gcloud']];

/** Basenames that are never read. */
function isDeniedBasename(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n.startsWith('.env')) return true;
  if (n.startsWith('id_rsa') || n.startsWith('id_ed25519')) return true;
  if (n.endsWith('.pem') || n.endsWith('.key')) return true;
  return false;
}

function splitSegments(absPath) {
  return String(absPath)
    .split(/[\\/]+/)
    .filter(Boolean);
}

/** True if an absolute path touches a well-known secret location. */
export function isSecretPath(absPath) {
  const segs = splitSegments(absPath);
  const lower = segs.map((s) => s.toLowerCase());
  for (const s of lower) {
    if (DENY_SEGMENTS.includes(s)) return true;
  }
  for (const [a, b] of DENY_SEGMENT_PAIRS) {
    for (let i = 0; i + 1 < lower.length; i++) {
      if (lower[i] === a && lower[i + 1] === b) return true;
    }
  }
  return isDeniedBasename(segs[segs.length - 1]);
}

function realOrResolved(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Allowed roots from NOTESQR_MCP_ROOTS (path-delimited), default cwd. Realpath'd. */
export function mcpRoots(env = process.env, cwd = process.cwd()) {
  const raw = String(env.NOTESQR_MCP_ROOTS || '').trim();
  const list = raw
    ? raw
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    : [cwd];
  return [...new Set(list.map(realOrResolved))];
}

export function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve a user-supplied path for reading. Follows symlinks (realpath) so the
 * final target is what gets checked. Throws a user-facing Error on denial.
 */
export function resolveReadablePath(p, roots) {
  const input = String(p ?? '');
  if (!input) throw new Error('empty path');
  if (input.includes('\0')) throw new Error('invalid path');
  const abs = resolve(input);
  if (isSecretPath(abs)) throw new Error(`refusing to read a sensitive path: ${input}`);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`path not found: ${input}`);
  }
  if (isSecretPath(real)) throw new Error(`refusing to read a sensitive path: ${input}`);
  if (!roots.some((r) => isInside(r, real))) {
    throw new Error(
      `path is outside the allowed roots (set NOTESQR_MCP_ROOTS): ${input}`
    );
  }
  return real;
}

/** Validate a Premium license file path (.nql, regular file, <= 64 KiB). */
export function resolveLicensePath(p, roots) {
  const real = resolveReadablePath(p, roots);
  if (!real.toLowerCase().endsWith('.nql')) {
    throw new Error('license_path must be a .nql file');
  }
  const st = statSync(real);
  if (!st.isFile()) throw new Error('license_path must be a regular file');
  if (st.size > LICENSE_MAX_BYTES) throw new Error('license_path is too large');
  return real;
}

/** Reject filesystem roots and the home directory as receive output dirs. */
export function assertSafeOutputDir(dir, home = homedir()) {
  const input = String(dir ?? '').trim();
  if (!input) throw new Error('output_dir required');
  const abs = realOrResolved(input);
  if (parse(abs).root === abs) throw new Error('output_dir must not be the filesystem root');
  const homeReal = realOrResolved(home);
  if (abs === homeReal || abs === resolve(home)) {
    throw new Error('output_dir must not be your home directory; use a subfolder');
  }
  return abs;
}
