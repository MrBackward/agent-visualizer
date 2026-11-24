#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '4777' },
    minutes: { type: 'string', default: '60' },
  },
});

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));
const LOOKBACK_MS = Number(options.minutes) * 60_000;
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'Monitor']);
const DELETE_COMMANDS = new Set(['rm', 'unlink', 'rmdir']);
const TITLE_TYPES = new Set(['custom-title', 'agent-name', 'ai-title']);
const BYTES_PER_LINE = 40;
const REMOVED_WORKTREE = /^\.claude\/worktrees\/([^/]+)(?:\/(.*))?$/;
const LIVE_MS = 15_000;
const SHELL_RECHECK_DELAYS_MS = [5000, 30_000];
const SHELL_CHANGE_WINDOW_MS = 30_000;

let worktrees = [];
let events = [];
const agents = new Map();
const tracked = new Map();
const clients = new Set();
const touched = new Set();
const ignoredByPath = new Map();
const pendingFileCalls = new Map();

const encodeProjectName = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');
const publicAgent = ({ id, parent, title, agentType, description }) => ({ id, parent, title, agentType, description });
const publicWorktrees = () => worktrees.map(({ name, branch, primary }) => ({ name, branch, primary }));

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function gitSucceeds(root, ...args) {
  try {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ignoredAmong(paths) {
  try {
    return execFileSync('git', ['-C', worktrees[0].root, 'check-ignore', '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isIgnored(path) {
  if (path === '.git' || path.startsWith('.git/')) return true;
  const chain = path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  const unknown = chain.filter((ancestor) => !ignoredByPath.has(ancestor));
  if (unknown.length) {
    const ignored = new Set(ignoredAmong(unknown));
    unknown.forEach((ancestor) => ignoredByPath.set(ancestor, ignored.has(ancestor)));
  }
  return chain.some((ancestor) => ignoredByPath.get(ancestor));
}

function broadcast(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  clients.forEach((client) => client.write(frame));
}

function emit(event) {
  events.push(event);
  touched.add(`${event.wt}\n${event.path}`);
  broadcast({ type: 'event', event });
}

function refreshWorktrees() {
  const next = execFileSync('git', ['-C', options.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .trim()
    .split('\n\n')
    .map((block, index) => {
      const root = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? 'detached';
      return root && { root, name: basename(root), branch, primary: index === 0 };
    })
    .filter(Boolean);
  const changed = JSON.stringify(next) !== JSON.stringify(worktrees);
  worktrees = next;
  if (changed) broadcast({ type: 'worktrees', worktrees: publicWorktrees() });
}

function locate(absolutePath) {
  const [match] = worktrees
    .filter(({ root }) => absolutePath === root || absolutePath.startsWith(`${root}/`))
    .sort((first, second) => second.root.length - first.root.length);
  if (!match) return null;
  const path = absolutePath.slice(match.root.length + 1);
  // A worktree git no longer lists still has transcripts; without this its files nest under the primary checkout.
  const removed = REMOVED_WORKTREE.exec(path);
  return removed
    ? { wt: removed[1], path: removed[2] ?? '', root: join(match.root, '.claude', 'worktrees', removed[1]) }
    : { wt: match.name, path, root: match.root };
}

function shellTouches(command, cwd) {
  const changedTo = /^\s*cd\s+["']?([^"'\s;&]+)/.exec(command)?.[1];
  const base = changedTo ? resolve(cwd, changedTo) : cwd;
  const unquote = (word) => word.replace(/^["'`]+|["'`]+$/g, '');
  const plain = (token) => token.length > 2 && token.length < 260 && !token.startsWith('-') && !/[*?$\\{}~]/.test(token);
  const removed = new Set(
    command.split(/&&|\|\||[;|\n]/).flatMap((segment) => {
      const words = segment.trim().split(/\s+/).map(unquote);
      const [verb, ...rest] = words[0] === 'git' ? words.slice(1) : words;
      const operands = rest.filter((word) => !word.startsWith('-'));
      if (DELETE_COMMANDS.has(verb)) return operands;
      return verb === 'mv' ? operands.slice(0, -1) : [];
    }),
  );
  const mentioned = command.split(/[\s'"`;|&()<>=,:]+/).filter((token) => /[./]/.test(token));
  return [...new Set([...removed, ...mentioned])]
    .filter(plain)
    .slice(0, 40)
    .map((token) => ({ via: 'shell', target: resolve(base, token), deleting: removed.has(token) }));
}

function touchesOf({ name, input = {} }, cwd) {
  if (SEARCH_TOOLS.has(name)) return [{ via: 'search', kind: 'read', target: input.path ?? cwd }];
  if (SHELL_TOOLS.has(name)) return shellTouches(input.command ?? '', cwd);
  return [];
}

// Bash never says what it did to a file, so the file's state just after the command stands in for it.
function shellKind(stats, deleting, ts, place) {
  if (deleting) return stats ? null : 'delete';
  if (!stats) return null;
  const changed = stats.isFile() && stats.mtimeMs >= ts - 1000 && stats.mtimeMs <= ts + SHELL_CHANGE_WINDOW_MS;
  if (!changed) return 'read';
  const existedBefore =
    stats.birthtimeMs < ts - 1000 ||
    touched.has(`${place.wt}\n${place.path}`) ||
    gitSucceeds(place.root, 'ls-files', '--error-unmatch', '--', place.path);
  return existedBefore ? 'modify' : 'write';
}

function toEvent({ via, kind, target, deleting, lines }, cwd, ts, agent) {
  if (typeof target !== 'string') return null;
  const absolutePath = resolve(cwd, target);
  const place = locate(absolutePath);
  if (!place || (!place.path && via !== 'search')) return null;
  const stats = via === 'tool' ? null : statSync(absolutePath, { throwIfNoEntry: false });
  const resolvedKind = via === 'shell' ? shellKind(stats, deleting, ts, place) : kind;
  if (!resolvedKind || (place.path && isIgnored(place.path))) return null;
  const dir = via === 'tool' ? false : (stats?.isDirectory() ?? !/\.[a-z0-9]+$/i.test(absolutePath));
  const size = lines ?? (stats?.isFile() ? Math.ceil(stats.size / BYTES_PER_LINE) : undefined);
  return { ts, agent: agent.id, kind: resolvedKind, via, path: place.path, dir, wt: place.wt, lines: size };
}

const eventsOf = (block, cwd, ts, agent) =>
  touchesOf(block, cwd)
    .map((touch) => toEvent(touch, cwd, ts, agent))
    .filter(Boolean)
    .slice(0, 12);

function ingestBlock(block, cwd, ts, agent) {
  if (FILE_TOOLS.has(block.name)) {
    pendingFileCalls.set(block.id, block.input?.file_path ?? block.input?.notebook_path);
    return;
  }
  const found = eventsOf(block, cwd, ts, agent);
  found.forEach(emit);
  if (!SHELL_TOOLS.has(block.name) || Date.now() - ts > LIVE_MS) return;
  const changed = new Set(found.filter((event) => event.kind !== 'read').map((event) => event.path));
  SHELL_RECHECK_DELAYS_MS.forEach((delay) =>
    setTimeout(() => {
      eventsOf(block, cwd, ts, agent)
        .filter((event) => event.kind !== 'read' && !changed.has(event.path))
        .forEach((event) => {
          changed.add(event.path);
          emit(event);
        });
    }, delay),
  );
}

function describeResult(result) {
  if (result.file) return { kind: 'read', lines: result.file.numLines };
  if (result.type === 'create') return { kind: 'write', lines: result.content?.split('\n').length };
  const changed = (result.structuredPatch ?? []).flatMap((hunk) => hunk.lines ?? []).filter((line) => /^[+-]/.test(line));
  return { kind: 'modify', lines: changed.length || undefined };
}

// File tools are reported from their result, not their call: only the result says whether it worked and how much it touched.
function ingestFileResult(block, result, cwd, ts, agent) {
  const target = pendingFileCalls.get(block.tool_use_id);
  pendingFileCalls.delete(block.tool_use_id);
  if (block.is_error || typeof result !== 'object') return;
  const event = toEvent({ via: 'tool', ...describeResult(result), target }, cwd, ts, agent);
  if (event) emit(event);
}

function ingestActivity(line, agent) {
  const record = parse(line);
  const ts = Date.parse(record?.timestamp);
  if (!(ts >= Date.now() - LOOKBACK_MS)) return;
  const cwd = record.cwd ?? options.repo;
  if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
    record.message.content
      .filter((block) => block?.type === 'tool_use')
      .forEach((block) => ingestBlock(block, cwd, ts, agent));
  } else if (record.toolUseResult && Array.isArray(record.message?.content)) {
    record.message.content
      .filter((block) => block?.type === 'tool_result' && pendingFileCalls.has(block.tool_use_id))
      .forEach((block) => ingestFileResult(block, record.toolUseResult, cwd, ts, agent));
  }
}

function ingestTitle(line, agent) {
  const record = parse(line);
  if (!TITLE_TYPES.has(record?.type)) return;
  const chosenByUser = record.type !== 'ai-title';
  if (!chosenByUser && agent.named) return;
  agent.named ||= chosenByUser;
  agent.title = record.customTitle ?? record.agentName ?? record.aiTitle ?? agent.title;
  broadcast({ type: 'agent', agent: publicAgent(agent) });
}

function ingest(line, agent) {
  if (line.includes('"tool_use"') || line.includes('"toolUseResult"')) ingestActivity(line, agent);
  else if (!agent.parent && line.length < 2000 && (line.includes('-title"') || line.includes('"agent-name"'))) ingestTitle(line, agent);
}

function loadMeta(state) {
  if (!state.meta || state.agent.agentType || !existsSync(state.meta)) return;
  const meta = parse(readFileSync(state.meta, 'utf8'));
  if (!meta) return;
  state.agent.agentType = meta.agentType ?? 'subagent';
  state.agent.description = meta.description ?? null;
  broadcast({ type: 'agent', agent: publicAgent(state.agent) });
}

function drain(state, file) {
  loadMeta(state);
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return;
  const buffer = Buffer.alloc(size - state.offset);
  const descriptor = openSync(file, 'r');
  readSync(descriptor, buffer, 0, buffer.length, state.offset);
  closeSync(descriptor);
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline === -1) return;
  state.offset += lastNewline + 1;
  buffer
    .subarray(0, lastNewline)
    .toString('utf8')
    .split('\n')
    .forEach((line) => ingest(line, state.agent));
}

function track(file) {
  if (tracked.has(file)) return;
  const [project, session, ...nested] = relative(PROJECTS_DIR, file).split(sep);
  const isSubagent = nested.length > 0;
  const agent = { id: basename(file, '.jsonl'), parent: isSubagent ? session : null, title: null, agentType: null, description: null };
  agents.set(agent.id, agent);
  tracked.set(file, { offset: 0, agent, meta: isSubagent ? file.replace(/\.jsonl$/, '.meta.json') : null });
  broadcast({ type: 'agent', agent: publicAgent(agent) });
  const parentFile = join(PROJECTS_DIR, project, `${session}.jsonl`);
  if (isSubagent && existsSync(parentFile)) track(parentFile);
}

function scan() {
  const cutoff = Date.now() - LOOKBACK_MS;
  const prefixes = worktrees.map(({ root }) => encodeProjectName(root));
  readdirSync(PROJECTS_DIR)
    .filter((project) => prefixes.some((prefix) => project.startsWith(prefix)))
    .forEach((project) => {
      readdirSync(join(PROJECTS_DIR, project), { recursive: true })
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => join(PROJECTS_DIR, project, entry))
        .filter((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs >= cutoff)
        .forEach(track);
    });
  events = events.filter((event) => event.ts >= cutoff);
}

const drainAll = () => tracked.forEach(drain);

try {
  refreshWorktrees();
} catch {
  console.error(`Not a git repository: ${options.repo}`);
  process.exit(1);
}
scan();
drainAll();
events.sort((first, second) => first.ts - second.ts);

setInterval(drainAll, 500);
setInterval(scan, 3000);
setInterval(refreshWorktrees, 10_000);
setInterval(() => clients.forEach((client) => client.write(': keepalive\n\n')), 20_000);

createServer((request, response) => {
  if (request.url !== '/events') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(readFileSync(PAGE));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const init = {
    type: 'init',
    repo: worktrees[0].name,
    worktrees: publicWorktrees(),
    agents: [...agents.values()].map(publicAgent),
    events,
  };
  response.write(`data: ${JSON.stringify(init)}\n\n`);
  clients.add(response);
  request.on('close', () => clients.delete(response));
}).listen(Number(options.port), '127.0.0.1', () => {
  console.log(`Agent visualizer for ${worktrees[0].root}`);
  console.log(`http://127.0.0.1:${options.port}`);
});
