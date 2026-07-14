# claude-remote — Monitor Performance Dashboard — Design Spec

Date: 2026-07-14
Status: Approved (pending implementation plan)

## Purpose

`claude-remote monitor` currently just spawns `mutagen sync monitor --long`
with `stdio: 'inherit'`, handing the terminal entirely to Mutagen's own
live-redrawing UI. That UI shows sync state only (staging progress,
conflicts, watch status) — it has no idea what either machine's CPU/RAM/disk
load looks like.

This spec extends `monitor` into a combined dashboard: the same sync status
info, plus live CPU/RAM/disk numbers for both the Mac and the remote,
refreshed periodically, in one terminal view — without the act of collecting
those numbers becoming a meaningful load on either machine itself.

## Why not keep Mutagen's own live UI

Covered in conversation preceding this spec: Mutagen's `sync monitor --long`
owns stdio and redraws its own UI on its own schedule; there's no supported
way to inject additional panels (like performance numbers) into that output.
The only way to get one combined view is to stop shelling out to Mutagen's
live monitor and instead poll `mutagen sync list <name> --long` (a one-shot,
cheap call) ourselves on a timer, alongside the performance snapshots, and
render the combination.

## Components (`src/`)

| File | Responsibility |
|---|---|
| `performance.ts` (new) | Pure metric collection, no SSH/monitor-loop knowledge. `getLocalPerformanceSnapshot()`: Mac-side, runs `uptime` (load average), `vm_stat` (RAM), `df -h` (disk) as one-shot local commands. `getRemotePerformanceSnapshot(remote, controlSocketPath)`: remote-side, a **single** SSH command bundling `cat /proc/loadavg`, `free -m`, and `df -h` (one round trip, not three), routed through the existing ControlMaster socket. |
| `monitor.ts` (new) | Orchestration: starts an SSH ControlMaster on entry, runs the poll loop (sync status via `sync.ts`'s existing `getSessionStatusText` + both performance snapshots) on a configurable interval, renders the combined terminal dashboard, tears down the ControlMaster cleanly on exit (Ctrl+C / SIGINT). Replaces the old `monitorSessions` function that lived in `sync.ts`. |
| `ssh.ts` (modified) | Adds `startControlMaster(remote): Promise<string>` (returns the control socket path; spawns `ssh -M -S <socket> -N -o ControlPersist=yes ...`) and `stopControlMaster(remote, socketPath): Promise<void>` (`ssh -S <socket> -O exit ...`). `runRemoteCommand` gains an optional control-socket parameter so callers that already have a master connection running reuse it instead of paying a fresh handshake. |
| `sync.ts` (modified) | `monitorSessions` removed (moved/replaced by `monitor.ts`). All other exports (`createSession`, `ensureSession`, `getSessionStatusText`, `sessionExists`) unchanged. |
| `cli.ts` (modified) | `monitor` command gains `--interval <seconds>` (default `3`), wired to `monitor.ts`'s new orchestration entry point instead of `sync.ts`'s old `monitorSessions`. |

## Data flow

Every `interval` seconds (default 3, configurable via `--interval`):

1. Fetch sync status for both active sessions (`claude-home` + the current
   workspace session) via the existing `getSessionStatusText` — already a
   cheap one-shot `mutagen sync list --long` call.
2. Fetch the Mac's performance snapshot — local one-shot commands, no
   network involved.
3. Fetch the remote's performance snapshot — one SSH command over the
   already-open ControlMaster socket (near-zero handshake cost after the
   first connection).
4. Redraw the terminal in place (cursor-home + clear-to-end, not a full
   `console.clear()`, to avoid flicker) with the combined dashboard.

Loop continues until Ctrl+C. On exit: stop the poll loop, close the
ControlMaster socket, exit — no orphaned background SSH process or stale
socket file left behind.

## Terminal display design

Box-drawn sections, block-character progress bars, ANSI color only when
`process.stdout.isTTY` is true (skipped automatically when output is
redirected to a file/log):

```
claude-remote monitor — refresh every 3s (Ctrl+C stops watching, sync keeps running)   14:32:07

┌─ Sync ──────────────────────────────────────────────────────────────────┐
│ claude-remote-claude-home       ● Watching for changes                  │
│ claude-remote-workspace-...     ● Staging  [███████░░░░░░░░]  46%       │
└───────────────────────────────────────────────────────────────────────-┘

┌─ Performance ───────────────────┬───────────────────────────────────────┐
│  Mac (local)                    │  Remote (cookie@192.168.1.11)          │
│  CPU load : 2.1  (4 cores)      │  CPU load : 0.8  (8 cores)             │
│  RAM      : [████████░░] 62%    │  RAM      : [███░░░░░░░] 31%           │
│  Disk (/) : [██████░░░░] 58%    │  Disk (/) : [████░░░░░░] 41%           │
└──────────────────────────────────┴──────────────────────────────────────┘
```

RAM/disk bars color-coded by threshold (green < 60%, yellow 60–85%, red >
85%) for fast visual scanning.

## Keeping the dashboard itself cheap

This was the user's explicit, top-priority constraint, satisfied by four
design choices working together:

1. Every metric is a single cheap read (`/proc/loadavg`, `free`, `df`,
   `uptime`, `vm_stat`) — never a continuous sampler like `top`/`htop`.
2. The remote side bundles all three metrics into **one** SSH command per
   cycle instead of three separate round trips.
3. SSH ControlMaster means only the *first* connection pays a real
   handshake; every subsequent poll during the session reuses the open
   multiplexed connection at near-zero cost.
4. Default interval is 3 seconds (user-configurable) — the steady-state
   cost per cycle is a handful of near-instant file reads/syscalls on each
   side, negligible next to whatever real work (compiling, dev servers) is
   actually running on either machine.

## Error handling

- A single cycle's remote performance fetch failing (transient
  disconnect, dead ControlMaster socket) does not crash the dashboard: that
  panel shows its last-known values with a `(stale)` marker; sync status and
  the Mac's own panel keep updating normally.
- ControlMaster failing to start at all (remote unreachable) fails fast
  *before* entering the loop, with a clear error — same pattern as
  `checkConnectivity` elsewhere in this codebase. The dashboard never
  silently starts empty.
- `sessionExists`/`getSessionStatusText` errors (e.g. `mutagen` missing
  from `PATH`) propagate immediately, same as today's `status`/`monitor`
  behavior — these are real setup problems, not something to paper over.
- SIGINT (Ctrl+C): stop the poll loop, explicitly close the ControlMaster
  (`ssh -S <socket> -O exit ...`) before the process exits, so no orphaned
  background `ssh` process or leftover socket file survives the dashboard
  session.

## Testing

Manual verification only, matching the rest of this project's convention
(see the original design spec's "Testing" section) — no automated test
suite. Verify against a real remote: `monitor` renders both sections
correctly, RAM/disk bars react to real load changes, a brief network drop
shows `(stale)` on the remote panel without crashing the loop, and Ctrl+C
leaves no orphaned `ssh -M` process (`ps aux | grep ssh` on the Mac) or
stale control socket file behind.

## Implementation note

Same detailed WHY-focused comment density requirement as the rest of this
project (see the original design spec's "Implementation note") applies to
all code written for this feature.
