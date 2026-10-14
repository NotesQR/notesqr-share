import { mkdirSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const MAX_PATH_LEN = 4096;

/** Sanitize relative path for wire + filesystem writes. */
export function sanitizeRelPath(raw) {
  let s = String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '');
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return '';
  return parts.join('/').slice(0, MAX_PATH_LEN);
}

export function pathBasename(relPath) {
  const s = String(relPath || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function walkDir(rootAbs, dirAbs, out) {
  for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
    if (ent.name === '.' || ent.name === '..') continue;
    const abs = join(dirAbs, ent.name);
    if (ent.isDirectory()) walkDir(rootAbs, abs, out);
    else if (ent.isFile()) {
      // Include top folder name: root=/tmp/foo → foo/sub/a.txt
      const parent = dirname(rootAbs);
      const rel = relative(parent, abs).split(sep).join('/');
      const path = sanitizeRelPath(rel);
      if (!path) continue;
      const st = statSync(abs);
      out.push({
        abs,
        path,
        name: pathBasename(path),
        size: st.size,
      });
    }
  }
}

/**
 * Expand CLI send args into a flat file list.
 * Files → basename path. Directories → recursive with folder prefix.
 */
export function collectSendEntries(filePaths) {
  const out = [];
  for (const p of filePaths) {
    const abs = resolve(p);
    const st = statSync(abs);
    if (st.isFile()) {
      const name = basename(abs);
      out.push({ abs, path: name, name, size: st.size });
    } else if (st.isDirectory()) {
      walkDir(abs, abs, out);
    } else {
      throw new Error(`not a file or directory: ${p}`);
    }
  }
  if (!out.length) throw new Error('no files found (empty folder?)');
  return out;
}

/** Safe join under outDir; throws if path escapes. */
export function safeJoinOut(outDir, relPath) {
  const clean = sanitizeRelPath(relPath);
  if (!clean) throw new Error('invalid relative path');
  const root = resolve(outDir);
  const target = resolve(root, ...clean.split('/'));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes output dir: ${relPath}`);
  }
  return target;
}

/** `a/b.txt` + 2 → `a/b (2).txt`; dotfiles keep the whole name as stem (`.rc (1)`). */
export function withConflictSuffix(filePath, n) {
  if (!n) return filePath;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return join(dir, `${stem} (${n})${ext}`);
}

/**
 * Create `filePath` exclusively (O_CREAT|O_EXCL: never overwrites, never follows a
 * symlink at the final component). On conflict tries `name (1).ext`, `(2)`, …
 * Returns { fd, path }.
 */
export function openExclusive(filePath, maxTries = 10_000) {
  for (let n = 0; n < maxTries; n++) {
    const candidate = withConflictSuffix(filePath, n);
    try {
      const fd = openSync(candidate, 'wx', 0o644);
      return { fd, path: candidate };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`too many name conflicts for ${filePath}`);
}

/**
 * mkdir -p the parent of `target` and make sure the real (symlink-resolved)
 * parent is still inside the real `outDir`. Guards against pre-existing
 * symlinked folders redirecting writes elsewhere.
 */
export function ensureParentInside(outDir, target) {
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(`path escapes output dir via symlink: ${target}`);
  }
}
