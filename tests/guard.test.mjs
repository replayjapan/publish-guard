import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync, realpathSync, existsSync, appendFileSync, renameSync, openSync, closeSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateDirectory, writePrivate, readPrivate, recordReview, pendingName, TTL } from '../scripts/state.mjs';
import { sequenceHashes, ownerPrompt, scan, loadPrivacy, safeLabel, internalPath } from '../scripts/privacy.mjs';
import { literalTokens, publicationInventory, pushInventory, placementTarget } from '../scripts/inventory.mjs';
import { guard, evaluate } from '../scripts/guard.mjs';
import { checkPrePush, installPrePush } from '../scripts/control.mjs';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fictionalPrompt = Array.from({ length: 17 }, (_, i) => `observatory${i}`).join(' ');
const fictionalEmail = ['person', 'example.invalid'].join('@');
const noReplyEmail = ['noreply', 'example.invalid'].join('@');
const homePath = ['', 'Users', 'fictional-person', 'draft.txt'].join('/');
const privateDoc = ['notes', '.md'].join('');
const sampleKey = 'b'.repeat(64);
const privacy = (terms = []) => ({ terms, key: sampleKey, hashes: new Set(), historyStatus: 'available' });

function runGit(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, 'fixture Git operation failed');
  return result.stdout.trim();
}

function fixture(t, { repository = false } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'publish-guard-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const config = join(root, 'config');
  const history = join(config, 'projects', 'synthetic-project');
  mkdirSync(cwd);
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'synthetic.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: fictionalPrompt } }) + '\n');
  const env = { PUBLISH_GUARD_DATA_DIR: join(root, 'private-data'), CLAUDE_CONFIG_DIR: config };
  const dir = privateDirectory(env);
  if (repository) {
    runGit(cwd, 'init', '--initial-branch=main');
    runGit(cwd, 'config', 'user.name', 'Product Fixture');
    runGit(cwd, 'config', 'user.email', noReplyEmail);
    runGit(cwd, 'config', 'commit.gpgSign', 'false');
    runGit(cwd, 'config', 'tag.gpgSign', 'false');
    runGit(cwd, 'config', 'push.followTags', 'false');
    runGit(cwd, 'config', 'core.hooksPath', join(root, 'empty-hooks'));
    mkdirSync(join(root, 'empty-hooks'));
  }
  return { root, cwd, history, env, dir };
}
function bash(cwd, command) { return { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }; }
function attachRemote(f) {
  const remote = join(f.root, 'remote.git');
  runGit(f.root, 'init', '--bare', remote);
  runGit(f.cwd, 'remote', 'add', 'origin', remote);
  return remote;
}
const userRecord = content => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
function simpleInventory(cwd, text = 'Product release information.', destination = 'public-target') {
  return { version: 1, kind: 'fixture', cwd, destination, items: [{ id: 'item-1', type: 'file', label: 'README.md', text }] };
}

test('detectors identify fictional data without returning matching text', () => {
  const secret = ['gh', 'p_', 'a'.repeat(30)].join('');
  const session = ['https:', '', 'claude.ai', 'chat', 'fictional-session'].join('/');
  const trailer = ['Claude', 'Session'].join('-') + ': fictional';
  const text = [fictionalEmail, homePath, secret, session, trailer, privateDoc].join('\n');
  const findings = scan(text, privacy());
  for (const category of ['personal-email', 'home-path', 'secret', 'session-link', 'session-trailer']) assert.ok(findings.some(f => f.category === category), category);
  assert.ok(scan(privateDoc, privacy(), { path: true }).some(f => f.category === 'internal-document'));
  assert.equal(findings.find(f => f.category === 'home-path').line, 2);
  assert.ok(!JSON.stringify(findings).includes('fictional'));
  assert.deepEqual(scan(noReplyEmail, privacy()), []);
  assert.equal(safeLabel(homePath, privacy()), '[redacted label]');
  assert.equal(safeLabel('Project Zenith.md', privacy(['Zenith'])), '[redacted label]');
});

test('prompt matching normalizes punctuation and does not match short sequences', () => {
  const p = privacy();
  p.hashes = new Set(sequenceHashes(fictionalPrompt, sampleKey).map(item => item.hash));
  assert.ok(scan(fictionalPrompt.toUpperCase().replaceAll(' ', ', '), p).some(f => f.category === 'owner-message'));
  assert.deepEqual(scan(fictionalPrompt.split(' ').slice(0, 8).join(' '), p), []);
});

test('Git transport identity is not mistaken for an email in destination context', () => {
  const address = ['git', 'github.com'].join('@');
  assert.deepEqual(scan(address + ':sample/product.git', privacy(), { transport: true }), []);
  assert.deepEqual(scan('ssh://' + address + '/sample/product.git', privacy(), { transport: true }), []);
  assert.ok(scan(address, privacy()).some(finding => finding.category === 'personal-email'));
});

test('history excludes tools, assistant text, notifications and metadata', () => {
  const base = { type: 'user', message: { role: 'user', content: fictionalPrompt } };
  assert.equal(ownerPrompt(base), fictionalPrompt);
  assert.equal(ownerPrompt({ ...base, isMeta: true }), null);
  assert.equal(ownerPrompt({ ...base, isSidechain: true }), null);
  assert.equal(ownerPrompt({ ...base, type: 'assistant' }), null);
  assert.equal(ownerPrompt({ ...base, message: { role: 'user', content: [{ type: 'tool_result', content: fictionalPrompt }] } }), null);
  assert.equal(ownerPrompt({ ...base, message: { role: 'user', content: '<task-notification>synthetic</task-notification>' } }), null);
});

test('history cache stores hashes only and corrupt history blocks', t => {
  const f = fixture(t);
  const p = loadPrivacy(f.dir, f.env);
  assert.equal(p.historyStatus, 'available');
  assert.ok(scan(fictionalPrompt, p).some(finding => finding.category === 'owner-message'));
  const cache = readdirSync(f.dir).filter(name => /^(?:owner-index|sequence-.*)\.json$/.test(name)).map(name => readFileSync(join(f.dir, name), 'utf8')).join('\n');
  assert.ok(!cache.includes(fictionalPrompt.split(' ')[0]));
  assert.ok(!cache.includes(f.history));
  assert.ok([...p.hashes].every(value => /^[a-f0-9]{64}$/.test(value)));
  writeFileSync(join(f.history, 'synthetic.jsonl'), '{broken\n');
  assert.equal(loadPrivacy(f.dir, f.env).historyStatus, 'unavailable');
  assert.equal(evaluate(simpleInventory(f.cwd), f.dir, loadPrivacy(f.dir, f.env)).allowed, false);
});

test('private state rejects repository placement, links and loose permissions', t => {
  const f = fixture(t, { repository: true });
  assert.throws(() => privateDirectory({ PUBLISH_GUARD_DATA_DIR: join(f.cwd, 'state') }), /private-state-in-repository/);
  const alias = join(f.root, 'alias');
  symlinkSync(f.dir, alias);
  assert.throws(() => privateDirectory({ PUBLISH_GUARD_DATA_DIR: alias }), /private-state-symlink/);
  writePrivate(f.dir, 'sample.json', { harmless: true });
  assert.equal(statSync(join(f.dir, 'sample.json')).mode & 0o777, 0o600);
  chmodSync(join(f.dir, 'sample.json'), 0o644);
  assert.throws(() => readPrivate(f.dir, 'sample.json'), /private-file-permissions/);
});

test('review requires every item, expires and changes with destination or content', t => {
  const f = fixture(t);
  const inv = simpleInventory(f.cwd);
  const now = 100000;
  const first = evaluate(inv, f.dir, privacy(), now);
  assert.equal(first.allowed, false);
  assert.throws(() => recordReview(f.dir, first.digest, {}, now), /classify-every-item/);
  assert.throws(() => recordReview(f.dir, first.digest, { 'item-1': 'doubtful' }, now), /private-or-doubtful/);
  recordReview(f.dir, first.digest, { 'item-1': 'product' }, now);
  assert.equal(evaluate(inv, f.dir, privacy(), now + 1).allowed, true);
  assert.equal(evaluate(simpleInventory(f.cwd, 'Updated product information.'), f.dir, privacy(), now + 1).allowed, false);
  assert.equal(evaluate(simpleInventory(f.cwd, inv.items[0].text, 'other-target'), f.dir, privacy(), now + 1).allowed, false);
  assert.equal(evaluate(inv, f.dir, privacy(), now + TTL + 1).allowed, false);
});

test('new findings invalidate an existing review without exposing content or labels', t => {
  const f = fixture(t);
  const inv = simpleInventory(f.cwd, 'Project Zenith product guide.');
  const first = evaluate(inv, f.dir, privacy());
  recordReview(f.dir, first.digest, { 'item-1': 'product' });
  assert.equal(evaluate(inv, f.dir, privacy(['Zenith'])).allowed, false);
  assert.throws(() => recordReview(f.dir, first.digest, { 'item-1': 'product' }), /findings-must-be-resolved/);
  const sensitive = simpleInventory(f.cwd, fictionalEmail);
  sensitive.items[0].label = homePath;
  const result = evaluate(sensitive, f.dir, privacy());
  const stored = readFileSync(join(f.dir, pendingName(result.digest)), 'utf8');
  assert.ok(!stored.includes(fictionalEmail));
  assert.ok(!stored.includes(homePath));
  assert.ok(!stored.includes(f.cwd));
});

test('literal parser and classifier reject composed and wrapped delivery', t => {
  const f = fixture(t);
  assert.deepEqual(literalTokens("git commit -m 'Product change'"), ['git', 'commit', '-m', 'Product change']);
  assert.equal(literalTokens('git push origin HEAD:refs/heads/main && echo done'), null);
  for (const command of ['git push origin HEAD:refs/heads/main; echo done', 'env git push origin HEAD:refs/heads/main', 'git -c alias.ship=push ship', 'gh release create v1 --generate-notes', 'gh api --method POST /unknown']) {
    assert.throws(() => publicationInventory(bash(f.cwd, command)));
  }
  assert.equal(publicationInventory(bash(f.cwd, 'node build.mjs')), null);
});

test('everyday Git and GitHub commands bypass publication and history checks', t => {
  const f = fixture(t);
  rmSync(join(f.root, 'config'), { recursive: true });
  const commands = [
    'git status', 'git branch', 'git stash list', 'git stash push', 'git remote -v',
    'git pull', 'git merge main', 'git config --get user.name', 'git config user.name Product',
    'git init', 'git clone source target', 'git reset --hard HEAD', 'git rebase main',
    'git grep publication', 'git tag --list', 'git tag -d old-tag',
    'git -C /tmp status && git log -1', 'git status | cat',
    'grep -rn "git " README.md', 'grep "git push" README.md', 'echo git commit',
    'grep install-pre-push README.md', 'npm test', 'env git status',
    'bash -lc "git status && git log -1"',
    'gh auth status', 'gh run list', 'gh workflow list', 'gh search repos product', 'gh browse',
    'gh api repos/sample/product', 'gh api --method GET repos/sample/product/issues --paginate',
    'gh api repos/sample/product --jq .name', 'gh repo clone sample/product',
    'gh issue list --json title | cat', 'gh pr view 1 && gh run list'
  ];
  for (const command of commands) assert.deepEqual(guard(bash(f.cwd, command), f.env), {}, command);
  assert.deepEqual(readdirSync(f.dir), [], 'ordinary commands must not initialize privacy state');
});

test('composed and wrapped publication still stops without gating quoted data', t => {
  const f = fixture(t);
  for (const command of [
    'git status && git push origin main', 'env MODE=product git push origin main', 'time -p git push origin main',
    'bash -lc "git status; git commit -m Product"', 'command git push origin main',
    'if git push origin main; then echo done; fi',
    'echo "$(git push origin main)"', 'echo `git push origin main`',
    'gh auth status && gh release create v1', 'env gh api -XPOST repos/sample/product/issues',
    'gh api --method=POST repos/sample/product/issues'
  ]) assert.throws(() => publicationInventory(bash(f.cwd, command)), undefined, command);
});

test('large history streams once and unchanged or appended files use the index', t => {
  const f = fixture(t);
  const path = join(f.history, 'large.jsonl');
  const fd = openSync(path, 'w');
  try {
    writeFileSync(fd, '{"type":"assistant","message":{"role":"assistant","content":"');
    const block = Buffer.alloc(1024 * 1024, 120);
    for (let n = 0; n < 70; n++) writeFileSync(fd, block);
    writeFileSync(fd, '"}}\n');
  } finally { closeSync(fd); }
  const first = loadPrivacy(f.dir, f.env);
  assert.equal(first.historyStatus, 'available');
  assert.ok(first.metrics.bytesRead > 64 * 1024 * 1024);
  const warm = loadPrivacy(f.dir, f.env);
  assert.equal(warm.historyStatus, 'available');
  assert.equal(warm.metrics.bytesRead, 0);
  const added = Array.from({ length: 14 }, (_, n) => `telescope${n}`).join(' ');
  const appended = userRecord(added);
  appendFileSync(path, appended);
  const next = loadPrivacy(f.dir, f.env);
  assert.equal(next.metrics.bytesRead, Buffer.byteLength(appended));
  assert.ok(scan(added, next).some(finding => finding.category === 'owner-message'));
});

test('history truncation, replacement and disappearance drop obsolete hash pages', t => {
  const f = fixture(t);
  const path = join(f.history, 'synthetic.jsonl');
  const first = loadPrivacy(f.dir, f.env);
  const oldHashes = [...first.hashes];
  const shortened = Array.from({ length: 12 }, (_, n) => `star${n}`).join(' ');
  writeFileSync(path, userRecord(shortened));
  const truncated = loadPrivacy(f.dir, f.env);
  assert.equal(truncated.historyStatus, 'available');
  assert.ok(oldHashes.every(value => !truncated.hashes.has(value)));
  renameSync(path, join(f.root, 'old-fixture.jsonl'));
  writeFileSync(path, userRecord(fictionalPrompt));
  const replaced = loadPrivacy(f.dir, f.env);
  assert.ok(scan(fictionalPrompt, replaced).some(finding => finding.category === 'owner-message'));
  assert.ok([...truncated.hashes].every(value => !replaced.hashes.has(value)));
  rmSync(path);
  const removed = loadPrivacy(f.dir, f.env);
  assert.equal(removed.historyStatus, 'unavailable');
  assert.equal(removed.hashes.size, 0);
  assert.deepEqual(readdirSync(f.dir).filter(name => name.startsWith('sequence-')), []);
});

test('indexing checkpoints can resume within a large skipped record', t => {
  const f = fixture(t);
  const path = join(f.history, 'synthetic.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n' + userRecord(fictionalPrompt));
  let tick = 0;
  const partial = loadPrivacy(f.dir, f.env, { now: () => tick++, budgetMs: 4 });
  assert.equal(partial.historyStatus, 'indexing');
  const entry = Object.values(readPrivate(f.dir, 'owner-index.json').entries)[0];
  assert.ok(entry.offset > 0);
  assert.equal(entry.skippingLine, true);
  const resumed = loadPrivacy(f.dir, f.env);
  assert.equal(resumed.historyStatus, 'available');
  assert.ok(resumed.metrics.bytesRead < statSync(path).size);
  assert.ok(scan(fictionalPrompt, resumed).some(finding => finding.category === 'owner-message'));
});

test('same-size history edits rebuild the file hash set', t => {
  const f = fixture(t);
  const path = join(f.history, 'synthetic.jsonl');
  const first = loadPrivacy(f.dir, f.env), before = statSync(path);
  const replacement = fictionalPrompt.replaceAll('observatory', 'planetarium');
  writeFileSync(path, userRecord(replacement));
  assert.equal(statSync(path).size, before.size);
  utimesSync(path, before.atime, new Date(before.mtimeMs + 2000));
  const second = loadPrivacy(f.dir, f.env);
  assert.equal(second.historyStatus, 'available');
  assert.ok([...first.hashes].every(value => !second.hashes.has(value)));
  assert.ok(scan(replacement, second).some(finding => finding.category === 'owner-message'));
});

test('valid unterminated final records and later append preserve exact prompt hashes', t => {
  const f = fixture(t);
  const path = join(f.history, 'synthetic.jsonl');
  writeFileSync(path, userRecord(fictionalPrompt).trimEnd());
  assert.equal(loadPrivacy(f.dir, f.env).historyStatus, 'available');
  assert.equal(loadPrivacy(f.dir, f.env).metrics.bytesRead, 0);
  const nextPrompt = Array.from({ length: 13 }, (_, n) => `nebula${n}`).join(' ');
  appendFileSync(path, '\n' + userRecord(nextPrompt));
  const next = loadPrivacy(f.dir, f.env);
  assert.equal(next.historyStatus, 'available');
  for (const prompt of [fictionalPrompt, nextPrompt]) assert.ok(scan(prompt, next).some(finding => finding.category === 'owner-message'));
});

test('commit inventory reads staged blobs instead of working-tree contents', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), fictionalEmail);
  runGit(f.cwd, 'add', 'README.md');
  writeFileSync(join(f.cwd, 'README.md'), 'Clean working copy.');
  const inv = publicationInventory(bash(f.cwd, "git commit -m 'Product change'"));
  const staged = inv.items.find(item => item.type === 'file' && item.label === 'README.md');
  assert.equal(staged.text, fictionalEmail);
  assert.equal(staged.blob, runGit(f.cwd, 'rev-parse', ':README.md'));
  const report = evaluate(inv, f.dir, privacy());
  assert.equal(report.allowed, false);
  assert.ok(report.items.find(item => item.id === staged.id).findings.some(finding => finding.category === 'personal-email'));
  assert.throws(() => publicationInventory(bash(f.cwd, "git commit -a -m 'Product change'")));
});

test('executable commit hooks do not prevent reviewing the staged snapshot', t => {
  const f = fixture(t, { repository: true });
  const hook = join(f.root, 'empty-hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(f.cwd, 'README.md'), 'Public product guide.');
  runGit(f.cwd, 'add', 'README.md');
  const inv = publicationInventory(bash(f.cwd, 'git commit -m Product'));
  assert.equal(inv.kind, 'commit');
  assert.equal(evaluate(inv, f.dir, privacy()).blocked, false);
  writeFileSync(join(f.root, 'empty-hooks', 'commit-msg'), `#!/bin/sh\nprintf '%s\\n' '${fictionalEmail}' >> "$1"\n`, { mode: 0o700 });
  runGit(f.cwd, 'commit', '-m', 'Product');
  attachRemote(f);
  const pushed = publicationInventory(bash(f.cwd, 'git push origin main'));
  assert.equal(evaluate(pushed, f.dir, privacy()).blocked, true, 'the created commit is rescanned after hooks ran');
});

test('push inspects removed historical content and tag metadata without a network', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), fictionalEmail);
  runGit(f.cwd, 'add', 'README.md');
  runGit(f.cwd, 'commit', '-m', 'Initial product');
  writeFileSync(join(f.cwd, 'README.md'), 'Public product guide.');
  runGit(f.cwd, 'add', 'README.md');
  runGit(f.cwd, 'commit', '-m', 'Update product');
  attachRemote(f);
  const inv = pushInventory(f.cwd, 'origin', [{ source: 'HEAD', destination: 'refs/heads/main' }]);
  assert.ok(inv.items.some(item => item.text === fictionalEmail));
  assert.equal(evaluate(inv, f.dir, privacy()).allowed, false);
  runGit(f.cwd, 'tag', '-a', 'v1', '-m', fictionalEmail);
  const tag = pushInventory(f.cwd, 'origin', [{ source: 'refs/tags/v1', destination: 'refs/tags/v1' }]);
  assert.ok(tag.items.some(item => item.label.startsWith('tag-') && item.text.includes(fictionalEmail)));
});

test('pre-push and tool inventory bind the same actual objects and destination', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), 'Public product guide.');
  runGit(f.cwd, 'add', 'README.md');
  runGit(f.cwd, 'commit', '-m', 'Initial product');
  const url = attachRemote(f);
  const inv = publicationInventory(bash(f.cwd, 'git push origin HEAD:refs/heads/main'));
  const first = evaluate(inv, f.dir, loadPrivacy(f.dir, f.env));
  assert.equal(first.blocked, false);
  recordReview(f.dir, first.digest, Object.fromEntries(first.items.map(item => [item.id, 'product'])));
  const oid = runGit(f.cwd, 'rev-parse', 'HEAD');
  const update = `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(oid.length)}\n`;
  assert.equal(checkPrePush(f.cwd, 'origin', url, update, f.env).allowed, true);
  assert.throws(() => checkPrePush(f.cwd, 'origin', url + '/other', update, f.env), /destination-mismatch/);
});

test('push uses actual remote reachability and accepts common refspecs and leases', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'old.md'), fictionalEmail);
  writeFileSync(join(f.cwd, 'already-remote.bin'), Buffer.from([0, 1, 2]));
  runGit(f.cwd, 'add', '.');
  runGit(f.cwd, 'commit', '-m', 'Existing product');
  attachRemote(f);
  runGit(f.cwd, 'push', 'origin', 'main');
  writeFileSync(join(f.cwd, 'README.md'), 'New product guide.');
  runGit(f.cwd, 'add', 'README.md');
  runGit(f.cwd, 'commit', '-m', 'New product');
  const oid = runGit(f.cwd, 'rev-parse', 'HEAD');
  // Deliberately lie in the tracking ref: only the advertised remote is trusted.
  runGit(f.cwd, 'update-ref', 'refs/remotes/origin/main', oid);
  const digests = new Set();
  for (const refspec of ['main', 'main:main', 'HEAD:main', 'refs/heads/main:refs/heads/main']) {
    const inv = publicationInventory(bash(f.cwd, `git push --force-with-lease origin ${refspec}`));
    assert.equal(inv.scanMode, 'outgoing');
    assert.ok(inv.items.some(item => item.text === 'New product guide.'));
    assert.ok(!inv.items.some(item => item.text.includes(fictionalEmail)));
    const report = evaluate(inv, f.dir, privacy());
    assert.equal(report.blocked, false);
    digests.add(report.digest);
  }
  assert.equal(digests.size, 1);
  writeFileSync(join(f.cwd, 'new.md'), fictionalEmail);
  runGit(f.cwd, 'add', 'new.md');
  runGit(f.cwd, 'commit', '-m', 'Another product change');
  runGit(f.cwd, 'update-ref', 'refs/remotes/origin/main', runGit(f.cwd, 'rev-parse', 'HEAD'));
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, privacy()).blocked, true);
});

test('missing remote objects trigger a full scan and unavailable remotes stop', t => {
  const f = fixture(t, { repository: true }), other = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), fictionalEmail);
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Local product');
  const remote = attachRemote(f);
  writeFileSync(join(other.cwd, 'README.md'), 'Unrelated remote product.');
  runGit(other.cwd, 'add', '.'); runGit(other.cwd, 'commit', '-m', 'Remote product');
  runGit(other.cwd, 'remote', 'add', 'origin', remote);
  runGit(other.cwd, 'push', 'origin', 'main');
  const inv = publicationInventory(bash(f.cwd, 'git push --force-with-lease origin main'));
  assert.equal(inv.scanMode, 'full-missing-remote-objects');
  assert.equal(evaluate(inv, f.dir, privacy()).blocked, true);
  runGit(f.cwd, 'remote', 'set-url', 'origin', join(f.root, 'absent.git'));
  assert.throws(() => publicationInventory(bash(f.cwd, 'git push origin main')), /git-inspection-failed/);
});

test('GitHub text inputs are inspected and binaries and generated inputs stop', t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'body.txt'), fictionalEmail);
  const inv = publicationInventory(bash(f.cwd, 'gh issue create -R sample/product --title Update --body-file body.txt'));
  assert.ok(inv.items.some(item => item.text === fictionalEmail));
  const api = publicationInventory(bash(f.cwd, "gh api --method POST repos/sample/product/issues -f title=Update -f body='Product details'"));
  assert.equal(api.kind, 'gh-api');
  writeFileSync(join(f.cwd, 'asset.bin'), Buffer.from([0, 1, 2]));
  assert.throws(() => publicationInventory(bash(f.cwd, 'gh release upload v1 asset.bin -R sample/product')), /binary|asset-format/);
  assert.throws(() => publicationInventory(bash(f.cwd, 'gh pr create -R sample/product --title Update --body Details')), /remote-diff/);
  assert.throws(() => publicationInventory(bash(f.cwd, 'gh release create v1 -R sample/product --generate-notes')));
});

test('MCP file content is decoded and unknown writes are blocked', t => {
  const f = fixture(t);
  const inv = publicationInventory({ cwd: f.cwd, tool_name: 'mcp__github__create_or_update_file', tool_input: { owner: 'sample', repo: 'product', path: 'README.md', message: 'Product update', branch: 'main', content: Buffer.from(fictionalEmail).toString('base64') } });
  assert.ok(inv.items.some(item => item.text === fictionalEmail));
  assert.throws(() => publicationInventory({ cwd: f.cwd, tool_name: 'mcp__github__unknown_write', tool_input: {} }), /unsupported-github/);
  assert.equal(publicationInventory({ cwd: f.cwd, tool_name: 'mcp__github__get_issue', tool_input: {} }), null);
});

test('structured API and MCP text is scanned after JSON escapes are decoded', t => {
  const f = fixture(t);
  const body = fictionalPrompt.split(' ').join('\n');
  writeFileSync(join(f.cwd, 'payload.json'), JSON.stringify({ title: 'Product', body }));
  const api = publicationInventory(bash(f.cwd, 'gh api --method POST repos/sample/product/issues --input payload.json'));
  const p = loadPrivacy(f.dir, f.env);
  assert.ok(evaluate(api, f.dir, p).items.some(item => item.findings.some(finding => finding.category === 'owner-message')));
  const mcp = publicationInventory({ cwd: f.cwd, tool_name: 'mcp__github__add_issue_comment', tool_input: { owner: 'sample', repo: 'product', issue_number: 1, body } });
  assert.ok(evaluate(mcp, f.dir, p).items.some(item => item.findings.some(finding => finding.category === 'owner-message')));
  assert.throws(() => publicationInventory(bash(f.cwd, 'gh api --method POST repos/sample/product/pulls --input payload.json')), /remote-diff/);
});

test('repository and gist edits require explicit noninteractive destinations', t => {
  const f = fixture(t);
  const repo = publicationInventory(bash(f.cwd, "gh repo edit sample/product --description 'Product information'"));
  assert.equal(repo.destination.repository, 'sample/product');
  writeFileSync(join(f.cwd, 'body.txt'), fictionalEmail);
  const gist = publicationInventory(bash(f.cwd, `gh gist edit ${'a'.repeat(32)} --filename product.txt body.txt`));
  assert.ok(gist.items.some(item => item.label === 'product.txt' && item.text === fictionalEmail));
  assert.throws(() => publicationInventory(bash(f.cwd, `gh gist edit ${'a'.repeat(32)}`)), /interactive/);
});

test('reviews bind release visibility and the resolved gist account', t => {
  const f = fixture(t);
  const command = 'gh release create v1 -R sample/product --verify-tag --title Product --notes Details';
  const published = evaluate(publicationInventory(bash(f.cwd, command)), f.dir, privacy());
  const draft = evaluate(publicationInventory(bash(f.cwd, command + ' --draft')), f.dir, privacy());
  assert.notEqual(published.digest, draft.digest);
  writeFileSync(join(f.cwd, 'product.txt'), 'Public product information.');
  const gist = bash(f.cwd, 'gh gist create product.txt --public');
  const first = publicationInventory(gist, { resolveIdentity: () => 'sample-account-one' });
  const second = publicationInventory(gist, { resolveIdentity: () => 'sample-account-two' });
  assert.notEqual(evaluate(first, f.dir, privacy()).digest, evaluate(second, f.dir, privacy()).digest);
});

test('placement resolves symlink aliases and honors ignored paths', t => {
  const f = fixture(t, { repository: true });
  const alias = join(f.root, 'project-alias');
  symlinkSync(f.cwd, alias);
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: f.cwd, tool_input: { file_path: join(alias, privateDoc), content: 'Synthetic information' } };
  assert.equal(placementTarget(input).path, privateDoc);
  assert.equal(guard(input, f.env).hookSpecificOutput.permissionDecision, 'deny');
  writeFileSync(join(f.cwd, '.gitignore'), privateDoc + '\n');
  assert.deepEqual(guard(input, f.env), {});
});

test('internal names apply only to document paths and bare home shorthand is harmless', () => {
  for (const path of ['transcript-index.mjs', 'internal/parser.js', 'Planning/view.ts', 'notes.css']) {
    assert.equal(internalPath(path), false);
    assert.deepEqual(scan(path, privacy(), { path: true }), []);
  }
  for (const path of [privateDoc, ['Planning', 'brief.rst'].join('/'), 'internal/trace.jsonl']) assert.equal(internalPath(path), true);
  const mention = ['See', ['Planning', ''].join('/'), 'and', ['HANDOFF', 'md'].join('.')].join(' ');
  assert.deepEqual(scan(mention, privacy()), []);
  const shorthand = '~' + '/';
  assert.deepEqual(scan(`const prefix = '${shorthand}';`, privacy()), []);
  assert.ok(scan(shorthand + 'private/draft.txt', privacy()).some(f => f.category === 'home-path'));
});

test('staged scanning ignores old lines and binaries but catches a changed private line at its real line number', t => {
  const f = fixture(t, { repository: true });
  const baseline = fictionalEmail + '\nOriginal product guide.\n';
  writeFileSync(join(f.cwd, 'README.md'), baseline);
  writeFileSync(join(f.cwd, 'asset.bin'), Buffer.from([0, 1]));
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Baseline');
  writeFileSync(join(f.cwd, 'README.md'), baseline + 'Additional product detail.\n');
  runGit(f.cwd, 'add', 'README.md');
  const inv = publicationInventory(bash(f.cwd, 'git commit -m Update'));
  assert.equal(evaluate(inv, f.dir, privacy()).blocked, false);
  assert.deepEqual(inv.items.find(item => item.type === 'file').scanRanges, [[3, 3]]);
  writeFileSync(join(f.cwd, 'README.md'), baseline + homePath + '\n');
  runGit(f.cwd, 'add', 'README.md');
  const bad = evaluate(publicationInventory(bash(f.cwd, 'git commit -m Update')), f.dir, privacy());
  const findings = bad.items.flatMap(item => item.findings);
  assert.ok(findings.some(f => f.category === 'home-path' && f.line === 3));
  assert.ok(!findings.some(f => f.category === 'personal-email'));
});

test('deletions and mode-only changes do not rescan old content but change the digest', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), fictionalEmail + '\nPublic guide.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Baseline');
  const before = evaluate(publicationInventory(bash(f.cwd, 'git commit -m Update')), f.dir, privacy());
  writeFileSync(join(f.cwd, 'README.md'), 'Public guide.\n');
  runGit(f.cwd, 'add', '.');
  const deletion = evaluate(publicationInventory(bash(f.cwd, 'git commit -m Update')), f.dir, privacy());
  assert.equal(deletion.blocked, false);
  assert.notEqual(before.digest, deletion.digest);
  runGit(f.cwd, 'reset', '--hard', 'HEAD');
  runGit(f.cwd, 'update-index', '--chmod=+x', 'README.md');
  const mode = evaluate(publicationInventory(bash(f.cwd, 'git commit -m Update')), f.dir, privacy());
  assert.equal(mode.blocked, false);
  assert.notEqual(before.digest, mode.digest);
});

test('new outgoing paths inspect reused remote blob content', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'old.md'), fictionalEmail + '\nProduct guide.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Baseline');
  attachRemote(f); runGit(f.cwd, 'push', 'origin', 'main');
  writeFileSync(join(f.cwd, 'old.md'), fictionalEmail + '\nProduct guide.\nNew product detail.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Update');
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, privacy()).blocked, false);
  writeFileSync(join(f.cwd, 'copy.md'), fictionalEmail + '\nProduct guide.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Copy');
  const report = evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, privacy());
  assert.ok(report.items.some(item => item.label === 'copy.md' && item.findings.some(f => f.category === 'personal-email')));
});

test('a private line added then removed remains in the outgoing review', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), 'Public guide.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Baseline');
  attachRemote(f); runGit(f.cwd, 'push', 'origin', 'main');
  appendFileSync(join(f.cwd, 'README.md'), fictionalEmail + '\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Addition');
  writeFileSync(join(f.cwd, 'README.md'), 'Public guide.\n');
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Removal');
  const report = evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, privacy());
  assert.ok(report.items.some(item => item.findings.some(f => f.category === 'personal-email' && f.line === 2)));
});

test('changed lines detect owner sequences spanning unchanged context', () => {
  const p = privacy();
  p.hashes = new Set(sequenceHashes(fictionalPrompt, p.key).map(item => item.hash));
  const words = fictionalPrompt.split(' ');
  const text = words.slice(0, 10).join(' ') + '\n' + words.slice(10).join(' ');
  assert.ok(scan(text, p, { ranges: [[2, 2]] }).some(f => f.category === 'owner-message'));
  assert.deepEqual(scan(text, p, { ranges: [[3, 3]] }), []);
});

test('prompt exclusions use HEAD for commits and remote content rather than local HEAD for pushes', t => {
  const f = fixture(t, { repository: true });
  writeFileSync(join(f.cwd, 'README.md'), fictionalPrompt);
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Baseline');
  const p = loadPrivacy(f.dir, f.env);
  writeFileSync(join(f.cwd, 'copy.md'), fictionalPrompt);
  runGit(f.cwd, 'add', '.');
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git commit -m Copy')), f.dir, p).blocked, false);
  runGit(f.cwd, 'commit', '-m', 'Copy');
  attachRemote(f);
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, p).blocked, true);
  runGit(f.cwd, 'push', 'origin', 'main');
  writeFileSync(join(f.cwd, 'another.md'), fictionalPrompt);
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Another copy');
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, p).blocked, false);
  appendFileSync(join(f.cwd, 'another.md'), '\n' + fictionalEmail);
  runGit(f.cwd, 'add', '.'); runGit(f.cwd, 'commit', '-m', 'Changed copy');
  assert.equal(evaluate(publicationInventory(bash(f.cwd, 'git push origin main')), f.dir, p).blocked, true);
});

test('installed plugin text suppresses only prompt matches and changes invalidate the review', t => {
  const f = fixture(t);
  const root = join(f.root, 'installed-plugin');
  mkdirSync(root); mkdirSync(join(f.root, 'config', 'plugins'));
  writeFileSync(join(root, 'SKILL.md'), fictionalPrompt);
  const registry = join(f.root, 'config', 'plugins', 'installed_plugins.json');
  writeFileSync(registry, JSON.stringify({ version: 2, plugins: { 'sample@product': [{ installPath: root }] } }));
  const p = loadPrivacy(f.dir, f.env);
  const inv = simpleInventory(f.cwd, fictionalPrompt);
  const clean = evaluate(inv, f.dir, p);
  assert.equal(clean.blocked, false);
  recordReview(f.dir, clean.digest, { 'item-1': 'product' });
  assert.equal(evaluate(inv, f.dir, p).allowed, true);
  assert.equal(evaluate(simpleInventory(f.cwd, fictionalPrompt + '\n' + fictionalEmail), f.dir, p).blocked, true);
  writeFileSync(join(root, 'SKILL.md'), 'Different public content.');
  const changed = evaluate(inv, f.dir, p);
  assert.equal(changed.blocked, true);
  assert.notEqual(changed.digest, clean.digest);
  symlinkSync(join(f.history, 'synthetic.jsonl'), join(root, 'linked.txt'));
  assert.equal(evaluate(inv, f.dir, p).blocked, true, 'linked private files never become exclusion evidence');
});

test('skill expansions are filtered and a legacy history cache is rebuilt', t => {
  const f = fixture(t);
  const expanded = Array.from({ length: 15 }, (_, i) => `expansion${i}`).join(' ');
  const base = { type: 'user', message: { role: 'user', content: expanded } };
  for (const record of [
    { ...base, isInjected: true }, { ...base, isSkill: true }, { ...base, isCommand: true },
    { ...base, message: { role: 'user', content: 'Base directory for this skill: /synthetic/plugin\n' + expanded } },
    { ...base, message: { role: 'user', content: '<skill-content>' + expanded + '</skill-content>' } },
    { ...base, message: { role: 'user', content: '<command-args>' + expanded + '</command-args>' } }
  ]) {
    assert.equal(ownerPrompt(record), null);
    appendFileSync(join(f.history, 'synthetic.jsonl'), JSON.stringify(record) + '\n');
  }
  const first = loadPrivacy(f.dir, f.env);
  const legacy = readPrivate(f.dir, 'owner-index.json');
  legacy.version = 2; writePrivate(f.dir, 'owner-index.json', legacy);
  const rebuilt = loadPrivacy(f.dir, f.env);
  assert.ok(rebuilt.metrics.bytesRead > 0);
  assert.equal(rebuilt.historyStatus, 'available');
  assert.deepEqual(scan(expanded, rebuilt), []);
  assert.ok(scan(fictionalPrompt, rebuilt).length);
  assert.deepEqual([...first.hashes], [...rebuilt.hashes]);
});

test('owner-shaped override input cannot issue an exception', t => {
  const f = fixture(t);
  const result = guard({ hook_event_name: 'UserPromptExpansion', command_name: 'publish-guard:allow', command_args: 'a'.repeat(64), expansion_type: 'slash_command', command_source: 'plugin', cwd: f.cwd }, f.env);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /disabled/);
  assert.deepEqual(readdirSync(f.dir), []);
});

test('optional installer refuses replacements and does not change Git configuration', t => {
  const f = fixture(t, { repository: true });
  runGit(f.cwd, 'config', '--unset', 'core.hooksPath');
  const before = readFileSync(join(f.cwd, '.git', 'config'), 'utf8');
  assert.throws(() => installPrePush(f.cwd, { CLAUDECODE: '1' }), /owner-terminal/);
  assert.equal(installPrePush(f.cwd, {}).gitConfigChanged, false);
  assert.equal(readFileSync(join(f.cwd, '.git', 'config'), 'utf8'), before);
  assert.throws(() => installPrePush(f.cwd, {}));
  assert.equal(statSync(join(f.cwd, '.git', 'hooks', 'pre-push')).mode & 0o777, 0o700);
});

test('malformed hook input blocks without echoing input or stack traces', () => {
  const result = spawnSync(process.execPath, [join(plugin, 'scripts', 'guard.mjs')], { input: '{' + fictionalEmail, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!result.stdout.includes(fictionalEmail));
  assert.equal(result.stderr, '');
});

test('hook failures are configured to block and distribution has no literal fixture hazards', () => {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  for (const registrations of Object.values(hooks.hooks)) for (const registration of registrations) for (const hook of registration.hooks) assert.equal(hook.onFailure, 'block');
  const inspect = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) inspect(path);
      else {
        assert.deepEqual(scan(readFileSync(path, 'utf8'), privacy()), [], 'distribution contains a literal detector fixture');
        assert.ok(!readFileSync(path, 'utf8').includes(fictionalPrompt));
      }
    }
  };
  inspect(plugin);
  assert.equal(existsSync(join(plugin, 'node_modules')), false);
});
