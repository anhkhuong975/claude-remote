# claude-remote

Run Claude Code (with `--dangerously-skip-permissions`) on a fully-trusted,
physically separate machine instead of in a local Docker container. Keeps
`~/.claude` and the active project workspace continuously synced to that
machine via [Mutagen](https://mutagen.io), and drops you into a live Claude
Code session there over SSH + tmux.

Sibling tool to `claude-docker` — same author, same personal/local-only
status (never pushed to a remote git host). Full design rationale:
`docs/superpowers/specs/2026-07-13-claude-remote-design.md`.

## Prerequisites

**On the Mac (control machine):**
- `brew install mutagen-io/mutagen/mutagen`
- SSH key access to the remote already working (`ssh <user>@<host>` should
  need no password or prompt) — this tool never generates or copies keys
  for you.

**On the remote machine:**
- Linux (any apt-based distro) or Windows with WSL2 already installed
  (native Windows without WSL2 is not supported — see the design spec).
  On Windows, this also requires the machine's own SSH server to be
  configured so an *incoming* SSH connection lands inside WSL2, not
  native PowerShell/cmd.exe — the default OpenSSH Server on Windows
  drops you into PowerShell unless it's been specifically set up (or is
  itself running inside WSL2) to hand sessions to the Linux userspace.
  `claude-remote setup` assumes this is already true; it does not check
  or configure it for you, and every remote command it runs (`uname -a`,
  `apt-get`, `mkdir -p`, `command -v ...`) expects a bash/Linux shell.
- Reachable over SSH from the Mac.
- Everything else (`tmux`, Node.js, the Claude Code CLI) is installed
  automatically by `claude-remote setup`.

## Setup

```bash
npm install
npm run build
npm link          # puts `claude-remote` on PATH

mkdir -p ~/.config/claude-remote
cp config.example.yaml ~/.config/claude-remote/config.yaml
# edit ~/.config/claude-remote/config.yaml: remote.host, remote.user,
# remote.os (linux or windows-wsl2 — checked against `uname -a` during
# setup), remote.sshKeyPath, remote.homeMirrorPath (should match
# `echo $HOME` on the Mac, e.g. /Users/pak), workspace.local

claude-remote setup
```

## Daily use

```bash
claude-remote launch
# or, to work on a different project without editing config.yaml:
CLAUDE_REMOTE_WORKSPACE=/path/to/other/repo claude-remote launch
```

`launch` drops you into a tmux session on the remote, running Claude Code
in the synced workspace. Detach with `Ctrl-b d` any time; running
`claude-remote launch` again reattaches to the same session instead of
starting a new one.

Check sync/connectivity state without launching: `claude-remote status`.

## Command reference

- `--config <path>` (global option, before the subcommand) — use a
  config file other than the default `~/.config/claude-remote/config.yaml`.
- `claude-remote setup` — one-time: verify SSH access, install remote
  dependencies, start the `~/.claude` sync session.
- `claude-remote launch [-y|--yes]` — sync the active workspace and drop
  into a live Claude Code session on the remote. `-y`/`--yes` skips the
  concurrent-session confirmation prompt described below (see
  "Operational rules") — useful for scripting, but skips a real safety
  check, so don't reach for it out of habit.
- `claude-remote status` — show SSH connectivity and both sync sessions'
  state.
- `claude-remote config` — print the fully resolved config (after any
  `CLAUDE_REMOTE_WORKSPACE` override) as JSON; useful for confirming
  which workspace/paths a command would actually use before running it.

## Operational rules (read before your first real session)

- **Never run Claude Code on both the Mac and the remote at the same
  time.** `~/.claude` is synced continuously, not instantly — running
  both sides at once can clobber the Mac's session/memory state (the
  remote side wins on conflict). `launch` prompts you to confirm this
  before every session; don't reflexively pass `--yes` unless you've
  actually checked.
- **Avoid git write operations (commit, checkout, merge) on both sides at
  the same time**, for the same reason — both sides have a live,
  bidirectionally-synced `.git` directory.
- Conflicts, if they happen, default to "remote wins". Check
  `claude-remote status` if something looks like it reverted unexpectedly.

## Manual end-to-end verification checklist

This project has no automated tests (see the design spec's "Testing"
section) and was implemented without a reachable SSH target available
(macOS Remote Login was left off during implementation — see the plan's
"Global Constraints"). Everything up through real command construction
and local error-handling paths was verified during implementation; the
following still needs a real run against an actual remote machine before
trusting this day-to-day:

- [ ] `claude-remote setup` against a real, freshly-provisioned Linux or
      WSL2 machine: completes without error, leaves `tmux`, `node`, and
      `claude` installed, and `mutagen sync list claude-remote-claude-home`
      shows the session as `Watching for changes`.
- [ ] Edit a file inside `~/.claude/projects/` on the Mac; confirm it
      appears on the remote within a few seconds (and vice versa).
- [ ] `claude-remote launch`: confirm it attaches to the correct tmux
      session, in the correct directory, with `CLAUDE_CONFIG_DIR` set
      correctly (`echo $CLAUDE_CONFIG_DIR` inside the session), and that
      Claude Code can resume a session that has history from the Mac.
- [ ] Detach (`Ctrl-b d`), run `claude-remote launch` again: confirm it
      reattaches to the same tmux session instead of creating a new one.
- [ ] Edit a file in the workspace on the remote; confirm it propagates
      back to the Mac.
- [ ] **Conflict direction (highest-risk item — see the WHY-comment above
      `createSession` in `src/sync.ts`):** pause or disconnect the
      workspace Mutagen session (`mutagen sync pause <name>`), edit the
      *same* file on both the Mac and the remote with different content,
      then resume/reconnect (`mutagen sync resume <name>`) and let it
      resolve. Confirm the **remote's** edit is the one that survives. If
      the Mac's edit survives instead, that confirms the Critical
      finding's risk materialized — `--default-conflict-resolution=beta`
      either isn't a real flag or doesn't override `two-way-resolved`'s
      default, and the conflict-resolution flag needs fixing before this
      tool's "remote wins" claim can be trusted.
- [ ] `claude-remote status`: confirm both sessions show as syncing and
      SSH shows as reachable.
