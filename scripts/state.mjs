import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, fstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const TTL = 30 * 60 * 1000;
export class GuardError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function fail(code) { throw new GuardError(code); }

// Walk existing ancestors rather than trusting an ignored directory or a symlink.
export function outsideRepository(path) {
  let p = resolve(path);
  for (;;) {
    if (existsSync(p)) {
      if (lstatSync(p).isSymbolicLink()) fail('private-state-symlink');
      if (existsSync(join(p, '.git')) || ['HEAD', 'objects', 'refs'].every(name => existsSync(join(p, name)))) fail('private-state-in-repository');
    }
    if (p === dirname(p)) break;
    p = dirname(p);
  }
}

export function privateDirectory(env = process.env) {
  if (env.PUBLISH_GUARD_DATA_DIR && !isAbsolute(env.PUBLISH_GUARD_DATA_DIR)) fail('absolute-private-directory-required');
  const dir = resolve(env.PUBLISH_GUARD_DATA_DIR || join(homedir(), '.local', 'share', 'publish-guard'));
  outsideRepository(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('private-directory-permissions');
  return realpathSync(dir);
}

function statePath(dir, name) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) fail('invalid-state-name');
  return join(dir, name);
}

export function readPrivate(dir, name, fallback = null) {
  const path = statePath(dir, name);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || s.size > 16 * 1024 * 1024) fail('private-file-permissions-or-size');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function writePrivate(dir, name, value) {
  const target = statePath(dir, name);
  // Validate any existing file before replacing it, including links and mode.
  readPrivate(dir, name);
  const tmp = join(dir, `.pending-${randomBytes(16).toString('hex')}`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  try { renameSync(tmp, target); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

export function removePrivate(dir, name) {
  if (readPrivate(dir, name) !== null) unlinkSync(statePath(dir, name));
}

export function historyKey(dir) {
  let data = readPrivate(dir, 'history-key.json');
  if (!data) {
    const path = statePath(dir, 'history-key.json');
    let fd;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify({ key: randomBytes(32).toString('hex') }));
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    data = readPrivate(dir, 'history-key.json');
  }
  if (!isDigest(data?.key)) fail('invalid-history-key');
  return data.key;
}

export function pendingName(digest) {
  if (!isDigest(digest)) fail('invalid-digest');
  return `pending-${digest}.json`;
}

export function recordReview(dir, digest, classifications, now = Date.now()) {
  const pending = readPrivate(dir, pendingName(digest));
  if (!pending || now - pending.created > TTL || now < pending.created) fail('review-expired-or-missing');
  if (pending.blocked) fail('findings-must-be-resolved');
  const ids = pending.items.map(item => item.id).sort();
  if (!classifications || Array.isArray(classifications) || Object.keys(classifications).sort().join('\0') !== ids.join('\0')) fail('classify-every-item');
  if (ids.some(id => classifications[id] !== 'product')) fail('private-or-doubtful-item');
  writePrivate(dir, `review-${digest}.json`, { digest, created: now, classifications });
  return { status: 'review-recorded', digest, items: ids.length };
}

export function reviewed(dir, digest, items, now = Date.now()) {
  const review = readPrivate(dir, `review-${digest}.json`);
  return !!review && review.digest === digest && now >= review.created && now - review.created <= TTL
    && Object.keys(review.classifications ?? {}).length === items.length
    && items.every(item => review.classifications?.[item.id] === 'product');
}

export function canonicalExistingParent(path) {
  let p = resolve(path);
  const suffix = [];
  while (!existsSync(p)) {
    if (p === parse(p).root) fail('path-parent-unavailable');
    suffix.unshift(p.slice(dirname(p).length + (dirname(p).endsWith('/') ? 0 : 1)));
    p = dirname(p);
  }
  return resolve(realpathSync(p), ...suffix);
}
