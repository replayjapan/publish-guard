import { constants, existsSync, lstatSync, openSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, GuardError, privateDirectory, recordReview, readPrivate, writePrivate, pendingName } from './state.mjs';
import { loadPrivacy } from './privacy.mjs';
import { git, repoRoot, pushInventory } from './inventory.mjs';
import { evaluate, readInput } from './guard.mjs';

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function installPrePush(cwd, env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CODEX_THREAD_ID) fail('owner-terminal-required');
  const root = repoRoot(cwd);
  if (git(root, ['config', '--get', 'core.hooksPath'], { optional: true })) fail('custom-hooks-path-not-modified');
  const path = resolve(root, git(root, ['rev-parse', '--git-path', 'hooks/pre-push']).toString('utf8').trim());
  const parent = dirname(path);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) fail('unsafe-hook-directory');
  const script = fileURLToPath(import.meta.url);
  const content = `#!/bin/sh\n# Publish Guard: local installation, never distribute this generated file.\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} pre-push "$@"\n`;
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o700);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
  return { status: 'pre-push-installed', existingHooksReplaced: false, gitConfigChanged: false };
}

export function checkPrePush(cwd, remote, url, text, env = process.env) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length) return { allowed: true, status: 'no-updates' };
  const updates = lines.map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields[1]) || /^0+$/.test(fields[1]) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields[3])) fail('unsupported-pre-push-update');
    return { source: fields[1], destination: fields[2] };
  });
  const inv = pushInventory(cwd, remote, updates, url);
  const dir = privateDirectory(env);
  return evaluate(inv, dir, loadPrivacy(dir, env));
}

export async function main(args = process.argv.slice(2)) {
  try {
    const [command, ...rest] = args;
    let result;
    if (command === 'install-pre-push' && rest.length === 0) {
      result = installPrePush(process.cwd());
    } else if (command === 'pre-push' && rest.length === 2) {
      result = checkPrePush(process.cwd(), rest[0], rest[1], await readInput());
      if (!result.allowed) process.exitCode = 1;
    } else {
      const dir = privateDirectory();
      if (command === 'review' && rest.length === 1) {
        result = recordReview(dir, rest[0], JSON.parse(await readInput()));
      } else if (command === 'inventory' && rest.length === 1) {
        result = readPrivate(dir, pendingName(rest[0]));
        if (!result) fail('inventory-missing');
      } else if (command === 'terms' && rest.length === 1 && rest[0] === 'replace') {
        const terms = JSON.parse(await readInput());
        if (!Array.isArray(terms) || terms.length > 2000 || terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 500)) fail('invalid-private-terms');
        writePrivate(dir, 'private-terms.json', [...new Set(terms)]);
        result = { status: 'private-terms-updated', count: new Set(terms).size };
      } else if (command === 'terms' && rest.length === 1 && rest[0] === 'status') {
        const terms = readPrivate(dir, 'private-terms.json', []);
        if (!Array.isArray(terms)) fail('invalid-private-terms');
        result = { count: terms.length };
      } else fail('usage-review-inventory-terms-or-owner-installer');
    }
    // pre-push diagnostics go to stderr, never into Git's stdout protocol.
    (command === 'pre-push' ? process.stderr : process.stdout).write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof GuardError ? error.code : 'operation-failed';
    process.stderr.write(`Publish Guard: ${code}. No sensitive error details recorded.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
