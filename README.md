# Agent Visualizer

A live map of what your Claude Code agents are doing to your code. Each repo is a tree, each agent is a little blob that walks to a file and zaps it, and you can see at a glance who is working where, who is running tests, and who has gone quiet.

It reads the transcripts Claude Code already writes to `~/.claude/projects`, so there is nothing to install into your agents and nothing to configure per repo.

## Run it

```sh
node open.mjs
```

That starts the server in the background if it is not already running and opens the page in your browser.

To run the server yourself:

```sh
node server.mjs [--repo <dir> ...] [--port 4777] [--minutes 60]
```

| Option | Default | What it does |
|---|---|---|
| `--repo <dir>` | every repo an agent works in | Show only this repo. Repeat it for several. Any folder inside the repo or one of its worktrees will do. |
| `--port` | `4777` | Port to serve on. The server only listens on `127.0.0.1`. |
| `--minutes` | `60` | How far back to read when it starts, and how long a silent agent stays on screen. |

You need Node 18.17 or newer and git. There are no dependencies.

## What you are looking at

**Trees.** One per repo, side by side. Folders are small grey dots, and files sit in rings around their folder. Only files an agent has touched are drawn, so a huge repo stays readable. Worktrees of the same repo share one tree, because the same file is the same file wherever it is checked out. Files that git ignores are never drawn.

**Files.** The shape and colour say what last happened to the file.

| Mark | Meaning |
|---|---|
| Orange ring | Read |
| Green diamond | Written as a new file |
| Blue dot | Modified |
| Red cross | Deleted |
| Dashed white ring | Changed in two worktrees of the same repo, so a merge conflict is on its way |

**Agents.** A blob flies to a file and fires a bolt at it in the colour of the action. The bolt lasts longer the more lines were read or changed. A new file only appears when the bolt lands. Subagents are smaller blobs labelled with their task.

| Blob | Meaning |
|---|---|
| White | Working |
| Red | Mid-turn but has not touched a file for more than 5 minutes. It may be stuck, or it may be waiting on you. |
| Green | Its turn is finished |

An agent stays parked at the last file it touched, even after that file fades from the trail, so you can see where a stuck agent stopped. A finished agent leaves once it has been done for longer than the trail.

**Validation box.** While an agent runs a check (tests, a linter, a type check, a build, a browser check) it waits quietly in the box at the top, labelled with the command and how long it has been running. It is not still, it is doing something else, so it never turns red there.

## Controls

- **Trail** (top right): how long a touched file stays on screen. 5 minutes, 15 minutes, 1 hour, or everything loaded.
- **Fit** or the `F` key: fit every tree to the window. Drag to pan, scroll to zoom.
- **Hover** a file or folder to see which agents touched it and how.
- **Click a session** in the sidebar to show only that session and its subagents. Click it again to show everyone.
- **Click an overlap** in the sidebar to jump to the file.

## How it knows

The server tails every transcript under `~/.claude/projects`, including subagent transcripts, and turns tool calls into events.

- `Read`, `Edit` and `Write` are exact. They are reported when the call succeeds, with the real number of lines read or changed.
- Shell commands are a best guess. Paths are picked out of the command text. A file whose modified time lands just after the command counts as changed, and an `rm` or `mv` operand that no longer exists counts as deleted.
- A check is recognised by its command, such as `npm test`, `bundle exec rubocop` or `npx tsc`. The lists are `CHECK_TOOLS` and `CHECK_SCRIPTS` at the top of `server.mjs`.
- A session is finished when its last assistant message ended the turn. A subagent is finished when Claude Code marks it so.
- A repo appears once an agent runs from inside it or uses a file tool on it. A path that is only named in a shell command is not enough.

## Limits

- Claude Code's transcript format is not documented and can change in any release.
- Shell guesses are sometimes wrong, and a file read through a pipe or a glob is missed.
- An agent blocked on a permission prompt looks the same as a stuck one, so it turns red too.
- A session killed mid-turn stays on screen as working until `--minutes` have passed.
- A check started in the background reports back straight away, so the agent leaves the validation box while it is still running.

## Privacy

Everything stays on your machine. The server binds to `127.0.0.1`, sends nothing anywhere, and the only things it passes to the page are file paths, the name of a check command, session titles and subagent task names.

## Record a demo video

```sh
node record.mjs demo.mp4 [--url http://127.0.0.1:4777] [--seconds 120] [--stop-file <path>] [--size 1280x720]
```

This records the page as a real video at about 25 frames a second. Run it from a project that has Playwright installed. An mp4 also needs ffmpeg, and starts two seconds before the first agent activity. It stops after `--seconds`, or as soon as the stop file exists.

For a video you can share, point a second server at throwaway repos with `--repo` so your real work stays out of frame.

## Files

| File | What it is |
|---|---|
| `server.mjs` | Tails the transcripts and streams events to the page |
| `index.html` | The page: layout, drawing and the sidebar |
| `open.mjs` | Starts the server if needed and opens the browser |
| `record.mjs` | Records the page to a video |
