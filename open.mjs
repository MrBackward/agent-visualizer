#!/usr/bin/env node
// Opens the visualizer for a repo, starting its server in the background when none is running.
// usage: open.mjs [directory inside the repo]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listWorktrees, portFor } from './repo.mjs';

const OPENERS = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] };
const STARTUP_MS = 30_000;
const directory = process.argv[2] ?? process.cwd();

let root;
try {
  [{ root }] = listWorktrees(directory);
} catch {
  console.error(`Not a git repository: ${directory}`);
  process.exit(1);
}

const url = `http://127.0.0.1:${portFor(root)}`;
const isUp = () => fetch(url, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);

if (!(await isUp())) {
  const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
  spawn(process.execPath, [server, '--repo', root], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + STARTUP_MS;
  while (!(await isUp())) {
    if (Date.now() > deadline) {
      console.error(`The visualizer did not start for ${root}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const [command, ...args] = OPENERS[process.platform] ?? ['xdg-open'];
spawn(command, [...args, url], { detached: true, stdio: 'ignore' }).unref();
console.log(url);
