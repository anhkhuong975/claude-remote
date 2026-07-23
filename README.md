# claude-remote

[![npm version](https://img.shields.io/npm/v/claude-remote-sync.svg)](https://www.npmjs.com/package/claude-remote-sync)

## What this is

`claude-remote` runs Claude Code (with `--dangerously-skip-permissions`) on a
separate, fully-trusted machine — instead of on your own Mac — while making
that remote session feel local. It keeps two things continuously synced
between your Mac and the remote machine via [Mutagen](https://mutagen.io):

- Claude Code's own config and session history (`~/.claude`)
- Your active project's files

Then it drops you into a live Claude Code session on the remote over SSH +
tmux, working on the synced copy of your project.

**Why:** `--dangerously-skip-permissions` gives Claude Code unrestricted
filesystem/shell access with no confirmation prompts — safer to run against a
separate machine's filesystem than your own. Continuous two-way sync is what
makes that separate machine still feel like your own dev environment: same
project files, same Claude session history, resumable from either side.

The remote machine doesn't need to be on the same local network as your Mac —
any host you can SSH into works (LAN, a machine reachable over the internet,
or one behind a VPN/Tailscale). See "How it works" below for what's actually
required.

## How it works

```
  Mac (control)                                    Remote (Linux / WSL2)
  ------------------------                         ------------------------

  ~/.claude               --- Mutagen sync --->     <homeMirrorPath>/.claude
  (config + history)          "claude-home"
                               (started once by
                                `claude-remote setup`,
                                runs permanently)

  <active project>        --- Mutagen sync --->     <same absolute path>
                               "workspace"
                               (retargeted on every
                                `claude-remote launch`)

  `claude-remote launch`  --- SSH + tmux ----->      Claude Code running
  attaches here                                      inside the workspace
```

Two Mutagen sync sessions run independently of each other:

1. **`claude-home`** — mirrors `~/.claude` (Claude Code's config and session
   history) between the Mac and `<homeMirrorPath>/.claude` on the remote.
   Created once by `claude-remote setup` and left running in the background
   from then on — it isn't tied to any particular project.
2. **`workspace`** — mirrors your active project directory. Retargeted every
   time you run `claude-remote launch`, either against the project set in
   `config.yaml` or a different one passed via `CLAUDE_REMOTE_WORKSPACE`.

Both sessions sync two-way. If the same file changes on both sides before a
sync catches up, **the remote's copy always wins** — see "Operational rules"
below for what that means in practice.

On top of sync, `claude-remote launch` opens an SSH connection to the remote
and attaches to a tmux session there, running Claude Code inside the synced
workspace. Detaching (`Ctrl-b d`) leaves that tmux session — and Claude Code —
running on the remote; running `claude-remote launch` again reattaches to it
instead of starting a new one.

**Why paths have to line up:** `homeMirrorPath` in `config.yaml` is set to
mirror the Mac's own home directory path (e.g. `/Users/pak`), and your project
lives at the same absolute path on both sides. This is what lets Claude Code
resume a session that has history from the other machine — its own
path-derived session keys only match up because the paths are identical, not
just similarly structured.

## Components

| Component | Runs on | Responsibility |
|---|---|---|
| `claude-remote` CLI | Mac | Everything you run — `setup`, `launch`, `status`, `monitor`, `config`. |
| `config.yaml` | Mac | Single source of truth: remote host/user/OS, path layout, sync ignore list, tmux session name, launch behavior. |
| Mutagen | Mac (daemon) + Remote (agent, auto-installed by Mutagen itself) | Owns both sync sessions described above. |
| `tmux`, Node.js (via `nvm`), Claude Code CLI | Remote | Installed automatically by `claude-remote setup` — nothing to install by hand beyond SSH access. |

## Prerequisites

**On the Mac:**
- Node.js >= 18 (to install/run the `claude-remote` CLI itself)
- `brew install mutagen-io/mutagen/mutagen`
- SSH key access to the remote already working — `ssh <user>@<host>` should
  need no password or prompt. This tool never generates or copies keys for
  you.

**On the remote machine:**
- Linux (any apt-based distro) or Windows with WSL2 already installed
  (native Windows without WSL2 is not supported).
- Reachable over SSH from the Mac.
- On Windows specifically: the machine's SSH server must be configured so an
  *incoming* SSH connection lands inside WSL2, not native PowerShell/cmd.exe
  — the default OpenSSH Server on Windows drops you into PowerShell unless
  it's been set up to hand sessions to the Linux userspace. `claude-remote
  setup` assumes this is already true; it does not check or configure it,
  and every remote command it runs expects a bash/Linux shell. Step-by-step:
  `docs/remote-setup/windows-wsl2.md` (Windows) or `docs/remote-setup/linux.md`
  (Linux).
- `tmux`, Node.js, and the Claude Code CLI are **not** manual prerequisites —
  `claude-remote setup` installs all three.

## Setup

Install:

```bash
npm install -g claude-remote-sync
```

Create `~/.config/claude-remote/config.yaml`:

```bash
mkdir -p ~/.config/claude-remote
```

with these fields:

```yaml
remote:
  host: 192.168.1.50          # or a public hostname/IP — LAN is not required
  user: pak
  sshKeyPath: ~/.ssh/id_ed25519   # optional — falls back to ssh-agent/~/.ssh/config
  os: linux                   # or windows-wsl2 — checked against `uname -a` during setup
  homeMirrorPath: /Users/pak  # must match `echo $HOME` on THIS Mac

workspace:
  local: /path/to/your/project

sync:
  ignore: [node_modules, .venv, dist, build, __pycache__]

tmux:
  sessionName: claude-remote

launch:
  autoStartClaude: true
  claudeArgs: ["--dangerously-skip-permissions"]
```

Then run the one-time setup, which verifies SSH access and installs
everything needed on the remote (`tmux`, Node.js, the Claude Code CLI), and
starts the `claude-home` sync session:

```bash
claude-remote setup
```

## Daily use

```bash
claude-remote launch
# or, to work on a different project without editing config.yaml:
CLAUDE_REMOTE_WORKSPACE=/path/to/other/repo claude-remote launch
```

`launch` syncs the active workspace and drops you into a live Claude Code
session on the remote, inside a tmux session. Detach with `Ctrl-b d` any
time; running `claude-remote launch` again reattaches to that same session
instead of starting a new one.

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
- `claude-remote monitor [--interval <seconds>]` — live-stream a combined
  dashboard: both sessions' Mutagen sync status plus CPU/RAM/disk
  performance for the Mac and the remote, refreshed every `--interval`
  seconds (default `3`). `Ctrl+C` stops watching, not the sync itself — it
  keeps running in Mutagen's background daemon either way.
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

## Publishing

Published to npm as `claude-remote-sync`. Releases are built and published
by `.github/workflows/publish.yml`, triggered by pushing a `vX.Y.Z` tag —
nothing is ever published from a local machine.

**One-time setup (do this once, before the first release):**

1. `npm login` locally and run `npm publish --access public` once by hand.
   npm's Trusted Publisher setting (used for every release after this) lives
   on a package's settings page, which only exists once the package has been
   published at least once.
2. On npmjs.com: package page → *Settings* → *Publishing access* → add a
   Trusted Publisher — GitHub Actions, repo `anhkhuong975/claude-remote`,
   workflow file `publish.yml`, no environment.
3. From then on, CI publishes via OIDC (no `NPM_TOKEN` secret needed, per
   the `id-token: write` permission in the workflow).

**Every release after that:**

```bash
npm version patch   # or minor / major — bumps package.json + creates a git tag
git push --follow-tags
```

The workflow verifies the pushed tag matches `package.json`'s version,
builds, and publishes with provenance.

## Manual end-to-end verification checklist

This project has no automated tests and was implemented without a reachable
SSH target available during initial development. The following still needs
a real run against an actual remote machine before trusting this day-to-day:

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
- [ ] `claude-remote monitor`: confirm both the Sync section and both
      Performance sections render without errors against a real remote,
      and the numbers roughly match what Activity Monitor (Mac) / `htop`
      (remote) report at the same moment.
- [ ] While `monitor` is running, briefly disconnect the remote (e.g.
      disable Wi-Fi for a few seconds): confirm the remote Performance
      section shows the `(stale — ...)` marker instead of crashing the
      dashboard, and recovers automatically once connectivity returns.
- [ ] Ctrl+C out of `monitor`, then check for leftover processes/sockets:
      `ps aux | grep '[s]sh -f -N -M'` should show nothing, and the
      control socket file (`/tmp/claude-remote-ssh-*.sock`) should be gone.
