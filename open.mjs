#!/usr/bin/env node
// Opens the visualizer in the browser, starting its server in the background when none is running.
// usage: open.mjs [server options]   e.g. open.mjs --minutes 240
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OPENERS = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] };
const STARTUP_MS = 30_000;

const { values } = parseArgs({ options: { port: { type: 'string', default: '4777' } }, strict: false });
const url = `http://127.0.0.1:${values.port}`;
const isUp = () => fetch(url, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);

if (!(await isUp())) {
  const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
  spawn(process.execPath, [server, ...process.argv.slice(2)], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + STARTUP_MS;
  while (!(await isUp())) {
    if (Date.now() > deadline) {
      console.error('The visualizer did not start');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const [command, ...args] = OPENERS[process.platform] ?? ['xdg-open'];
spawn(command, [...args, url], { detached: true, stdio: 'ignore' }).unref();
console.log(url);
