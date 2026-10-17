import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, fail, GuardError, isDigest, privateDirectory, pendingName, readPrivate, writePrivate, reviewed, TTL } from './state.mjs';
import { loadPrivacy, scan, safeLabel, internalPath } from './privacy.mjs';
import { placementTarget, publicationInventory, literalTokens } from './inventory.mjs';
import { productExclusions } from './exclusions.mjs';

export async function readInput(stream = process.stdin, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) fail('input-too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function evaluate(inv, dir, privacy, now = Date.now()) {
  privacy = { ...privacy, excludedHashes: productExclusions(inv, privacy) };
  const digest = hash(JSON.stringify({ version: inv.version, kind: inv.kind, cwd: inv.cwd, destination: inv.destination, remoteSnapshot: inv.remoteSnapshot, baselineRefs: inv.baselineRefs, exclusions: [...privacy.excludedHashes].sort(), items: inv.items }));
  const items = inv.items.map(item => {
    const findings = [...scan(item.text, privacy, { transport: item.type === 'destination', ranges: item.scanRanges }), ...(item.scanLabel === false ? [] : scan(item.label, privacy, { path: ['file', 'path'].includes(item.type) }).map(finding => ({ ...finding, location: 'label' })))];
    return { id: item.id, label: safeLabel(item.label, privacy), type: item.type, bytes: Buffer.byteLength(item.text), ...(item.scanRanges ? { changedLines: item.scanRanges } : {}), ...(item.blob ? { blob: item.blob, previousBlob: item.previousBlob } : {}), findings };
  });
  const unavailable = privacy.historyStatus !== 'available';
  const blocked = unavailable || items.some(item => item.findings.length);
  const report = { digest, operation: inv.kind, history: privacy.historyStatus, items, blocked };
  if (Buffer.byteLength(JSON.stringify(report)) > 128 * 1024) fail('redacted-inventory-too-large');
  const old = readPrivate(dir, pendingName(digest));
  const created = old && now >= old.created && now - old.created < TTL ? old.created : now;
  writePrivate(dir, pendingName(digest), { ...report, created });
  if (blocked) return { allowed: false, reason: unavailable
    ? privacy.historyStatus === 'indexing' ? 'Private history indexing is incomplete or busy. Progress is saved; retry to continue before publication.' : 'Owner-message check unavailable; publication stopped.'
    : 'Private material detected; resolve every finding before review.', ...report };
  if (!reviewed(dir, digest, items, now)) return { allowed: false, reason: 'Review every inventory item as product, private or doubtful. Resolve private/doubtful material, then record the review for this digest using the review skill.', ...report };
  return { allowed: true, digest };
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function guard(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-hook-input');
  if (input.hook_event_name === 'UserPromptExpansion') {
    if (!/^\/?publish-guard:allow$/.test(input.command_name ?? '')) return {};
    const valid = input.expansion_type === 'slash_command' && input.command_source === 'plugin' && isDigest(input.command_args?.trim());
    return { decision: 'block', reason: valid
      ? 'Publish Guard captured the digest-bound command, but owner-only overrides are disabled in 0.1.0: this host integration cannot protect approval state from another process with the same account permissions. No exception was issued. Remove the finding and retry.'
      : 'Publish Guard requires an owner-typed plugin command and an exact inventory digest. No exception was issued.' };
  }
  if (input.hook_event_name !== 'PreToolUse') fail('unsupported-hook-event');
  const placement = placementTarget(input);
  if (placement && internalPath(placement.path) && !placement.ignored) return deny('Internal documents belong in a private location outside Git repositories, or an explicitly ignored location. No file content was recorded.');
  // Installation is an owner-terminal operation, never an assistant tool action.
  const command = input.tool_name === 'Bash' ? literalTokens(input.tool_input?.command) : null;
  if (command?.[0] === 'node' && command[1] && resolve(input.cwd, command[1]) === fileURLToPath(new URL('./control.mjs', import.meta.url)) && command[2] === 'install-pre-push') return deny('The optional pre-push installer must be run directly by the owner in a terminal.');
  const inv = publicationInventory(input);
  if (!inv) return {};
  const dir = privateDirectory(env);
  const report = evaluate(inv, dir, loadPrivacy(dir, env));
  // Defer to the host's ordinary permissions; a clean scan never grants authority.
  return report.allowed ? {} : deny(JSON.stringify(report));
}

export async function main() {
  let input, output;
  try { input = JSON.parse(await readInput()); output = guard(input); }
  catch (error) {
    const code = error instanceof GuardError ? error.code : 'inspection-failed';
    const reason = `Publish Guard stopped the action: ${code}. No raw input or error details were logged.`;
    output = input?.hook_event_name === 'UserPromptExpansion' ? { decision: 'block', reason } : deny(reason);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
