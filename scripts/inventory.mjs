import { spawnSync } from 'node:child_process';
import { constants, existsSync, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fail, hash, canonicalExistingParent } from './state.mjs';
import { containsPublication, gitOperation, ghPublishes } from './commands.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 2000;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function decode(buffer) {
  if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) fail('unsupported-binary-or-large-content');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { fail('unsupported-text-encoding'); }
}

export function git(cwd, args, { optional = false, missingObject = false, timeout = 5000 } = {}) {
  if (Object.keys(process.env).some(key => /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|CONFIG|OBJECT|ALTERNATE|NAMESPACE|SHALLOW|REPLACE)/.test(key))) fail('git-environment-override');
  const result = spawnSync('git', ['--no-replace-objects', '-C', cwd, ...args], {
    encoding: 'buffer', timeout, maxBuffer: MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.signal || result.status !== 0) {
    if (optional && !result.error && !result.signal && (result.status === 1 || missingObject && result.status === 128)) return null;
    fail('git-inspection-failed');
  }
  return result.stdout;
}
const gitText = (cwd, args) => git(cwd, args).toString('utf8').trim();
export function repoRoot(cwd) {
  return realpathSync(gitText(cwd, ['rev-parse', '--show-toplevel']));
}

// A deliberately small literal grammar. It never executes or expands the input.
export function literalTokens(command) {
  if (typeof command !== 'string' || command.length > 128 * 1024 || /[\x00\r\n]/.test(command)) return null;
  const tokens = [];
  let word = '', active = false, quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if ('$`\\'.includes(ch)) return null;
      word += ch; continue;
    }
    if (ch === "'" || ch === '"') { active = true; quote = ch; continue; }
    if (/\s/.test(ch)) { if (active) tokens.push(word); word = ''; active = false; continue; }
    if (';&|<>()`$\\*?[]{}~#!'.includes(ch)) return null;
    active = true; word += ch;
  }
  if (quote) return null;
  if (active) tokens.push(word);
  return tokens;
}

function inventory(kind, cwd, destination) {
  return { version: 1, kind, cwd: realpathSync(cwd), destination, items: [], bytes: 0 };
}
function add(inv, label, text, type = 'text') {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > 2 * 1024 * 1024) fail('unsupported-text-item');
  if (type === 'file' && /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|pdf|png|jpe?g|gif|webp|heic|avif|svg|mp[34]|mov|wav|woff2?|ttf|exe|dll|bin)$/i.test(label)) fail('unsupported-asset-format');
  if (type === 'file' && text.startsWith('version https://git-lfs.github.com/spec/')) fail('lfs-payload-unavailable');
  inv.bytes += Buffer.byteLength(text) + Buffer.byteLength(label);
  if (inv.bytes > MAX_BYTES || inv.items.length >= MAX_ITEMS) fail('inventory-limit');
  inv.items.push({ id: `item-${inv.items.length + 1}`, label, type, text });
}
function addStructured(inv, label, data, depth = 0) {
  if (depth > 20) fail('structured-input-too-deep');
  if (typeof data === 'string') add(inv, label, data, 'metadata');
  else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      add(inv, `${label}-field`, key, 'metadata');
      addStructured(inv, `${label}-${key}`, value, depth + 1);
    }
  } else if (data !== undefined) add(inv, label, JSON.stringify(data), 'metadata');
}
function localFile(cwd, filename) {
  if (!filename || filename === '-' || filename.includes('\0')) fail('stdin-or-missing-file-unsupported');
  const path = resolve(cwd, filename);
  // Refuse links anywhere in the path, including parents, and hard-linked files.
  for (let p = path; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) fail('linked-input-file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('unsupported-input-file');
    return decode(readFileSync(fd));
  } finally { closeSync(fd); }
}

export function treeEntries(cwd, tree) {
  if (!tree) return new Map();
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(git(cwd, ['ls-tree', '-r', '-z', tree])).split('\0').filter(Boolean);
  return new Map(entries.map(entry => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) fail('unsupported-tree-entry');
    return [match[4], { mode: match[1], type: match[2], oid: match[3] }];
  }));
}

function changedItems(inv, current, previous) {
  // Bind the complete snapshot, but inspect only introduced paths and lines.
  add(inv, 'snapshot', hash(JSON.stringify([...current])), 'metadata');
  for (const [path, entry] of current) {
    const old = previous.get(path);
    if (old?.oid === entry.oid && old.mode === entry.mode) continue;
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') fail('unsupported-tree-entry');
    add(inv, old ? 'changed-object' : path, `${entry.mode} ${entry.oid}`, old ? 'metadata' : 'path');
    if (old?.oid === entry.oid) continue;
    const text = decode(git(inv.cwd, ['cat-file', 'blob', entry.oid]));
    let ranges;
    if (old && old.type === 'blob' && ['100644', '100755'].includes(old.mode)) {
      // Blob-to-blob text diffs avoid attributes, external helpers and renames.
      const patch = git(inv.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--unified=0', old.oid, entry.oid, '--']).toString('utf8');
      const hunks = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)];
      if (!hunks.length) fail('changed-line-inspection-failed');
      ranges = hunks.flatMap(match => {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        return count ? [[start, start + count - 1]] : [];
      });
    }
    add(inv, path, text, 'file');
    Object.assign(inv.items.at(-1), { scanRanges: ranges, scanLabel: !old, blob: entry.oid, ...(old ? { previousBlob: old.oid } : {}) });
  }
}

function changedTreeItems(inv, tree, parent) {
  changedItems(inv, treeEntries(inv.cwd, tree), treeEntries(inv.cwd, parent));
}

function historyItems(inv, target, seen = new Set(), bases = [], knownObjects = new Set()) {
  if (!OID.test(target)) fail('invalid-object-id');
  if (knownObjects.has(target)) return;
  const type = gitText(inv.cwd, ['cat-file', '-t', target]);
  if (type === 'tag') {
    add(inv, `tag-${target}`, decode(git(inv.cwd, ['cat-file', 'tag', target])), 'metadata');
    const next = gitText(inv.cwd, ['rev-parse', '--verify', `${target}^{}`]);
    // Nested tag objects can contain text too; do not skip them by peeling.
    const direct = gitText(inv.cwd, ['cat-file', 'tag', target]).match(/^object ([a-f0-9]+)$/m)?.[1];
    if (!direct || direct === target || !next) fail('invalid-tag-object');
    return historyItems(inv, direct, seen, bases, knownObjects);
  }
  if (type !== 'commit') fail('non-commit-publication-unsupported');
  if (gitText(inv.cwd, ['rev-parse', '--is-shallow-repository']) !== 'false') fail('shallow-history-unavailable');
  const grafts = gitText(inv.cwd, ['rev-parse', '--git-path', 'info/grafts']);
  if (existsSync(resolve(inv.cwd, grafts))) fail('grafted-history-unsupported');
  const commits = gitText(inv.cwd, ['rev-list', target, ...(bases.length ? ['--not', ...bases] : [])]).split('\n').filter(Boolean);
  if (commits.length > 500) fail('history-commit-limit');
  for (const oid of commits) {
    if (!OID.test(oid)) fail('invalid-history-object');
    if (seen.has(oid)) continue;
    seen.add(oid);
    add(inv, `commit-${oid}`, decode(git(inv.cwd, ['cat-file', 'commit', oid])), 'metadata');
    const parents = gitText(inv.cwd, ['rev-list', '--parents', '-n', '1', oid]).split(' ').slice(1);
    changedTreeItems(inv, oid, parents[0]);
  }
}

function identity(inv) {
  for (const kind of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = decode(git(inv.cwd, ['var', kind])).trim().replace(/ \d+ [+-]\d{4}$/, '');
    add(inv, kind === 'GIT_AUTHOR_IDENT' ? 'author-identity' : 'committer-identity', ident, 'metadata');
  }
}
function checkCommitContext(cwd) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const path = resolve(cwd, gitText(cwd, ['rev-parse', '--git-path', name]));
    if (existsSync(path)) fail('in-progress-git-operation-unsupported');
  }
  const signing = git(cwd, ['config', '--get', 'commit.gpgSign'], { optional: true });
  if (signing && signing.toString().trim() !== 'false') fail('commit-signing-unsupported');
}

function parseOptions(args, valueOptions, flags = []) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (flags.includes(arg)) { if (options[arg]) fail('duplicate-option'); options[arg] = true; continue; }
    if (!valueOptions.includes(arg) || i + 1 === args.length || options[arg] !== undefined) fail('unsupported-or-duplicate-option');
    options[arg] = args[++i];
  }
  return { options, positional };
}
function oneOf(options, names, required = false) {
  const found = names.filter(name => options[name] !== undefined);
  if (found.length > 1 || (required && found.length !== 1)) fail('explicit-single-value-required');
  return found.length ? options[found[0]] : undefined;
}
function messageFrom(cwd, options) {
  const literal = oneOf(options, ['-m', '--message']);
  const file = oneOf(options, ['-F', '--file']);
  if ((literal === undefined) === (file === undefined)) fail('explicit-message-required');
  const text = file === undefined ? literal : localFile(cwd, file);
  if (!text.trim()) fail('empty-message');
  return text;
}

function remoteSnapshot(root, url) {
  const text = git(root, ['ls-remote', '--heads', '--tags', '--refs', '--', url], { timeout: 15000 }).toString('utf8').trim();
  const refs = text ? text.split('\n').map(line => {
    const match = /^([a-f0-9]+)\t(refs\/(?:heads|tags)\/[^\s]+)$/.exec(line);
    if (!match || !OID.test(match[1])) fail('invalid-remote-advertisement');
    return { oid: match[1], ref: match[2] };
  }).sort((a, b) => a.ref.localeCompare(b.ref)) : [];
  const roots = [...new Set(refs.map(ref => ref.oid))];
  if (roots.some(oid => git(root, ['cat-file', '-e', oid], { optional: true, missingObject: true }) === null)) return { refs, bases: [], knownObjects: new Set(), mode: 'full-missing-remote-objects' };
  try {
    const bases = roots.flatMap(oid => {
      const commit = git(root, ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], { optional: true, missingObject: true });
      return commit ? [commit.toString('utf8').trim()] : [];
    });
    const knownObjects = new Set(roots);
    if (bases.length) {
      for (const oid of gitText(root, ['rev-list', '--objects', '--no-object-names', ...bases]).split('\n')) {
        if (!OID.test(oid)) fail('invalid-remote-reachability');
        knownObjects.add(oid);
      }
    }
    return { refs, bases, knownObjects, mode: refs.length ? 'outgoing' : 'full-empty-remote' };
  } catch {
    // Missing local ancestry/trees cannot justify excluding any outgoing object.
    return { refs, bases: [], knownObjects: new Set(), mode: 'full-missing-remote-objects' };
  }
}

export function pushInventory(cwd, remote, updates, destinationOverride) {
  const root = repoRoot(cwd);
  if (!/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith('-')) fail('explicit-named-remote-required');
  const urls = gitText(root, ['remote', 'get-url', '--push', '--all', remote]).split('\n');
  if (urls.length !== 1 || !urls[0]) fail('single-push-destination-required');
  if (destinationOverride !== undefined && urls[0] !== destinationOverride) fail('push-destination-mismatch');
  const follow = git(root, ['config', '--get', 'push.followTags'], { optional: true });
  if (follow && follow.toString().trim() !== 'false') fail('implicit-tags-unsupported');
  const mirror = git(root, ['config', '--get', `remote.${remote}.mirror`], { optional: true });
  if (mirror && mirror.toString().trim() !== 'false') fail('mirror-push-unsupported');
  if (!updates.length || updates.length > 20) fail('explicit-refspec-required');
  const snapshot = remoteSnapshot(root, urls[0]);
  const resolved = updates.map(update => {
    if (!/^[A-Za-z0-9_./-]+$/.test(update.source) || update.source.startsWith('-')) fail('explicit-source-ref-required');
    const oid = gitText(root, ['rev-parse', '--verify', '--end-of-options', update.source]);
    if (!OID.test(oid)) fail('invalid-source-object');
    const symbolic = gitText(root, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', update.source]);
    let destination = update.destination || symbolic;
    if (!destination.startsWith('refs/')) {
      const matches = snapshot.refs.filter(ref => ref.ref === `refs/heads/${destination}` || ref.ref === `refs/tags/${destination}`);
      if (matches.length > 1) fail('ambiguous-push-destination');
      if (matches.length === 1) destination = matches[0].ref;
      else if (symbolic.startsWith('refs/heads/')) destination = `refs/heads/${destination}`;
      else if (symbolic.startsWith('refs/tags/')) destination = `refs/tags/${destination}`;
      else fail('explicit-full-destination-ref-required');
    }
    if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(destination)) fail('explicit-full-destination-ref-required');
    git(root, ['check-ref-format', destination]);
    return { oid, destination };
  }).sort((a, b) => a.destination.localeCompare(b.destination));
  if (new Set(resolved.map(update => update.destination)).size !== resolved.length) fail('duplicate-destination-ref');
  const inv = inventory('push', root, { remote: urls[0], refs: resolved });
  // The remote advertisement also binds the review, without exposing remote names.
  inv.remoteSnapshot = snapshot.refs;
  inv.baselineRefs = snapshot.bases;
  add(inv, 'push-remote', urls[0], 'destination');
  addStructured(inv, 'push-refs', resolved);
  const seen = new Set();
  for (const update of resolved) historyItems(inv, update.oid, seen, snapshot.bases, snapshot.knownObjects);
  inv.scanMode = snapshot.mode;
  return inv;
}

function gitInventory(cwd, args) {
  if (!gitOperation(args).publishing) return null;
  while (args[0] === '-C') { if (!args[1]) fail('missing-cwd'); cwd = resolve(cwd, args[1]); args = args.slice(2); }
  const [verb, ...rest] = args;
  if (!['commit', 'commit-tree', 'push', 'tag'].includes(verb)) fail('unsupported-git-command');
  const root = repoRoot(cwd);
  if (verb === 'push') {
    const positional = rest.filter(arg => !['-u', '--set-upstream', '--force-with-lease'].includes(arg) && !arg.startsWith('--force-with-lease='));
    if (positional.length < 2 || positional.some(arg => arg.startsWith('-'))) fail('explicit-push-form-required');
    const updates = positional.slice(1).map(spec => {
      const parts = spec.split(':');
      if (parts.length > 2 || !parts[0] || parts.length === 2 && !parts[1]) fail('explicit-refspec-required');
      return { source: parts[0], destination: parts[1] };
    });
    return pushInventory(root, positional[0], updates);
  }
  const inv = inventory(verb, root, { localRepository: root });
  if (verb === 'commit') {
    const { options, positional } = parseOptions(rest, ['-m', '--message', '-F', '--file']);
    if (positional.length) fail('partial-commit-unsupported');
    checkCommitContext(root);
    add(inv, 'commit-message', messageFrom(root, options));
    identity(inv);
    const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { optional: true });
    add(inv, 'parent', head?.toString('utf8').trim() ?? 'unborn', 'metadata');
    inv.baselineRefs = head ? [head.toString('utf8').trim()] : [];
    const staged = new Map();
    for (const entry of new TextDecoder('utf-8', { fatal: true }).decode(git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
      if (!match || match[3] !== '0') fail('unsupported-index-entry');
      staged.set(match[4], { mode: match[1], oid: match[2], type: match[1] === '160000' ? 'commit' : 'blob' });
    }
    changedItems(inv, staged, treeEntries(root, inv.baselineRefs[0]));
  } else if (verb === 'commit-tree') {
    const signing = git(root, ['config', '--get', 'commit.gpgSign'], { optional: true });
    if (signing && signing.toString().trim() !== 'false') fail('commit-signing-unsupported');
    const parents = [], other = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-p') { if (!OID.test(rest[i + 1] ?? '')) fail('explicit-parent-object-required'); parents.push(rest[++i]); }
      else other.push(rest[i]);
    }
    const { options, positional } = parseOptions(other, ['-m', '--message', '-F', '--file']);
    if (positional.length !== 1 || !OID.test(positional[0])) fail('explicit-tree-object-required');
    for (const parent of parents) git(root, ['cat-file', '-e', `${parent}^{commit}`]);
    add(inv, 'parents', parents.join('\n'), 'metadata');
    add(inv, 'commit-message', messageFrom(root, options));
    identity(inv);
    inv.baselineRefs = parents.slice(0, 1);
    changedTreeItems(inv, gitText(root, ['rev-parse', '--verify', `${positional[0]}^{tree}`]), parents[0]);
  } else {
    const { options, positional } = parseOptions(rest, ['-m', '--message', '-F', '--file'], ['-a', '--annotate']);
    if (!positional.length || positional.length > 2 || !/^[A-Za-z0-9_.-]+$/.test(positional[0])) fail('unsupported-tag-form');
    const signing = git(root, ['config', '--get', 'tag.gpgSign'], { optional: true });
    if (signing && signing.toString().trim() !== 'false') fail('tag-signing-unsupported');
    const target = positional[1] || 'HEAD';
    if (!/^(?:HEAD|[a-f0-9]{40}(?:[a-f0-9]{24})?|refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/.test(target)) fail('explicit-tag-target-required');
    add(inv, 'tag-name', positional[0], 'metadata');
    if (Object.keys(options).length) { add(inv, 'tag-message', messageFrom(root, options)); identity(inv); }
    historyItems(inv, gitText(root, ['rev-parse', '--verify', target]));
  }
  return inv;
}

function contentOption(cwd, options, textKeys, fileKeys) {
  const text = oneOf(options, textKeys), file = oneOf(options, fileKeys);
  if (text !== undefined && file !== undefined) fail('duplicate-content');
  return file === undefined ? text : localFile(cwd, file);
}

function githubIdentity(cwd) {
  const result = spawnSync('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.signal || result.status !== 0 || !/^[A-Za-z0-9_-]{1,100}$/.test(result.stdout.trim())) fail('github-account-unavailable');
  return result.stdout.trim();
}

function ghInventory(cwd, args, resolveIdentity) {
  if (!ghPublishes(args)) return null;
  const [group, verb, ...rest] = args;
  if (['help', 'version'].includes(group)) return null;
  if (['view', 'list', 'status', 'diff', 'checks'].includes(verb) && ['pr', 'issue', 'release', 'repo', 'gist'].includes(group)) return null;
  if (group === 'api') return apiInventory(cwd, args.slice(1), resolveIdentity);
  if (!['release', 'pr', 'issue', 'gist', 'repo'].includes(group)) fail('unsupported-gh-command');
  if (!['create', 'edit', 'comment', 'upload', 'delete'].includes(verb)) fail('unsupported-gh-write');
  const { options, positional } = parseOptions(rest,
    ['-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '-n', '--notes', '--notes-file', '-d', '--description', '--desc', '--head', '--base', '--name', '--homepage', '-a', '--add', '-f', '--filename'],
    ['--public', '--private', '--verify-tag', '--draft', '--yes']);
  if (group === 'pr' && verb === 'create') fail('pr-create-remote-diff-review-required');
  const repository = group === 'repo' ? positional[0] : oneOf(options, ['-R', '--repo'], group !== 'gist');
  if (repository && !REPO.test(repository)) fail('explicit-repository-required');
  const target = group === 'gist' && verb === 'create' ? 'new-gist' : positional[0] ?? '';
  const inv = inventory(`gh-${group}-${verb}`, cwd, { host: 'github.com', repository: repository || 'gist', target,
    ...(group === 'gist' && verb === 'create' ? { account: resolveIdentity(cwd) } : {}) });
  addStructured(inv, 'destination', inv.destination);
  const title = oneOf(options, ['-t', '--title']);
  const description = oneOf(options, ['-d', '--description', '--desc']);
  const body = contentOption(cwd, options, ['-b', '--body'], ['-F', '--body-file']);
  const notes = contentOption(cwd, options, ['-n', '--notes'], ['--notes-file']);
  for (const [label, value] of [['title', title], ['description', description], ['body', body], ['release-text', notes]]) if (value !== undefined) add(inv, label, value);
  const supplied = new Set(Object.keys(options));
  const allow = (...names) => names.forEach(name => supplied.delete(name));
  allow('-R', '--repo');
  if (group === 'issue' || group === 'pr') {
    if (!['create', 'edit', 'comment'].includes(verb)) fail('unsupported-discussion-write');
    allow('-t', '--title', '-b', '--body', '-F', '--body-file');
    if (verb === 'create' ? positional.length !== 0 || title === undefined || body === undefined : positional.length !== 1 || !/^\d+$/.test(target)) fail('explicit-discussion-content-required');
    if (verb === 'comment' && body === undefined) fail('explicit-body-required');
    if (verb === 'edit' && body === undefined && title === undefined) fail('explicit-edit-required');
  } else if (group === 'release') {
    allow('-t', '--title', '-n', '--notes', '--notes-file', '--verify-tag', '--draft');
    if (!['create', 'edit', 'upload'].includes(verb) || !target || target.startsWith('-')) fail('unsupported-release-write');
    if (verb === 'create' && (!options['--verify-tag'] || title === undefined || notes === undefined)) fail('explicit-release-content-and-existing-tag-required');
    if (verb === 'edit' && (positional.length !== 1 || (title === undefined && notes === undefined))) fail('explicit-release-edit-required');
    if (verb === 'upload' && positional.length < 2) fail('explicit-release-assets-required');
    add(inv, 'release-state', options['--draft'] ? 'draft' : verb === 'create' ? 'published' : 'unchanged', 'metadata');
    for (const filename of positional.slice(1)) {
      if (filename.includes('#')) fail('asset-display-label-unsupported');
      add(inv, basename(filename), localFile(cwd, filename), 'file');
    }
  } else if (group === 'repo') {
    allow('-d', '--description', '--homepage', '--public', '--private');
    if (verb !== 'create' && verb !== 'edit') fail('unsupported-repository-write');
    if (verb === 'create' && (positional.length !== 1 || !!options['--public'] === !!options['--private'])) fail('explicit-new-repository-visibility-required');
    if (options['-R'] || options['--repo']) fail('repository-positional-target-required');
    if (verb === 'edit' && (positional.length !== 1 || options['--public'] || options['--private'])) fail('repository-visibility-change-unsupported');
    if (verb === 'edit' && description === undefined && options['--homepage'] === undefined) fail('explicit-repository-edit-required');
    if (options['--homepage']) add(inv, 'homepage', options['--homepage']);
    if (verb === 'create') add(inv, 'visibility', options['--public'] ? 'public' : 'private', 'metadata');
  } else {
    allow('-d', '--desc');
    if (verb === 'create') {
      allow('--public');
      if (!positional.length) fail('explicit-gist-files-required');
      add(inv, 'visibility', options['--public'] ? 'public' : 'secret', 'metadata');
      for (const filename of positional) add(inv, basename(filename), localFile(cwd, filename), 'file');
    } else if (verb === 'edit') {
      allow('-a', '--add', '-f', '--filename');
      if (!/^[a-f0-9]{20,64}$/.test(target) || positional.length > 2) fail('explicit-gist-id-required');
      const added = oneOf(options, ['-a', '--add']);
      const selected = oneOf(options, ['-f', '--filename']);
      if (added !== undefined) {
        if (positional.length !== 1 || selected !== undefined) fail('mixed-gist-edit-unsupported');
        add(inv, basename(added), localFile(cwd, added), 'file');
      } else if (positional.length === 2 && selected) add(inv, selected, localFile(cwd, positional[1]), 'file');
      else if (positional.length !== 1 || selected !== undefined || description === undefined) fail('interactive-gist-edit-unsupported');
    } else fail('unsupported-gist-write');
  }
  if (supplied.size) fail('option-not-supported-for-operation');
  return inv;
}

function apiInventory(cwd, args, resolveIdentity) {
  const fields = [], other = [];
  for (let i = 0; i < args.length; i++) {
    if (['-f', '--raw-field'].includes(args[i])) {
      if (!args[i + 1] || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i + 1])) fail('unsupported-api-field');
      fields.push(args[++i]);
    } else other.push(args[i]);
  }
  const { options, positional } = parseOptions(other, ['-X', '--method', '--input', '--hostname']);
  const method = oneOf(options, ['-X', '--method']) || (fields.length || options['--input'] ? 'POST' : 'GET');
  if (method === 'GET' && !fields.length && !options['--input']) return null;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('unsupported-api-method');
  if (options['--hostname'] && options['--hostname'] !== 'github.com') fail('unsupported-api-host');
  if (positional.length !== 1 || !/^\/?(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pulls|releases)(?:\/[0-9]+)?(?:\/comments)?|gists(?:\/[a-f0-9]+)?|user\/repos)$/.test(positional[0])) fail('unsupported-api-endpoint');
  if (method === 'POST' && /\/pulls$/.test(positional[0])) fail('pr-create-remote-diff-review-required');
  if (fields.length && options['--input']) fail('mixed-api-input-unsupported');
  const inv = inventory('gh-api', cwd, { host: 'github.com', method, endpoint: positional[0],
    ...(/^\/?(?:gists|user\/repos)$/.test(positional[0]) ? { account: resolveIdentity(cwd) } : {}) });
  addStructured(inv, 'destination', inv.destination);
  if (options['--input']) {
    const data = JSON.parse(localFile(cwd, options['--input']));
    if (!data || Array.isArray(data) || typeof data !== 'object') fail('api-object-required');
    // Encoded/remote file payloads and implicit release generation need adapters.
    if (/(?:"(?:content|encoding|generate_release_notes|template_repository|url|files)"\s*:)/i.test(JSON.stringify(data))) fail('unsupported-api-payload');
    addStructured(inv, 'api-json', data);
  }
  const keys = fields.map(field => field.slice(0, field.indexOf('=')));
  if (new Set(keys).size !== keys.length || keys.some(key => /^(?:content|encoding|generate_release_notes|template_repository|url|files)$/i.test(key))) fail('unsupported-api-payload');
  for (const field of fields) add(inv, `api-field-${inv.items.length}`, field);
  return inv;
}

const mcpFields = {
  create_repository: ['name', 'description', 'private', 'autoInit'],
  create_issue: ['owner', 'repo', 'title', 'body', 'assignees', 'labels', 'milestone'],
  update_issue: ['owner', 'repo', 'issue_number', 'title', 'body', 'state', 'assignees', 'labels', 'milestone'],
  add_issue_comment: ['owner', 'repo', 'issue_number', 'body'],
  create_pull_request: ['owner', 'repo', 'title', 'body', 'head', 'base', 'draft', 'maintainer_can_modify'],
  update_pull_request: ['owner', 'repo', 'pullNumber', 'title', 'body', 'state', 'base', 'maintainer_can_modify'],
  create_or_update_file: ['owner', 'repo', 'path', 'message', 'content', 'sha', 'branch'],
  push_files: ['owner', 'repo', 'branch', 'message', 'files']
};
function mcpInventory(cwd, tool, input) {
  const leaf = tool.split('__').at(-1);
  const github = /github/i.test(tool.split('__')[1] ?? '') || Object.hasOwn(mcpFields, leaf);
  if (!github) return null;
  if (/^(?:get_|list_|search_)/.test(leaf) || /_(?:read|view)$/.test(leaf)) return null;
  if (!Object.hasOwn(mcpFields, leaf)) fail('unsupported-github-mcp-write');
  if (!input || Object.keys(input).some(key => !mcpFields[leaf].includes(key))) fail('unsupported-mcp-field');
  if (leaf === 'create_repository') fail('mcp-account-destination-unavailable');
  if (leaf === 'create_pull_request') fail('pr-create-remote-diff-review-required');
  if (leaf !== 'create_repository' && (!REPO.test(`${input.owner}/${input.repo}`) || typeof input.owner !== 'string' || typeof input.repo !== 'string')) fail('explicit-mcp-destination-required');
  const inv = inventory(`mcp-${leaf}`, cwd, { host: 'github-mcp-server', tool, owner: input.owner, repo: input.repo, name: input.name });
  const metadata = { ...input };
  if (leaf === 'create_or_update_file') {
    if (typeof input.content !== 'string' || typeof input.path !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) fail('base64-file-content-required');
    add(inv, input.path, decode(Buffer.from(input.content, 'base64')), 'file');
    delete metadata.content;
  }
  if (leaf === 'push_files') {
    if (!Array.isArray(input.files) || !input.files.length || input.files.some(file => typeof file.path !== 'string' || typeof file.content !== 'string' || Object.keys(file).some(key => !['path', 'content'].includes(key)))) fail('explicit-mcp-files-required');
    for (const file of input.files) add(inv, file.path, file.content, 'file');
    delete metadata.files;
  }
  addStructured(inv, 'mcp-payload', metadata);
  return inv;
}

export function publicationInventory(input, { resolveIdentity = githubIdentity } = {}) {
  const cwd = input.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('absolute-hook-cwd-required');
  if (input.tool_name?.startsWith('mcp__')) return mcpInventory(cwd, input.tool_name, input.tool_input);
  if (input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') fail('missing-shell-command');
  const tokens = literalTokens(command);
  const publishes = containsPublication(command);
  if (!publishes) return null;
  if (!tokens) fail('ambiguous-shell-delivery');
  if (tokens[0] === 'git') return gitInventory(cwd, tokens.slice(1));
  if (tokens[0] === 'gh') {
    if (process.env.GH_HOST && process.env.GH_HOST !== 'github.com') fail('unsupported-gh-host');
    return ghInventory(cwd, tokens.slice(1), resolveIdentity);
  }
  fail('wrapped-delivery-unsupported');
}

export function placementTarget(input) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return null;
  const raw = input.tool_input?.file_path;
  if (typeof raw !== 'string') fail('write-path-required');
  const target = canonicalExistingParent(resolve(input.cwd, raw));
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  let root;
  // A filesystem walk distinguishes a normal non-repository write from Git failure.
  for (let p = ancestor;; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) { root = repoRoot(p); break; }
    if (p === dirname(p)) return null;
  }
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('write-target-outside-detected-repository');
  const ignored = git(root, ['check-ignore', '-q', '--', rel], { optional: true });
  return { path: rel, ignored: ignored !== null };
}
