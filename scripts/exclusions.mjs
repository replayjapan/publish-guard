import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { sequenceHashes } from './privacy.mjs';
import { git, treeEntries } from './inventory.mjs';

// These exclusions affect only prompt attribution, never other detectors.
// Only hashes matching this operation are retained, and none are persisted.
export function productExclusions(inv, privacy) {
  if (!privacy.hashes.size) return new Set();
  const candidates = new Set();
  for (const item of inv.items) {
    for (const value of [item.text, item.label]) {
      for (const { hash } of sequenceHashes(value, privacy.key)) if (privacy.hashes.has(hash)) candidates.add(hash);
    }
  }
  const excluded = new Set();
  if (!candidates.size) return excluded;
  const deadline = Date.now() + 15000;
  let bytes = 0, files = 0;
  const room = () => Date.now() < deadline && bytes < 32 * 1024 * 1024 && files < 2000 && excluded.size < candidates.size;
  const inspect = buffer => {
    bytes += buffer.length; files++;
    if (buffer.includes(0)) return;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return; }
    for (const { hash } of sequenceHashes(text, privacy.key)) if (candidates.has(hash)) excluded.add(hash);
  };
  const seen = new Set();
  for (const ref of inv.baselineRefs ?? []) {
    if (!room()) break;
    for (const entry of treeEntries(inv.cwd, ref).values()) {
      if (!room()) break;
      if (entry.type !== 'blob' || seen.has(entry.oid)) continue;
      seen.add(entry.oid);
      const size = Number(git(inv.cwd, ['cat-file', '-s', entry.oid]).toString());
      if (size > 2 * 1024 * 1024 || bytes + size > 32 * 1024 * 1024) continue;
      inspect(git(inv.cwd, ['cat-file', 'blob', entry.oid]));
    }
  }
  const registry = privacy.pluginRegistry;
  if (!registry || !room() || !existsSync(registry)) return excluded;
  // Registry and installed files are optional evidence. Unreadable or skipped
  // evidence grants no exclusion; candidate prompt matches remain findings.
  try {
    const stat = lstatSync(registry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return excluded;
    const data = JSON.parse(readFileSync(registry, 'utf8'));
    const paths = Object.values(data.plugins ?? {}).flatMap(entries => Array.isArray(entries) ? entries.map(entry => entry?.installPath) : []);
    const walk = dir => {
      if (!room()) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!room()) break;
        if (entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.isFile()) continue;
        const stat = lstatSync(path);
        if (stat.nlink !== 1 || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) continue;
        inspect(readFileSync(path));
      }
    };
    for (const path of [...new Set(paths)].sort()) {
      if (!room()) break;
      if (typeof path !== 'string' || !isAbsolute(path)) continue;
      try {
        if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) continue;
        walk(path);
      } catch { /* No exclusion for inaccessible installed content. */ }
    }
  } catch { /* A malformed registry cannot whitelist prompt matches. */ }
  return excluded;
}
