# claude-remote — Design Spec

Date: 2026-07-13
Status: Approved (pending implementation plan)

## Purpose

Run Claude Code (with `--dangerously-skip-permissions`) on a fully-trusted,
physically separate machine (Linux or Windows+WSL2) instead of in a local
Docker container on the Mac. The Mac stays the source of truth for the
workspace; a companion CLI (`claude-remote`), run from the Mac, keeps a
remote machine's copy of the workspace and Claude Code's own session/config
state continuously in sync, and drops you into a live Claude Code session on
that remote machine over SSH.

This is a sibling tool to `claude-docker` (same author, same personal/
local-only status — never pushed to a remote git host), solving the same
problem (host-OS isolation for a Claude Code session running with bypassed
permissions) via a different mechanism: a genuinely separate machine instead
of a container on the same physical hardware.

## Why not Docker-in-Docker / DooD again, why not a network mount

Covered in conversation preceding this spec (not repeated in full here):

- DooD/DinD only address container-networking-shaped problems (e.g. the
  testcontainers `localhost` gap). Most of the pain actually hit while
  building `claude-docker` (Playwright system libs, node_modules/.venv
  cross-platform native binary mismatch, `cryptography` SIGILL under Docker
  Desktop's ARM64 VM translation layer) either disappears entirely on real
  hardware (no extra virtualization layer) or is orthogonal to the
  Docker/DinD/DooD axis entirely (Python version availability, POSIX shell
  bugs in target repos).
- A live network filesystem mount (SMB/NFS/SSHFS) between the Mac and the
  remote machine was rejected: file-watching (inotify/chokidar, used by
  Vite/nodemon for hot reload) generally does not propagate correctly over
  network mounts, and many-small-file operations (`npm install`, `.git`)
  are slow over that kind of mount. Continuous background sync to a real
  local disk on each side (Mutagen) avoids both problems.

## Architecture

```
┌─────────────────────────┐         SSH          ┌──────────────────────────┐
│           Mac            │◄─────────────────────►│   Remote (Linux/WSL2)    │
│  (control machine,       │                        │  (fully trusted, runs   │
│   source of truth)       │                        │   Claude Code itself)   │
│                           │                        │                          │
│  ~/.claude/    ──────────┼── Mutagen sync #1 ─────┼──► <homeMirror>/.claude/ │
│  (session/memory/login)  │   (persistent,          │   (identical content,   │
│                           │    always-on)           │    identical role)      │
│                           │                        │                          │
│  <workspace local path>  │                        │                          │
│  ─────────────────────── ┼── Mutagen sync #2 ─────┼──► <same absolute path>  │
│  (retargeted per          │   (ignores               │   (created on remote   │
│   CLAUDE_REMOTE_WORKSPACE)│    node_modules/.venv/   │    during setup)        │
│                           │    dist/build/__pycache__)│                        │
└─────────────────────────┘                        └──────────────────────────┘
```

Two independent Mutagen sync sessions, not one:

1. **`claude-home`** — syncs `~/.claude` (Mac) to `<homeMirrorPath>/.claude`
   (remote). Created once during `setup`, runs continuously in the
   background regardless of which workspace is active. Carries Claude
   Code's session transcripts, the auto-memory system's files, and login
   state, so a session started on the Mac can be resumed on the remote and
   vice versa with full history and memory intact.
2. **`workspace`** — syncs whichever local project directory is currently
   active to the *identical absolute path* on the remote. Retargeted
   whenever `CLAUDE_REMOTE_WORKSPACE` points at a different local directory
   than the session that's currently running.

### The identical-absolute-path trick (carried over from `claude-docker`)

Claude Code keys its per-project session storage
(`~/.claude/projects/<sanitized-path>/`) off the **sanitized absolute path**
of the working directory it's launched from. `claude-docker` already solved
this once: it mounts the Mac workspace at the exact same absolute path
inside the Linux container (`/Users/pak/Projects/Deepsel`, not `/workspace`)
and mounts `~/.claude` at the same absolute path too, specifically so
session/memory storage resolves to the identical project key whether a
session runs on the host or in the container.

`claude-remote` reuses this exact trick, but since there's no bind mount
available across a network boundary, it's done via `CLAUDE_CONFIG_DIR`
(Claude Code's official override for where it reads/writes `~/.claude`) and
by creating matching directory structure on the remote:

- `remote.homeMirrorPath` in config (e.g. `/Users/pak/`) is a directory
  created on the remote — even though it isn't that machine's natural home
  directory (e.g. real home on a Linux remote is `/home/pak`) — whose sole
  purpose is to mirror the Mac's absolute paths closely enough that
  sanitized project keys match.
- The workspace's parent directories are created under that mirror path to
  match the Mac's absolute path exactly (e.g.
  `/Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site` exists
  verbatim on the remote, not `/home/pak/workspace/alcoris-site`).
- `launch` sets `CLAUDE_CONFIG_DIR=<homeMirrorPath>/.claude` when starting
  `claude` on the remote, so it reads/writes the synced `.claude` directory
  instead of its own real home's default location.

## Components (`src/`)

| File | Responsibility |
|---|---|
| `config.ts` | Load + validate `config.yaml` against a Zod schema; expose typed config. Resolves `CLAUDE_REMOTE_WORKSPACE` env var override on top of `workspace.local`. |
| `ssh.ts` | SSH connectivity check (`ssh -i <key> user@host echo ok`), run a single remote command and capture output, build the interactive SSH+tmux command string used by `launch.ts`. |
| `setup.ts` | One-time wizard: connectivity check → detect remote OS (plain Linux vs WSL2 vs unsupported) → check/install Node.js, tmux, Claude Code CLI on the remote → create `homeMirrorPath` directory structure (`.claude` + workspace parent dirs) → create and start the `claude-home` Mutagen sync session. |
| `sync.ts` | Thin wrapper over the `mutagen` CLI: check whether a named sync session exists (`mutagen sync list`), create it if missing, start/pause/terminate, surface conflict state. Used for both the `claude-home` and `workspace` sessions. |
| `launch.ts` | Resolve active workspace path (env var or config default) → ensure the `workspace` Mutagen sync session exists and targets that path (retarget if it's pointing elsewhere) → SSH into remote, attach-or-create a tmux session (`tmux new-session -A -s <name>`), `cd` into the workspace, export `CLAUDE_CONFIG_DIR`, run `claude --dangerously-skip-permissions`. |
| `cli.ts` | Subcommand routing: `setup`, `sync` (status/start/stop), `launch`, `status` (connectivity + both sync sessions' state, surfaced conflicts). |
| `bin/claude-remote.ts` | Executable entrypoint (shebang), delegates to `cli.ts`. |

## Config schema (`config.yaml`, single remote machine)

```yaml
remote:
  host: 192.168.1.50
  user: pak
  sshKeyPath: ~/.ssh/id_ed25519     # optional; falls back to ssh-agent/default identity
  os: linux                          # linux | windows-wsl2
  homeMirrorPath: /Users/pak         # base path created on remote to mirror Mac's absolute paths

workspace:
  local: /Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site
  # ^ default; overridden per-invocation by CLAUDE_REMOTE_WORKSPACE env var.
  # Remote path is always the identical absolute path under homeMirrorPath —
  # there is no separate "workspace.remote" field.

sync:
  ignore: [node_modules, .venv, dist, build, __pycache__]

tmux:
  sessionName: claude-remote

launch:
  autoStartClaude: true
  claudeArgs: ["--dangerously-skip-permissions"]
```

## Data flow

1. **`claude-remote setup`** (once per remote machine): validates SSH
   connectivity, detects OS, checks/installs Node.js + tmux + Claude Code
   CLI on the remote, creates the mirrored directory structure, creates and
   starts the `claude-home` sync session. Idempotent — safe to re-run if a
   dependency was added later or the remote was rebuilt.
2. **`claude-remote launch`** (every work session, or whenever
   `CLAUDE_REMOTE_WORKSPACE` points at a different project): resolves the
   active workspace path, ensures the `workspace` sync session exists and
   is targeting that path, then opens an interactive SSH+tmux session that
   drops straight into a running Claude Code session on the remote, with
   `CLAUDE_CONFIG_DIR` pointed at the synced `.claude` mirror.
3. The Mutagen daemon on the Mac keeps both sync sessions running in the
   background independently of whether a `launch` SSH session is attached.
   Detaching tmux (`Ctrl-b d`) and closing the terminal does not stop the
   remote Claude Code process or the sync; re-running `launch` reattaches
   to the same tmux session.

## Error handling & operational notes

- SSH connectivity failure: print the exact SSH command that failed and
  suggest checking `~/.ssh/config` / the configured key path. Do not
  attempt to generate or copy keys — key setup is assumed to already exist.
- Windows remote without WSL2 detected: abort `setup` with a link to WSL2
  install instructions. Not auto-installed (typically requires a
  Windows-side reboot, out of scope for a script run over SSH).
- Mutagen conflict (both sides edited the same file while disconnected):
  default resolution favors the remote side (`beta` in Mutagen terms),
  since the remote is where active Claude Code work happens. Conflicts and
  their resolution are visible via `claude-remote status`.
- **Concurrent git writes on both sides**: both the Mac and remote have a
  live, bidirectionally-synced `.git` directory. Running git write
  operations (commit, checkout, merge) on both sides at the same time can
  produce a confusing conflict. Not architecturally prevented in v1 — 
  documented as an operational rule (do your git work from one side at a
  time) in the README.
- Full `~/.claude` sync (including login/credential state) was a deliberate
  choice, matching `claude-docker`'s precedent: the remote machine is
  already fully trusted (it's the intended target for
  `--dangerously-skip-permissions`), so sharing Claude Code's identity
  across both machines is consistent with that trust level rather than an
  additional exposure.

## Testing

Manual verification only, matching `claude-docker`'s convention (personal,
low-change-frequency tool) — no vitest/CI setup. Verify by running each
command against a real remote machine: `setup` completes and leaves both
dependencies installed and the `claude-home` session syncing; editing a
file on either side while `sync` is running propagates to the other within
a few seconds; `launch` attaches to the correct tmux session, in the
correct directory, with Claude Code able to resume a session started from
the other machine.

## Implementation note

The user has asked that all code in this project carry detailed WHY-focused
comments, matching the density and style already used in `claude-docker`'s
`Dockerfile`/`entrypoint.sh` (e.g. explaining *why* a given workaround
exists, what precedent it follows, what would break without it) — not
just what the code does. This applies to the implementation plan and all
subsequent code in this repo.
