import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fail, historyKey, readPrivate } from './state.mjs';
import { indexHistory } from './history.mjs';

const WORDS = 12;
export const internalPath = value => /\.(?:md|txt|rst|jsonl)$/i.test(value) && /(?:^|[\\/])(?:planning|\.research|internal)(?:[\\/]|$)|(?:^|[\\/])(?:handoff|acceptance|provenance|transcript|notes?)(?:[-_.][^\\/]*)?$/i.test(value);
const patterns = [
  ['credential-url', /[a-z]+:\/\/[^/\s:@]+:[^/\s@]+@/gi],
  ['session-link', /https?:\/\/(?:claude\.ai|chatgpt\.com|chat\.openai\.com)\/(?:chat|c|share|code|session)\/[^\s<>"']+/gi],
  ['session-trailer', new RegExp(['Claude', 'Session'].join('-') + '\\s*:', 'gi')],
  ['home-path', /(?:\/(?:Users|home)\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+|~[\\/][\p{L}\p{N}_.-][^\s"'`)]*)/gu],
  ['secret', new RegExp('(?:' + ['gh[pousr]_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{30,}', 'sk-' + '(?:proj-)?[A-Za-z0-9_-]{24,}', 'AKIA' + '[A-Z0-9]{16}', 'xox[baprs]-[A-Za-z0-9-]{20,}', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'].join('|') + ')', 'g')],
  ['secret-assignment', /(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/gi]
];
const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;
const noreply = /^(?:no-?reply@[^@]+|[A-Z0-9+_-]+@users\.noreply\.github\.com)$/i;

function words(text) {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].map(match => ({ value: match[0].normalize('NFKC').toLocaleLowerCase('en-US'), offset: match.index, length: match[0].length }));
}
export function sequenceHashes(text, key) {
  const tokens = words(text);
  const result = [];
  for (let i = 0; i + WORDS <= tokens.length; i++) {
    const last = tokens[i + WORDS - 1];
    result.push({ hash: createHmac('sha256', key).update(tokens.slice(i, i + WORDS).map(word => word.value).join(' ')).digest('hex'), offset: tokens[i].offset, length: last.offset + last.length - tokens[i].offset });
  }
  return result;
}

export function ownerPrompt(record) {
  if (record?.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary || record.toolUseResult || record.sourceToolAssistantUUID || record.parentToolUseID || record.isInjected || record.isSkill || record.isCommand || record.message?.role !== 'user') return null;
  const content = record.message.content;
  if (Array.isArray(content) && content.some(block => block.type !== 'text')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block.text ?? '').join('\n') : '';
  if (!text.trim() || /<(?:system-reminder|task-notification|local-command[^\s>]*|command-name|command-message|command-args|teammate-message|tool_result|skill(?:-content|-instructions)?|user-prompt-submit-hook|hook-context)\b/i.test(text) || /^Base directory for this skill:/m.test(text)) return null;
  return text;
}

export function loadPrivacy(dir, env = process.env, options = {}) {
  const terms = readPrivate(dir, 'private-terms.json', []);
  if (!Array.isArray(terms) || terms.length > 2000 || terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 500)) fail('invalid-private-terms');
  const key = historyKey(dir);
  return { terms, key, pluginRegistry: join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json'), ...indexHistory(dir, env, key, { promptFromRecord: ownerPrompt, hashSequences: sequenceHashes, ...options }) };
}

export function scan(text, privacy, { path = false, transport = false, ranges } = {}) {
  const findings = [];
  const add = (category, offset = 0, length = 1) => {
    const line = text.slice(0, offset).split('\n').length;
    const end = line + text.slice(offset, offset + length).split('\n').length - 1;
    if (!ranges || ranges.some(([start, stop]) => start <= end && stop >= line)) findings.push({ category, line });
  };
  if (path && internalPath(text)) add('internal-document');
  for (const [category, regex] of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) add(category, match.index, match[0].length);
  }
  const transportAddress = transport ? /^(?:ssh:\/\/)?(git@[A-Za-z0-9.-]+)(?=[:/])[^\s]+$/.exec(text)?.[1] : null;
  for (const match of text.matchAll(email)) {
    if (!noreply.test(match[0]) && !(transportAddress && match[0].endsWith(transportAddress))) add('personal-email', match.index);
  }
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  for (const term of privacy.terms) {
    const needle = term.normalize('NFKC').toLocaleLowerCase('en-US');
    let start = 0, offset;
    while ((offset = normalized.indexOf(needle, start)) !== -1) {
      const line = normalized.slice(0, offset).split('\n').length;
      const end = line + needle.split('\n').length - 1;
      if (!ranges || ranges.some(([start, stop]) => start <= end && stop >= line)) findings.push({ category: 'private-term', line });
      start = offset + needle.length;
    }
  }
  for (const sequence of sequenceHashes(text, privacy.key)) if (privacy.hashes.has(sequence.hash) && !privacy.excludedHashes?.has(sequence.hash)) add('owner-message', sequence.offset, sequence.length);
  return [...new Map(findings.map(finding => [`${finding.category}:${finding.line}`, finding])).values()];
}

export function safeLabel(label, privacy) {
  // A suspicious filename is private too. Never echo snippets or absolute paths.
  if (label.length > 240 || /[\x00-\x1f\x7f]/.test(label) || scan(label, privacy, { path: true }).length) return '[redacted label]';
  return label;
}
