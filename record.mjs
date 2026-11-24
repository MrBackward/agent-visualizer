#!/usr/bin/env node
// Records the visualizer page to a real video (about 25 frames a second) with Playwright's headless Chromium.
// usage: record.mjs <out.mp4|out.webm> [--url http://127.0.0.1:4777] [--seconds 120] [--stop-file <path>] [--size 1280x720]
// It stops after --seconds, or as soon as --stop-file exists. Run it from a project that has Playwright installed.
// An mp4 needs ffmpeg, and starts two seconds before the first agent activity so there is no dead air up front.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4777' },
    seconds: { type: 'string', default: '120' },
    'stop-file': { type: 'string' },
    size: { type: 'string', default: '1280x720' },
  },
});
const output = positionals[0] && resolve(positionals[0]);
if (!output) {
  console.error('usage: record.mjs <out.mp4|out.webm> [--url <url>] [--seconds 120] [--stop-file <path>] [--size 1280x720]');
  process.exit(1);
}

const fromHere = createRequire(join(process.cwd(), 'package.json'));
const chromium = ['playwright', '@playwright/test'].reduce((found, name) => {
  try {
    return found ?? fromHere(name).chromium;
  } catch {
    return found;
  }
}, null);
if (!chromium) {
  console.error('Playwright was not found from this folder. Run this from a project that has it, or: npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const LEAD_IN_MS = 2000;
const [width, height] = options.size.split('x').map(Number);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark', recordVideo: { dir: tmpdir(), size: { width, height } } });
const startedAt = Date.now();
const page = await context.newPage();
await page.goto(options.url);

let activeAt = null;
const deadline = Date.now() + Number(options.seconds) * 1000;
while (Date.now() < deadline && !(options['stop-file'] && existsSync(options['stop-file']))) {
  activeAt ??= (await page.evaluate(() => document.getElementById('empty')?.hidden ?? true)) ? Date.now() : null;
  await page.waitForTimeout(250);
}
const skipped = Math.max(0, ((activeAt ?? startedAt) - startedAt - LEAD_IN_MS) / 1000);
const recording = await page.video().path();
await context.close();
await browser.close();

if (output.endsWith('.mp4')) {
  const converted = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skipped.toFixed(2), '-i', recording, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { stdio: 'inherit' });
  if (converted.status !== 0) {
    console.error(`ffmpeg could not make the mp4. The recording is at ${recording}`);
    process.exit(1);
  }
  rmSync(recording);
} else {
  renameSync(recording, output);
}
console.log(`${output} (skipped ${skipped.toFixed(1)}s before the first activity)`);
