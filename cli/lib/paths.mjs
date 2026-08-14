import { readdirSync, statSync } from 'node:fs';
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
