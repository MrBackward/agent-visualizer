#!/usr/bin/env node
// Tails Claude Code transcripts and streams which files each agent touches, grouped by git repo.
// usage: server.mjs [--repo <dir> ...] [--port 4777] [--minutes 60]
// With no --repo it shows every repo an agent worked in during the lookback window.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true, default: [] },
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
const CHECK_TOOLS = new Set([
  'jest', 'vitest', 'mocha', 'ava', 'karma', 'playwright', 'cypress', 'rspec', 'minitest', 'pytest', 'tox', 'nox', 'phpunit',
  'eslint', 'oxlint', 'stylelint', 'rubocop', 'brakeman', 'ruff', 'biome', 'shellcheck', 'markdownlint',
  'tsc', 'mypy', 'pyright', 'typecheck', 'agent-browser',
]);
const CHECK_SCRIPTS = /^(tests?|check|lint|verify|validate|typecheck|type-check|vet|clippy|build|e2e|specs?)([:._-]\S*)?$/;
const SYNTAX_CHECKS = /\bnode\s+--check\b|\bruby\s+-c\b|\bbash\s+-n\b|\bpython3?\s+-m\s+(pytest|unittest|mypy|py_compile|compileall)\b/;
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'time', 'sudo', 'env', 'command', 'nohup']);
const NOT_CHECKS = new Set([
  'git', 'gh', 'echo', 'printf', 'cd', 'cat', 'ls', 'grep', 'rg', 'sed', 'awk', 'find', 'head', 'tail', 'wc', 'sort', 'mkdir', 'rm', 'cp', 'mv',
  'touch', 'chmod', 'which', 'export', 'kill', 'pkill', 'pgrep', 'lsof', 'curl', 'open', 'for', 'if', 'while', 'test', '[', 'docker', 'brew',
]);
const REMOVED_WORKTREE = /^\.claude\/worktrees\/([^/]+)(?:\/(.*))?$/;
const LIVE_MS = 15_000;
const SHELL_RECHECK_DELAYS_MS = [5000, 30_000];
const SHELL_CHANGE_WINDOW_MS = 30_000;

let roots = [];
let events = [];
const repos = new Map();
const outsideAnyRepo = new Set();
const agents = new Map();
const tracked = new Map();
const clients = new Set();
const touched = new Set();
const ignoredByPath = new Map();
const pendingFileCalls = new Map();
const workedFrom = new Set();

const publicAgent = ({ id, parent, title, agentType, description, status, statusAt, validating }) => ({ id, parent, title, agentType, description, status, statusAt, validating });
const publicRepos = () =>
  [...repos.values()]
    .filter((repo) => repo.shown)
    .map(({ name, worktrees }) => ({ name, worktrees: worktrees.map(({ name: worktree, branch, primary }) => ({ name: worktree, branch, primary })) }));

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

function broadcast(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  clients.forEach((client) => client.write(frame));
}

function emit(event) {
  events.push(event);
  touched.add(`${event.repo}\n${event.wt}\n${event.path}`);
  broadcast({ type: 'event', event });
}

// The first entry is the primary checkout, whichever worktree or subfolder the command runs from.
function listWorktrees(directory) {
  return execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim()
    .split('\n\n')
    .map((block, index) => {
      const root = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? 'detached';
      return root && { root, name: basename(root), branch, primary: index === 0 };
    })
    .filter(Boolean);
}

const onlyRepos = new Set(
  options.repo.map((directory) => {
    try {
      return listWorktrees(directory)[0].root;
    } catch {
      console.error(`Not a git repository: ${directory}`);
      return process.exit(1);
    }
  }),
);

function register(worktrees) {
  const [primary] = worktrees;
  const nameTaken = [...repos.values()].some((repo) => repo.name === basename(primary.root));
  const repo = repos.get(primary.root) ?? {
    root: primary.root,
    name: nameTaken ? `${basename(dirname(primary.root))}/${basename(primary.root)}` : basename(primary.root),
    shown: onlyRepos.has(primary.root),
  };
  const changed = JSON.stringify(repo.worktrees) !== JSON.stringify(worktrees);
  repo.worktrees = worktrees;
  repos.set(repo.root, repo);
  if (!changed) return;
  roots = [...repos.values()]
    .flatMap((entry) => entry.worktrees.map((worktree) => ({ ...worktree, repo: entry })))
    .sort((first, second) => second.root.length - first.root.length);
  broadcast({ type: 'repos', repos: publicRepos() });
}

// A repo appears once an agent runs from inside it or uses a file tool on it. A path merely named in a
// shell command is not enough: every PATH export would otherwise put the Homebrew checkout on screen.
function reveal(repo) {
  if (onlyRepos.size || repo.shown) return;
  repo.shown = true;
  broadcast({ type: 'repos', repos: publicRepos() });
}

function refreshWorktrees() {
  repos.forEach((repo) => {
    try {
      register(listWorktrees(repo.root));
    } catch {
      // the checkout was deleted: keep what is known so its old events still resolve
    }
  });
}

const rootOf = (absolutePath) => roots.find(({ root }) => absolutePath === root || absolutePath.startsWith(`${root}/`));

function existingDirectory(path) {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return path;
  const parent = dirname(path);
  return parent === path ? null : existingDirectory(parent);
}

function discover(absolutePath) {
  const directory = existingDirectory(absolutePath);
  if (!directory || outsideAnyRepo.has(directory)) return null;
  try {
    register(listWorktrees(directory));
  } catch {
    outsideAnyRepo.add(directory);
    return null;
  }
  const found = rootOf(absolutePath);
  if (!found) outsideAnyRepo.add(directory);
  return found;
}

function revealWorkedFrom(cwd) {
  if (!cwd || workedFrom.has(cwd)) return;
  workedFrom.add(cwd);
  const found = rootOf(cwd) ?? discover(cwd);
  if (found) reveal(found.repo);
}

function locate(absolutePath, usedFileTool) {
  const found = rootOf(absolutePath) ?? discover(absolutePath);
  if (found && usedFileTool) reveal(found.repo);
  if (!found?.repo.shown) return null;
  const path = absolutePath.slice(found.root.length + 1);
  // A worktree git no longer lists still has transcripts; without this its files nest under the primary checkout.
  const removed = found.primary && REMOVED_WORKTREE.exec(path);
  return removed
    ? { repo: found.repo, wt: removed[1], path: removed[2] ?? '', root: join(found.root, '.claude', 'worktrees', removed[1]) }
    : { repo: found.repo, wt: found.name, path, root: found.root };
}

function ignoredAmong(root, paths) {
  try {
    return execFileSync('git', ['-C', root, 'check-ignore', '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isIgnored({ repo, path }) {
  if (path === '.git' || path.startsWith('.git/')) return true;
  const cacheKey = (ancestor) => `${repo.root}\n${ancestor}`;
  const chain = path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  const unknown = chain.filter((ancestor) => !ignoredByPath.has(cacheKey(ancestor)));
  if (unknown.length) {
    const ignored = new Set(ignoredAmong(repo.root, unknown));
    unknown.forEach((ancestor) => ignoredByPath.set(cacheKey(ancestor), ignored.has(ancestor)));
  }
  return chain.some((ancestor) => ignoredByPath.get(cacheKey(ancestor)));
}

function shellTouches(command, cwd) {
  const changedTo = /^\s*cd\s+["']?([^"'\s;&]+)/.exec(command)?.[1];
  const base = changedTo ? resolve(cwd, changedTo) : cwd;
  const unquote = (word) => word.replace(/^["'`]+|["'`]+$/g, '');
  const plain = (token) => token.length > 2 && token.length < 260 && !token.startsWith('-') && !/[*?$\\{}~<>&|]/.test(token);
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

// Tests, linters, type checks, builds and browser checks: anything run to confirm the work.
// e.g. "cd app && bundle exec rubocop lib | tail" -> "bundle exec rubocop"; "git commit -m 'fix test'" -> null
function validationLabel(command) {
  const script = command.split('<<')[0].replace(/'[^']*'|"[^"]*"/g, ' ');
  const labels = script.split(/&&|\|\||[;|\n]/).map((segment) => {
    const syntaxCheck = SYNTAX_CHECKS.exec(segment)?.[0];
    if (syntaxCheck) return syntaxCheck.replace(/\s+/g, ' ');
    const words = segment.trim().split(/\s+/).filter((word) => word && !/^\w+=/.test(word) && !word.startsWith('-'));
    const names = words.slice(SHELL_KEYWORDS.has(words[0]) ? 1 : 0).slice(0, 5).map((word) => basename(word));
    if (!names.length || NOT_CHECKS.has(names[0])) return null;
    const found = names.findIndex((name, index) => CHECK_TOOLS.has(name) || (index > 0 && CHECK_SCRIPTS.test(name)));
    return found === -1 ? null : names.slice(0, found + 1).join(' ').slice(0, 28);
  });
  return labels.find(Boolean) ?? null;
}

function publishChecks(agent) {
  agent.validating = [...agent.checks.values()].at(-1) ?? null;
  broadcast({ type: 'agent', agent: publicAgent(agent) });
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
    touched.has(`${place.repo.name}\n${place.wt}\n${place.path}`) ||
    gitSucceeds(place.root, 'ls-files', '--error-unmatch', '--', place.path);
  return existedBefore ? 'modify' : 'write';
}

function toEvent({ via, kind, target, deleting, lines }, cwd, ts, agent) {
  if (typeof target !== 'string') return null;
  const absolutePath = resolve(cwd, target);
  const place = locate(absolutePath, via === 'tool');
  if (!place || (!place.path && via !== 'search')) return null;
  const stats = via === 'tool' ? null : statSync(absolutePath, { throwIfNoEntry: false });
  const resolvedKind = via === 'shell' ? shellKind(stats, deleting, ts, place) : kind;
  if (!resolvedKind || (place.path && isIgnored(place))) return null;
  const dir = via === 'tool' ? false : (stats?.isDirectory() ?? !/\.[a-z0-9]+$/i.test(absolutePath));
  const size = lines ?? (stats?.isFile() ? Math.ceil(stats.size / BYTES_PER_LINE) : undefined);
  return { ts, agent: agent.id, kind: resolvedKind, via, repo: place.repo.name, path: place.path, dir, wt: place.wt, lines: size };
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
  const check = SHELL_TOOLS.has(block.name) ? validationLabel(block.input?.command ?? '') : null;
  if (check) {
    agent.checks.set(block.id, { label: check, since: ts });
    publishChecks(agent);
  }
  // A check names the files it runs against without the agent working on them, so only real changes are reported.
  const found = eventsOf(block, cwd, ts, agent).filter((event) => !check || event.kind !== 'read');
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

function ingestActivity(record, ts, agent) {
  if (!(ts >= Date.now() - LOOKBACK_MS)) return;
  const cwd = record.cwd ?? homedir();
  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  if (record.type === 'assistant') {
    blocks.filter((block) => block?.type === 'tool_use').forEach((block) => ingestBlock(block, cwd, ts, agent));
  } else if (record.toolUseResult) {
    const finished = blocks.filter((block) => block?.type === 'tool_result' && agent.checks.delete(block.tool_use_id));
    if (finished.length) publishChecks(agent);
    blocks
      .filter((block) => block?.type === 'tool_result' && pendingFileCalls.has(block.tool_use_id))
      .forEach((block) => ingestFileResult(block, record.toolUseResult, cwd, ts, agent));
  }
}

// e.g. an assistant line with stop_reason "end_turn" -> done; a prompt or a tool result -> working
function turnStatus(record) {
  if (record.type === 'assistant') return record.message?.stop_reason === 'end_turn' ? 'done' : 'working';
  if (record.type !== 'user' || record.isMeta) return null;
  if (record.toolUseResult) return 'working';
  const text = JSON.stringify(record.message?.content ?? '');
  if (text.includes('[Request interrupted by user')) return 'done';
  return /<local-command-|<command-name>/.test(text) ? null : 'working';
}

function setStatus(agent, status, statusAt) {
  if (!status || agent.status === status) return;
  if (status === 'done') agent.checks.clear();
  Object.assign(agent, { status, statusAt, validating: status === 'done' ? null : agent.validating });
  broadcast({ type: 'agent', agent: publicAgent(agent) });
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
  const activity = line.includes('"tool_use"') || line.includes('"toolUseResult"');
  if (activity || line.includes('"stop_reason":"end_turn"') || line.includes('"type":"user"')) {
    const record = parse(line);
    const ts = Date.parse(record?.timestamp);
    if (!ts) return;
    revealWorkedFrom(record.cwd);
    // A subagent's transcript often stops mid-turn, so its meta file decides when it is done.
    if (!agent.parent) setStatus(agent, turnStatus(record), ts);
    if (activity) ingestActivity(record, ts, agent);
  } else if (!agent.parent && line.length < 2000 && (line.includes('-title"') || line.includes('"agent-name"'))) {
    ingestTitle(line, agent);
  }
}

function loadMeta({ meta, agent }) {
  if (!meta || agent.status === 'done') return;
  const stats = statSync(meta, { throwIfNoEntry: false });
  const details = stats && parse(readFileSync(meta, 'utf8'));
  if (!details) return;
  if (!agent.agentType) {
    Object.assign(agent, { agentType: details.agentType ?? 'subagent', description: details.description ?? null });
    broadcast({ type: 'agent', agent: publicAgent(agent) });
  }
  setStatus(agent, details.finished ? 'done' : 'working', stats.mtimeMs);
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
  const agent = { id: basename(file, '.jsonl'), parent: isSubagent ? session : null, title: null, agentType: null, description: null, status: null, statusAt: 0, validating: null, checks: new Map() };
  agents.set(agent.id, agent);
  tracked.set(file, { offset: 0, agent, meta: isSubagent ? file.replace(/\.jsonl$/, '.meta.json') : null });
  broadcast({ type: 'agent', agent: publicAgent(agent) });
  const parentFile = join(PROJECTS_DIR, project, `${session}.jsonl`);
  if (isSubagent && existsSync(parentFile)) track(parentFile);
}

function scan() {
  const cutoff = Date.now() - LOOKBACK_MS;
  readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach(({ name: project }) => {
      readdirSync(join(PROJECTS_DIR, project), { recursive: true })
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => join(PROJECTS_DIR, project, entry))
        .filter((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs >= cutoff)
        .forEach(track);
    });
  events = events.filter((event) => event.ts >= cutoff);
}

const drainAll = () => tracked.forEach(drain);

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
    minutes: Number(options.minutes),
    repos: publicRepos(),
    agents: [...agents.values()].map(publicAgent),
    events,
  };
  response.write(`data: ${JSON.stringify(init)}\n\n`);
  clients.add(response);
  request.on('close', () => clients.delete(response));
}).listen(Number(options.port), '127.0.0.1', () => {
  console.log(`Agent visualizer: http://127.0.0.1:${options.port}`);
  console.log(`Watching ${publicRepos().map((repo) => repo.name).join(', ') || 'for agent activity'}`);
});
