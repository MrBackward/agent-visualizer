import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// The first entry is the primary checkout, whichever worktree the command runs from.
export function listWorktrees(directory) {
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

// One stable port per repo, so two repos can be watched side by side. e.g. /code/app -> 4831
export function portFor(root) {
  const hash = [...root].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 300, 7);
  return 4700 + hash;
}
