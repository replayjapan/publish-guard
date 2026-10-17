import { basename } from 'node:path';

const gitValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const githubWrites = {
  release: new Set(['create', 'edit', 'upload', 'delete', 'delete-asset']),
  pr: new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen', 'ready', 'lock', 'unlock', 'update-branch', 'revert']),
  issue: new Set(['create', 'edit', 'comment', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin']),
  gist: new Set(['create', 'edit', 'delete', 'rename']),
  repo: new Set(['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'fork', 'sync'])
};

export function gitOperation(args) {
  let i = 0;
  const aliases = new Map();
  while (args[i]?.startsWith('-')) {
    const arg = args[i++];
    if (arg === '-c' && args[i]?.startsWith('alias.')) {
      const match = /^alias\.([^=]+)=(.*)$/.exec(args[i]);
      if (match) aliases.set(match[1], match[2]);
    }
    if (gitValues.has(arg)) i++;
  }
  const verb = args[i], rest = args.slice(i + 1);
  let publishing = ['commit', 'commit-tree', 'push', 'send-pack'].includes(verb)
    || verb === 'lfs' && rest[0] === 'push';
  if (verb === 'tag') publishing = rest.length > 0 && !rest.some(arg => /^(?:-l|--list|-d|--delete|-v|--verify|--contains|--no-contains|--merged|--no-merged|--points-at|--format)(?:=|$)/.test(arg));
  const alias = aliases.get(verb);
  if (alias) publishing ||= /^(?:commit(?:-tree)?|push|send-pack|tag)(?:\s|$)/.test(alias) || alias.startsWith('!') && containsPublication(alias.slice(1));
  return { verb, publishing, index: i };
}

export function ghPublishes(args) {
  let i = 0;
  while (args[i]?.startsWith('-')) {
    const arg = args[i++];
    if (['-R', '--repo', '--hostname'].includes(arg)) i++;
  }
  const [group, verb] = args.slice(i);
  if (group !== 'api') return githubWrites[group]?.has(verb) ?? false;
  let method, payload = false;
  const rest = args.slice(i + 1);
  for (let n = 0; n < rest.length; n++) {
    const arg = rest[n];
    if (arg === '-X' || arg === '--method') method = rest[++n]?.toUpperCase();
    else if (arg.startsWith('--method=')) method = arg.slice(9).toUpperCase();
    else if (arg.startsWith('-X')) method = arg.slice(2).toUpperCase();
    else if (/^(?:-f|-F|--raw-field|--field|--input)(?:=|$)/.test(arg) || /^-[fF].+/.test(arg)) payload = true;
  }
  return method ? !['GET', 'HEAD', 'OPTIONS'].includes(method) : payload;
}

function publishesTokens(tokens, depth) {
  if (depth > 8) return false;
  let i = 0;
  while (['if', 'then', 'elif', 'else', 'do', '!'].includes(tokens[i])) i++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  const name = () => basename(tokens[i] ?? '').replace(/\.exe$/i, '');
  while (['env', 'command', 'exec', 'nohup', 'sudo', 'xcrun', 'time'].includes(name())) {
    const wrapper = name(); i++;
    while (tokens[i]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) {
      const arg = tokens[i++];
      if (wrapper === 'env' && ['-S', '--split-string'].includes(arg)) return containsPublication(tokens[i] ?? '', depth + 1);
      if (['-u', '--unset', '-C', '--chdir', '-g', '--group', '--user', '--sdk', '--toolchain'].includes(arg)) i++;
    }
  }
  if (name() === 'git') return gitOperation(tokens.slice(i + 1)).publishing;
  if (name() === 'gh') return ghPublishes(tokens.slice(i + 1));
  if (['sh', 'bash', 'zsh', 'dash', 'fish'].includes(name())) {
    const option = tokens.findIndex((arg, n) => n > i && /^-[a-z]*c[a-z]*$/.test(arg));
    return option !== -1 && containsPublication(tokens[option + 1] ?? '', depth + 1);
  }
  return false;
}

// Recognize executable positions, not occurrences inside grep/echo arguments.
// This does not interpret arbitrary programs, aliases or dynamically built names.
export function containsPublication(command, depth = 0) {
  if (depth > 8) return false;
  let tokens = [], word = '', active = false, quote = null;
  const flush = () => { if (active) tokens.push(word); word = ''; active = false; };
  const end = () => { flush(); const result = publishesTokens(tokens, depth); tokens = []; return result; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (ch === '\\') { active = true; word += command[++i] ?? ''; continue; }
    if (ch === '`' || ch === '$' && command[i + 1] === '(') {
      const backtick = ch === '`', start = i + (backtick ? 1 : 2);
      let j = start, nesting = 1;
      for (; j < command.length; j++) {
        if (command[j] === '\\') { j++; continue; }
        if (backtick ? command[j] === '`' : command[j] === ')' && --nesting === 0) break;
        if (!backtick && command[j] === '(') nesting++;
      }
      if (containsPublication(command.slice(start, j), depth + 1)) return true;
      active = true; word += 'substitution'; i = j; continue;
    }
    if (quote === '"') { if (ch === '"') quote = null; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue; }
    if (ch === '#' && !active) { while (i < command.length && command[i] !== '\n') i++; if (end()) return true; continue; }
    if (';&|()\n\r'.includes(ch)) { if (end()) return true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    active = true; word += ch;
  }
  return end();
}
