import { constants, readdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { fail, hash, isDigest, readPrivate, writePrivate, removePrivate } from './state.mjs';

const CHUNK = 256 * 1024;
const PAGE_HASHES = 16384;
const MAX_USER_RECORD = 32 * 1024 * 1024;
const identifier = (key, text) => createHmac('sha256', key).update(text).digest('hex');

function acquireLock(dir) {
  const name = 'history-lock.json';
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(join(dir, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      return () => { if (readPrivate(dir, name)?.nonce === nonce) removePrivate(dir, name); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = readPrivate(dir, name); } catch { return null; }
      if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || typeof lock.nonce !== 'string') return null;
      try { process.kill(lock.pid, 0); return null; }
      catch (error) {
        if (error.code !== 'ESRCH') return null;
        if (readPrivate(dir, name)?.nonce === lock.nonce) removePrivate(dir, name);
      }
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return null;
}

function loadPages(dir, pages = []) {
  if (!Array.isArray(pages) || pages.some(id => !isDigest(id))) fail('invalid-history-pages');
  const result = new Set();
  for (const id of pages) {
    const values = readPrivate(dir, `sequence-${id}.json`);
    if (!Array.isArray(values) || values.length > PAGE_HASHES || values.some(value => !isDigest(value)) || hash(JSON.stringify(values)) !== id) fail('invalid-history-page');
    for (const value of values) result.add(value);
  }
  return result;
}

function savePages(dir, hashes) {
  const pages = [], batch = [];
  const flush = () => {
    if (!batch.length) return;
    const id = hash(JSON.stringify(batch));
    if (!existsSync(join(dir, `sequence-${id}.json`))) writePrivate(dir, `sequence-${id}.json`, batch);
    pages.push(id); batch.length = 0;
  };
  for (const value of hashes) { batch.push(value); if (batch.length === PAGE_HASHES) flush(); }
  flush();
  return pages;
}

// Read only the top-level record discriminator before considering JSON parsing.
// Large assistant/tool output is skipped while streaming, without retaining it.
class RecordType {
  depth = 0; quoted = false; escaped = false; token = ''; key = ''; phase = 'key'; kind = null;
  feed(bytes) {
    for (const byte of bytes) {
      if (this.kind !== null) return;
      const ch = String.fromCharCode(byte);
      if (this.quoted) {
        if (this.depth === 1 && this.token.length < 256) this.token += ch;
        if (this.escaped) { this.escaped = false; continue; }
        if (ch === '\\') { this.escaped = true; continue; }
        if (ch !== '"') continue;
        this.quoted = false;
        if (this.depth === 1) {
          let value;
          try { value = JSON.parse('"' + this.token); } catch { value = null; }
          if (this.phase === 'key') { this.key = value; this.phase = 'colon'; }
          else {
            if (this.key === 'type' && typeof value === 'string') this.kind = value;
            this.phase = 'comma';
          }
        }
        continue;
      }
      if (ch === '"') { this.quoted = true; this.token = ''; }
      else if (ch === '{' || ch === '[') this.depth++;
      else if (ch === '}' || ch === ']') { this.depth--; if (this.depth === 1) this.phase = 'comma'; }
      else if (this.depth === 1 && ch === ':') this.phase = 'value';
      else if (this.depth === 1 && ch === ',') { this.phase = 'key'; this.key = ''; }
    }
  }
}

function lineCollector(skipping = false) {
  const detector = new RecordType();
  let chunks = [], size = 0, skip = skipping, prefix = '';
  return {
    feed(bytes) {
      size += bytes.length;
      if (skip) return;
      detector.feed(bytes);
      if (detector.kind !== null && detector.kind !== 'user') { skip = true; chunks = []; return; }
      if (prefix.length < 65536) prefix += bytes.subarray(0, 65536 - prefix.length).toString('utf8');
      if (/(?<!\\)"type"\s*:\s*"tool_result"/.test(prefix)) { skip = true; chunks = []; return; }
      if (size > MAX_USER_RECORD) fail('history-user-record-too-large');
      chunks.push(Buffer.from(bytes));
    },
    prompt(promptFromRecord) {
      if (skip || size === 0) return null;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (!text.trim()) return null;
      return promptFromRecord(JSON.parse(text));
    },
    get size() { return size; },
    get skipped() { return skip; }
  };
}

function scanFile(fd, stat, offset, hashes, options, metrics) {
  const { now, deadline, key, promptFromRecord, hashSequences } = options;
  const buffer = Buffer.allocUnsafe(CHUNK);
  let position = offset, line = lineCollector(options.skippingLine), prompts = 0;
  const insert = (prompt, target) => {
    if (prompt === null) return;
    prompts++;
    for (const sequence of hashSequences(prompt, key)) target.add(sequence.hash);
  };
  while (position < stat.size) {
    if (now() >= deadline) return { offset: line.skipped ? position : offset, skipping: line.skipped, hashes, tail: new Set(), prompts, complete: false };
    const count = readSync(fd, buffer, 0, Math.min(CHUNK, stat.size - position), position);
    if (count === 0) fail('history-changed-during-read');
    metrics.bytesRead += count;
    let start = 0;
    while (start < count) {
      const newline = buffer.indexOf(10, start);
      const end = newline === -1 || newline >= count ? count : newline;
      line.feed(buffer.subarray(start, end));
      if (end === count) break;
      insert(line.prompt(promptFromRecord), hashes);
      offset = position + end + 1;
      line = lineCollector(); start = end + 1;
    }
    position += count;
  }
  // A valid final record need not have a newline. Keep its hashes separately so
  // the next append can replace that tail without retaining stale sequences.
  const tail = new Set();
  let tailPrompt = false;
  if (line.size) {
    try {
      const prompt = line.prompt(promptFromRecord);
      tailPrompt = prompt !== null;
      if (prompt !== null) for (const sequence of hashSequences(prompt, key)) tail.add(sequence.hash);
    } catch { return { offset, hashes, tail, prompts, complete: false }; }
  }
  return { offset: line.skipped ? position : offset, skipping: line.skipped, hashes, tail, prompts, tailPrompt, complete: true };
}

function historyFiles(root, key) {
  if (lstatSync(root).isSymbolicLink()) fail('history-symlink');
  const files = [];
  for (const project of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (project.isSymbolicLink()) fail('history-symlink');
    if (!project.isDirectory()) continue;
    const folder = join(root, project.name);
    for (const file of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.name.endsWith('.jsonl')) continue;
      if (!file.isFile() || file.isSymbolicLink()) fail('history-layout');
      const path = join(folder, file.name);
      files.push({ path, id: identifier(key, path) });
    }
  }
  return files;
}

export function indexHistory(dir, env, key, { promptFromRecord, hashSequences, now = Date.now, budgetMs = 60000 } = {}) {
  const hashes = new Set(), metrics = { bytesRead: 0, cachedFiles: 0, indexedFiles: 0 };
  const release = acquireLock(dir);
  if (!release) return { hashes, historyStatus: 'indexing', metrics };
  let status = 'available', entries = {}, prompts = 0;
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const rootId = identifier(key, root);
  try {
    const deadline = now() + budgetMs;
    const old = readPrivate(dir, 'owner-index.json');
    const files = historyFiles(root, key);
    if (old?.version === 3 && old.rootId === rootId && old.entries && typeof old.entries === 'object') {
      entries = Object.fromEntries(files.filter(file => old.entries[file.id]).map(file => [file.id, old.entries[file.id]]));
    }
    if (!files.length) status = 'unavailable';
    for (const file of files) {
      if (now() >= deadline) { status = 'indexing'; break; }
      let fd;
      try {
        fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd), previous = entries[file.id];
        if (!stat.isFile() || stat.nlink !== 1) fail('history-linked-file');
        const sameFile = previous && previous.inode === stat.ino && previous.device === stat.dev;
        const unchanged = sameFile && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs;
        const reusable = sameFile && (unchanged || stat.size > previous.size) && Number.isSafeInteger(previous.offset) && previous.offset >= 0 && previous.offset <= stat.size;
        const main = reusable ? loadPages(dir, previous.pages) : new Set();
        let entry;
        if (unchanged && previous.complete) {
          entry = previous; metrics.cachedFiles++;
        } else {
          const result = scanFile(fd, stat, reusable ? previous.offset : 0, main, { now, deadline, key, promptFromRecord, hashSequences, skippingLine: reusable && previous.skippingLine }, metrics);
          const after = lstatSync(file.path);
          const stable = after.ino === stat.ino && after.dev === stat.dev && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs;
          entry = {
            size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, inode: stat.ino, device: stat.dev,
            offset: result.offset, skippingLine: !!result.skipping, complete: result.complete && stable,
            prompts: (reusable ? previous.prompts : 0) + result.prompts,
            tailPrompt: !!result.tailPrompt, pages: savePages(dir, result.hashes), tailPages: savePages(dir, result.tail)
          };
          metrics.indexedFiles++;
        }
        entries[file.id] = entry;
        if (!entry.complete) status = 'indexing';
        for (const value of main) hashes.add(value);
        for (const value of loadPages(dir, entry.tailPages)) hashes.add(value);
        prompts += entry.prompts + (entry.tailPrompt ? 1 : 0);
      } catch {
        delete entries[file.id]; status = 'unavailable'; break;
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    if (status === 'available' && !prompts) status = 'unavailable';
  } catch { entries = {}; status = 'unavailable'; }
  try {
    writePrivate(dir, 'owner-index.json', { version: 3, rootId, status, entries });
    const retained = new Set(Object.values(entries).flatMap(entry => [...(entry.pages ?? []), ...(entry.tailPages ?? [])]));
    for (const name of readdirSync(dir)) {
      const match = /^sequence-([a-f0-9]{64})\.json$/.exec(name);
      if (match && !retained.has(match[1])) removePrivate(dir, name);
    }
    // Remove the previous aggregate cache after migrating to per-file pages.
    removePrivate(dir, 'owner-sequences.json');
    return { hashes, historyStatus: status, metrics };
  } finally { release(); }
}
