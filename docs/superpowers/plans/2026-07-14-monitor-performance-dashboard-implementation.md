# Monitor Performance Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `claude-remote monitor` from a thin wrapper around `mutagen sync monitor --long` into a combined dashboard showing both Mutagen sync status and live CPU/RAM/disk performance for the Mac and the remote, refreshed on a timer, without the performance-polling itself becoming a meaningful load on either machine.

**Architecture:** Two new modules — `src/performance.ts` (pure metric collection + pure fixture-testable parsers for both the Mac's local commands and one bundled SSH command on the remote) and `src/monitor.ts` (SSH ControlMaster lifecycle, the poll loop, and pure fixture-testable dashboard rendering) — replace the old `monitorSessions` function in `src/sync.ts`. `src/ssh.ts` gains ControlMaster helpers so the remote side of every poll cycle reuses one already-authenticated SSH connection instead of paying a fresh handshake every cycle.

**Tech Stack:** Same as the rest of this project — TypeScript strict/NodeNext, no new dependencies (no TUI/color library; ANSI codes and box-drawing characters are hand-rolled, matching the project's existing "shell out to real binaries, no extra abstraction" philosophy from `sync.ts`).

## Global Constraints

- Same base constraints as `docs/superpowers/plans/2026-07-13-claude-remote-implementation.md` (Node.js, TypeScript strict, detailed WHY-focused comments, manual verification only — no automated test suite).
- Design source of truth: `docs/superpowers/specs/2026-07-14-monitor-performance-dashboard-design.md`. Every task below implements one row of that spec's Components table.
- **Default refresh interval is 3 seconds**, overridable via `claude-remote monitor --interval <seconds>` (per the user's explicit correction during design — the spec's own mockup shows 3s, not the initially-discussed 5s).
- **Layout deviates from the design spec's ASCII mockup in one way, deliberately:** the spec's mockup shows Mac and Remote performance side-by-side in two columns. This plan implements a **stacked** layout (Mac section, then Remote section below it) instead — hand-aligning two side-by-side text columns to survive variable-width numbers (e.g. `12.34` vs `2.1`) without misaligned borders is fragile and error-prone, and a stacked layout is exactly as readable while being far simpler to implement correctly. Sync status and per-machine bars/colors are otherwise implemented exactly as specced.
- **No `git commit` during this implementation pass.** The user explicitly said to write the code now and commit later themselves (git identity — `user.name`/`user.email` — is not configured on this remote machine, and per this project's own git safety rules, an agent must never run `git config` to set it). Every task below ends at manual verification; there is no "Commit" step in this plan. Do not run `git add`/`git commit` while executing this plan.
- **Verification boundary (read before executing) — different from the original plan's, because this implementation pass is happening *from the remote machine itself*, not the Mac:**
  - `mutagen` is not installed on this remote machine (confirmed: `command -v mutagen` → not found) — it only ever runs on the Mac (see the original design spec's architecture). Nothing in this plan can verify `getSessionStatusText` end-to-end from here.
  - `ssh` is present, and this machine cannot authenticate to its own `localhost` (confirmed: `ssh localhost echo ok` → `Permission denied (publickey,password)`) — a real, reproducible auth failure. Use `localhost` as the target for every SSH-based failure-path verification, exactly like the original plan's Task 3 pattern.
  - Every metric-parsing function in `src/performance.ts` and every rendering function in `src/monitor.ts` is designed as a **pure function tested against fixture strings** specifically so it can be verified from any machine, regardless of OS — this sidesteps the fact that `getLocalPerformanceSnapshot`'s real commands (`uptime`, `vm_stat`) are macOS-only and cannot be executed for real on this Linux/WSL2 box.
  - A real, live end-to-end run (`claude-remote monitor` against the actual Mac↔remote pair, watching real numbers change under real load) is out of scope for this pass and remains for the user to verify later, same as the original plan's README checklist items.

---

### Task 1: SSH ControlMaster helpers

**Files:**
- Modify: `src/ssh.ts`

**Interfaces:**
- Produces (new): `startControlMaster(remote): Promise<string>`, `stopControlMaster(remote, socketPath): Promise<void>`.
- Modifies existing: `runRemoteCommand(remote, command, controlSocketPath?)` — third parameter is new and optional, so every existing caller (`setup.ts`, `launch.ts`) keeps working unchanged.

- [ ] **Step 1: Add the imports `startControlMaster`/`stopControlMaster` need**

In `src/ssh.ts`, change the top of the file from:

```ts
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
```

to:

```ts
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
```

- [ ] **Step 2: Give `runRemoteCommand` an optional control-socket parameter**

Replace the existing `runRemoteCommand` function:

```ts
export function runRemoteCommand(remote: Config['remote'], command: string): Promise<SshResult> {
  return new Promise((resolvePromise, reject) => {
    const args = [...buildSshBaseArgs(remote), command];
    const child = spawn('ssh', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}
```

with:

```ts
/**
 * Runs a single command on the remote over SSH and captures its output.
 * Used by setup.ts for OS detection and dependency checks (no
 * controlSocketPath — each of those runs once, so there's nothing to
 * amortize) and by performance.ts's getRemotePerformanceSnapshot (always
 * passes controlSocketPath, since that one runs every monitor cycle and
 * a fresh handshake each time would defeat the whole point of the
 * ControlMaster — see startControlMaster below).
 */
export function runRemoteCommand(
  remote: Config['remote'],
  command: string,
  controlSocketPath?: string
): Promise<SshResult> {
  return new Promise((resolvePromise, reject) => {
    const socketArgs = controlSocketPath ? ['-S', controlSocketPath] : [];
    const args = [...socketArgs, ...buildSshBaseArgs(remote), command];
    const child = spawn('ssh', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}
```

- [ ] **Step 3: Add `startControlMaster` and `stopControlMaster` at the end of `src/ssh.ts`**

```ts
/**
 * Where a session's SSH multiplexing control socket lives while a
 * ControlMaster connection from this process is open. Keyed by both
 * remote.host and process.pid so two claude-remote processes targeting
 * the same remote at once (e.g. `launch` running in one terminal,
 * `monitor` in another) never collide on the same socket file.
 */
function controlSocketPath(remote: Config['remote']): string {
  return join(tmpdir(), `claude-remote-ssh-${remote.host}-${process.pid}.sock`);
}

/**
 * Opens a long-lived SSH multiplexing "master" connection and returns its
 * control socket path. Every subsequent runRemoteCommand call passed this
 * path reuses the already-authenticated connection instead of paying a
 * fresh TCP+auth handshake — this is what makes monitor.ts's periodic
 * polling (default every 3s) cheap: only this first connection pays real
 * SSH connection cost.
 *
 * `-N` means "no remote command, just hold the connection open". `-f`
 * backgrounds ssh *after* authentication succeeds (OpenSSH's own
 * documented behavior for `-f`), so by the time this function's spawned
 * process exits, the socket is already live — no separate "wait until
 * ready" polling loop is needed. If authentication fails, ssh exits
 * non-zero *before* forking, so a non-zero exit code here reliably means
 * "master never came up".
 */
export function startControlMaster(remote: Config['remote']): Promise<string> {
  const socketPath = controlSocketPath(remote);
  const args = ['-f', '-N', '-M', '-S', socketPath, ...buildSshBaseArgs(remote)];

  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', args);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to start SSH control master to ${remote.host}: ${stderr.trim()}`));
        return;
      }
      resolvePromise(socketPath);
    });
  });
}

/**
 * Closes a control master started by startControlMaster. Best-effort —
 * never rejects — because this runs during monitor.ts's Ctrl+C teardown,
 * where the priority is exiting cleanly; a secondary cleanup failure (the
 * socket already gone because the connection dropped on its own, say)
 * shouldn't block or mask that exit. Logs a warning instead of throwing
 * so a genuinely stuck orphaned process is still visible, not silent.
 */
export function stopControlMaster(remote: Config['remote'], socketPath: string): Promise<void> {
  const args = ['-S', socketPath, '-O', 'exit', ...buildSshBaseArgs(remote)];
  return new Promise((resolvePromise) => {
    const child = spawn('ssh', args);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      console.warn(`Warning: failed to close SSH control master: ${err.message}`);
      resolvePromise();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(`Warning: SSH control master exit reported non-zero (${code}): ${stderr.trim()}`);
      }
      resolvePromise();
    });
  });
}
```

- [ ] **Step 4: Manual verification — real SSH process against `localhost`, exercising the real auth-failure path confirmed above in this plan's Verification boundary**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { startControlMaster } from './src/ssh.js';
const remote = { host: 'localhost', user: 'cookie', os: 'linux' as const, homeMirrorPath: '/tmp' };
startControlMaster(remote)
  .then((socket) => console.log('UNEXPECTED: master started at', socket))
  .catch((err) => console.log('EXPECTED FAILURE:\n' + err.message));
"
```
Expected output: starts with `EXPECTED FAILURE:` and includes `Failed to start SSH control master to localhost` and `Permission denied` (the same auth failure confirmed manually before this plan was written).

Also confirm the codebase still builds cleanly with the modified signature:
```bash
npm run build
```
Expected: compiles with no errors (setup.ts/launch.ts call `runRemoteCommand(remote, command)` with 2 arguments, which remains valid since the third parameter is optional).

---

### Task 2: Performance metrics module

**Files:**
- Create: `src/performance.ts`

**Interfaces:**
- Consumes: `runRemoteCommand` (`src/ssh.ts`, Task 1 — now accepts an optional control-socket parameter), `Config['remote']` (`src/config.ts`).
- Produces: `PerformanceSnapshot` type, `getLocalPerformanceSnapshot(): Promise<PerformanceSnapshot>`, `getRemotePerformanceSnapshot(remote, controlSocketPath): Promise<PerformanceSnapshot>`, plus the pure parsers `parseLoadAverageFromUptime`, `parseVmStatUsedPercent`, `parseDfUsedPercent`, `parseRemoteBundle` — used by `src/monitor.ts` (Task 3) and directly by this task's own verification.

- [ ] **Step 1: Write `src/performance.ts`**

```ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, totalmem } from 'node:os';
import type { Config } from './config.js';
import { runRemoteCommand } from './ssh.js';

const execAsync = promisify(exec);

/**
 * One point-in-time reading of CPU/RAM/disk load for a single machine.
 * Deliberately just 4 numbers, not a richer structure (per-core, IO wait,
 * swap...) — this feeds a glanceable terminal dashboard whose job is
 * answering "is either machine under load right now", not a full
 * profiling tool. Every extra field would be another command/parse path
 * that can break across macOS/Linux/WSL2 differences, for a dashboard
 * that already meets the user's actual stated need.
 */
export interface PerformanceSnapshot {
  cpuLoad: number;
  cpuCores: number;
  ramUsedPercent: number;
  diskUsedPercent: number;
}

/**
 * Parses the 1-minute load average out of `uptime`'s output. Handles both
 * macOS's format ("load averages: 2.10 1.98 1.75", no comma, "averages"
 * plural) and Linux's format ("load average: 0.52, 0.58, 0.59", comma,
 * singular after the first number) with one regex — `[\d.]+` naturally
 * stops before a trailing comma, so the same pattern works on either OS
 * even though only the macOS path (getLocalPerformanceSnapshot) actually
 * calls this in practice; the remote/Linux side reads /proc/loadavg
 * directly instead (see parseRemoteBundle below).
 */
export function parseLoadAverageFromUptime(uptimeOutput: string): number {
  const match = uptimeOutput.match(/load averages?:\s*([\d.]+)/i);
  if (!match) {
    throw new Error(`Could not parse load average from uptime output: ${uptimeOutput}`);
  }
  return parseFloat(match[1]);
}

/**
 * Computes RAM used %% from `vm_stat`'s page counts plus the machine's
 * total physical memory (os.totalmem(), in bytes — avoids also having to
 * shell out to `sysctl -n hw.memsize` for the same number). "Used" here
 * means active + wired + compressor-occupied pages, not attempting to
 * replicate macOS Activity Monitor's own memory-pressure heuristic — good
 * enough for a glance, far simpler to get right.
 */
export function parseVmStatUsedPercent(vmStatOutput: string, totalMemBytes: number): number {
  const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) {
    throw new Error(`Could not parse page size from vm_stat output: ${vmStatOutput}`);
  }
  const pageSize = parseInt(pageSizeMatch[1], 10);

  const pageCount = (label: string): number => {
    const match = vmStatOutput.match(new RegExp(`Pages ${label}:\\s*(\\d+)\\.`));
    return match ? parseInt(match[1], 10) : 0;
  };

  const usedPages = pageCount('active') + pageCount('wired down') + pageCount('occupied by compressor');
  const usedBytes = usedPages * pageSize;
  return Math.round((usedBytes / totalMemBytes) * 100);
}

/**
 * Extracts the "Capacity"/"Use%%" column from `df -h <path>`. The column
 * *header* differs between macOS ("Capacity") and Linux ("Use%%"), but its
 * *value* is formatted identically on both (a bare percentage like
 * "58%%") — matching that shape directly in the data row is more robust
 * than trying to locate the right column by header name.
 */
export function parseDfUsedPercent(dfOutput: string): number {
  const lines = dfOutput.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  const match = dataLine.match(/(\d+)%/);
  if (!match) {
    throw new Error(`Could not parse used%% from df output: ${dfOutput}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Mac-side snapshot: three independent local commands run in parallel
 * (Promise.all), not bundled into one shell invocation the way the remote
 * side is (see REMOTE_PERF_COMMAND below) — these never leave the
 * machine, so there's no SSH round-trip cost to amortize by bundling, and
 * running them independently keeps one command's parse failure from
 * hiding another's result.
 */
export async function getLocalPerformanceSnapshot(): Promise<PerformanceSnapshot> {
  const [uptimeResult, vmStatResult, dfResult] = await Promise.all([
    execAsync('uptime'),
    execAsync('vm_stat'),
    execAsync('df -h /'),
  ]);

  return {
    cpuLoad: parseLoadAverageFromUptime(uptimeResult.stdout),
    cpuCores: cpus().length,
    ramUsedPercent: parseVmStatUsedPercent(vmStatResult.stdout, totalmem()),
    diskUsedPercent: parseDfUsedPercent(dfResult.stdout),
  };
}

const REMOTE_PERF_MARKER_LOADAVG = '---CLAUDE_REMOTE_LOADAVG---';
const REMOTE_PERF_MARKER_NPROC = '---CLAUDE_REMOTE_NPROC---';
const REMOTE_PERF_MARKER_FREE = '---CLAUDE_REMOTE_FREE---';
const REMOTE_PERF_MARKER_DF = '---CLAUDE_REMOTE_DF---';

/**
 * The exact remote command run once per monitor cycle — bundled into a
 * single SSH invocation (see ssh.ts's ControlMaster helpers for why
 * per-cycle SSH cost matters) instead of four separate runRemoteCommand
 * calls, with distinct markers between each section so parsing never has
 * to guess which output line came from which command.
 */
const REMOTE_PERF_COMMAND = [
  `echo '${REMOTE_PERF_MARKER_LOADAVG}'`,
  'cat /proc/loadavg',
  `echo '${REMOTE_PERF_MARKER_NPROC}'`,
  'nproc',
  `echo '${REMOTE_PERF_MARKER_FREE}'`,
  'free -m',
  `echo '${REMOTE_PERF_MARKER_DF}'`,
  'df -h /',
].join('; ');

function extractSection(bundleOutput: string, startMarker: string, endMarker: string | null): string {
  const startIdx = bundleOutput.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Marker ${startMarker} not found in remote performance output: ${bundleOutput}`);
  }
  const contentStart = startIdx + startMarker.length;
  const endIdx = endMarker ? bundleOutput.indexOf(endMarker, contentStart) : -1;
  return bundleOutput.slice(contentStart, endIdx === -1 ? undefined : endIdx).trim();
}

/**
 * Parses the marker-delimited output of REMOTE_PERF_COMMAND. Exported
 * separately from getRemotePerformanceSnapshot specifically so it's
 * directly unit-testable against a fixture string — this is the piece
 * that can be verified without a real reachable remote machine (unlike
 * getRemotePerformanceSnapshot itself, which needs a live SSH
 * connection); see this task's manual verification step.
 */
export function parseRemoteBundle(bundleOutput: string): PerformanceSnapshot {
  const loadavgSection = extractSection(bundleOutput, REMOTE_PERF_MARKER_LOADAVG, REMOTE_PERF_MARKER_NPROC);
  const nprocSection = extractSection(bundleOutput, REMOTE_PERF_MARKER_NPROC, REMOTE_PERF_MARKER_FREE);
  const freeSection = extractSection(bundleOutput, REMOTE_PERF_MARKER_FREE, REMOTE_PERF_MARKER_DF);
  const dfSection = extractSection(bundleOutput, REMOTE_PERF_MARKER_DF, null);

  const loadMatch = loadavgSection.match(/^([\d.]+)/);
  if (!loadMatch) {
    throw new Error(`Could not parse /proc/loadavg output: ${loadavgSection}`);
  }

  const cpuCores = parseInt(nprocSection.trim(), 10);

  // `free -m`'s Mem: row: "Mem: total used free shared buff/cache available"
  const memLine = freeSection.split('\n').find((line) => line.trim().startsWith('Mem:'));
  if (!memLine) {
    throw new Error(`Could not find Mem: line in free output: ${freeSection}`);
  }
  const memParts = memLine.trim().split(/\s+/);
  const totalMb = parseInt(memParts[1], 10);
  const usedMb = parseInt(memParts[2], 10);

  return {
    cpuLoad: parseFloat(loadMatch[1]),
    cpuCores,
    ramUsedPercent: Math.round((usedMb / totalMb) * 100),
    diskUsedPercent: parseDfUsedPercent(dfSection),
  };
}

/**
 * Remote-side snapshot: routed through the ControlMaster socket
 * monitor.ts's caller already has open (see ssh.ts's startControlMaster),
 * so this pays no fresh SSH handshake cost beyond the very first
 * connection of the whole monitor session.
 */
export async function getRemotePerformanceSnapshot(
  remote: Config['remote'],
  controlSocketPath: string
): Promise<PerformanceSnapshot> {
  const result = await runRemoteCommand(remote, REMOTE_PERF_COMMAND, controlSocketPath);
  if (result.code !== 0) {
    throw new Error(`Remote performance command failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return parseRemoteBundle(result.stdout);
}
```

- [ ] **Step 2: Manual verification — pure parser functions against fixture strings (works from any machine/OS, per this plan's Verification boundary)**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { parseLoadAverageFromUptime, parseVmStatUsedPercent, parseDfUsedPercent, parseRemoteBundle } from './src/performance.js';

console.log('load avg (macOS style):', parseLoadAverageFromUptime('10:32  up 2 days,  3:14, 2 users, load averages: 2.10 1.87 1.75'));
console.log('load avg (Linux style):', parseLoadAverageFromUptime('10:32 up 2 days, 3:14, 2 users, load average: 0.52, 0.58, 0.59'));

const vmStat = [
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
  'Pages free:                              100000.',
  'Pages active:                            500000.',
  'Pages inactive:                          200000.',
  'Pages wired down:                        300000.',
  'Pages occupied by compressor:              50000.',
].join('\n');
console.log('vm_stat used%:', parseVmStatUsedPercent(vmStat, 17179869184));

console.log('df used% (macOS):', parseDfUsedPercent('Filesystem  Size  Used  Avail  Capacity  Mounted on\n/dev/disk1s1  500G  290G  210G  58%  /'));
console.log('df used% (Linux):', parseDfUsedPercent('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1       500G  205G  270G  44% /'));

const remoteFixture = [
  '---CLAUDE_REMOTE_LOADAVG---',
  '0.52 0.58 0.59 1/234 5678',
  '---CLAUDE_REMOTE_NPROC---',
  '8',
  '---CLAUDE_REMOTE_FREE---',
  '              total        used        free      shared  buff/cache   available',
  'Mem:          16000        4960        8000         100        3040       10500',
  'Swap:          2048           0        2048',
  '---CLAUDE_REMOTE_DF---',
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sdb1       500G  205G  270G  44% /',
].join('\n');
console.log('remote bundle:', JSON.stringify(parseRemoteBundle(remoteFixture)));
"
```

Expected output:
```
load avg (macOS style): 2.1
load avg (Linux style): 0.52
vm_stat used%: 20
df used% (macOS): 58
df used% (Linux): 44
remote bundle: {"cpuLoad":0.52,"cpuCores":8,"ramUsedPercent":31,"diskUsedPercent":44}
```

---

### Task 3: Monitor orchestration and dashboard rendering

**Files:**
- Create: `src/monitor.ts`

**Interfaces:**
- Consumes: `getSessionStatusText` (`src/sync.ts`); `startControlMaster`, `stopControlMaster` (`src/ssh.ts`, Task 1); `getLocalPerformanceSnapshot`, `getRemotePerformanceSnapshot`, `PerformanceSnapshot` (`src/performance.ts`, Task 2); `Config` (`src/config.ts`).
- Produces: `runMonitor(config, sessionNames, opts): Promise<number>` — used by `src/cli.ts` (Task 4). Also exports `renderDashboard`, `renderBar`, `extractStagingPercent` for this task's own fixture-based verification.

- [ ] **Step 1: Write `src/monitor.ts`**

```ts
import { getSessionStatusText } from './sync.js';
import { startControlMaster, stopControlMaster } from './ssh.js';
import { getLocalPerformanceSnapshot, getRemotePerformanceSnapshot, type PerformanceSnapshot } from './performance.js';
import type { Config } from './config.js';

const BAR_WIDTH = 10;

/** Applied only when stdout is a real terminal — see renderDashboard's useColor. */
const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  // Cursor-home + clear-to-end, not a full console.clear() — redraws in
  // place each cycle without the full-screen flicker a real clear causes.
  redraw: '\x1b[H\x1b[J',
};

/**
 * Thresholds match the design spec's terminal display section: green
 * below 60%, yellow up to 85%, red above — tuned for "glance and know if
 * something's wrong", not precise capacity planning.
 */
function colorForPercent(percent: number): string {
  if (percent > 85) return ANSI.red;
  if (percent >= 60) return ANSI.yellow;
  return ANSI.green;
}

/**
 * Renders a block-character progress bar for a 0-100 percent value.
 * Exported and pure (no I/O) so it's directly fixture-testable — see this
 * task's manual verification.
 */
export function renderBar(percent: number, useColor: boolean): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const label = `${clamped}%`.padStart(4);
  if (!useColor) return `[${bar}] ${label}`;
  return `${colorForPercent(clamped)}[${bar}]${ANSI.reset} ${label}`;
}

/**
 * Mutagen's own status text already says everything the Sync panel needs
 * (see sync.ts's getSessionStatusText comment on why this project doesn't
 * re-parse Mutagen's output into typed fields) — this extracts *only* a
 * staging percentage, when present, purely to drive the panel's progress
 * bar. A bare `\d+%` search is resilient to Mutagen output-format changes
 * across versions in a way a full parse wouldn't be; when no percentage
 * is present (e.g. "Watching for changes"), the caller falls back to
 * printing the raw status line with no bar.
 */
export function extractStagingPercent(statusText: string): number | null {
  const match = statusText.match(/(\d+)%/);
  return match ? parseInt(match[1], 10) : null;
}

interface DashboardInputs {
  remoteLabel: string;
  intervalSeconds: number;
  syncStatuses: { name: string; text: string }[];
  local: PerformanceSnapshot;
  remotePerf: PerformanceSnapshot | null;
  remoteStale: boolean;
  useColor: boolean;
}

function renderPerformanceSection(title: string, snap: PerformanceSnapshot, useColor: boolean): string[] {
  return [
    title,
    `  CPU load : ${snap.cpuLoad.toFixed(2)}  (${snap.cpuCores} cores)`,
    `  RAM      : ${renderBar(snap.ramUsedPercent, useColor)}`,
    `  Disk (/) : ${renderBar(snap.diskUsedPercent, useColor)}`,
  ];
}

/**
 * Pure string builder — no I/O, no timers — so it's directly testable
 * with fixture inputs regardless of what machine/OS this runs on (see
 * this task's manual verification). Kept separate from the poll loop
 * (runMonitor) below so rendering logic can be exercised in isolation
 * from real SSH/Mutagen calls.
 *
 * Uses a stacked layout (Mac section, then Remote section) rather than
 * the design spec mockup's side-by-side columns — see this plan's Global
 * Constraints for why.
 */
export function renderDashboard(inputs: DashboardInputs): string {
  const time = new Date().toLocaleTimeString();
  const lines: string[] = [];

  lines.push(
    `claude-remote monitor — refresh every ${inputs.intervalSeconds}s (Ctrl+C stops watching, sync keeps running)   ${time}`
  );
  lines.push('');
  lines.push('Sync');
  for (const session of inputs.syncStatuses) {
    const percent = extractStagingPercent(session.text);
    const firstLine = session.text.split('\n').find((l) => l.trim().length > 0) ?? session.text;
    const suffix = percent !== null ? `  ${renderBar(percent, inputs.useColor)}` : '';
    lines.push(`  ${session.name}`);
    lines.push(`    ${firstLine.trim()}${suffix}`);
  }
  lines.push('');
  lines.push(...renderPerformanceSection('Performance — Mac (local)', inputs.local, inputs.useColor));
  lines.push('');

  if (inputs.remotePerf) {
    lines.push(...renderPerformanceSection(`Performance — ${inputs.remoteLabel}`, inputs.remotePerf, inputs.useColor));
    if (inputs.remoteStale) {
      lines.push(`  ${ANSI.dim}(stale — most recent fetch failed, showing last-known values)${ANSI.reset}`);
    }
  } else {
    lines.push(`Performance — ${inputs.remoteLabel}`);
    lines.push('  (no data yet)');
  }

  return lines.join('\n');
}

/**
 * Polls at `ms` resolution but checks `isStopped()` every 100ms instead
 * of sleeping the full duration in one shot, so Ctrl+C (which sets the
 * stopped flag via runMonitor's SIGINT handler) is noticed within ~100ms
 * instead of waiting out the rest of a multi-second interval. The 100ms
 * poll itself is a bare setTimeout — negligible cost, not a busy loop.
 */
function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (isStopped() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Runs the combined sync+performance dashboard until Ctrl+C. Replaces the
 * old sync.ts `monitorSessions` (which just handed the terminal to
 * `mutagen sync monitor --long`) — see the design spec's "Why not keep
 * Mutagen's own live UI" for why this project now owns the poll loop and
 * rendering instead of delegating to Mutagen's.
 */
export async function runMonitor(
  config: Config,
  sessionNames: string[],
  opts: { intervalSeconds: number }
): Promise<number> {
  const useColor = process.stdout.isTTY === true;
  const remoteLabel = `Remote (${config.remote.user}@${config.remote.host})`;

  let controlSocketPath: string;
  try {
    controlSocketPath = await startControlMaster(config.remote);
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    return 1;
  }

  let stopped = false;
  const onSigint = () => {
    stopped = true;
  };
  process.on('SIGINT', onSigint);

  let lastRemotePerf: PerformanceSnapshot | null = null;

  try {
    while (!stopped) {
      const syncStatuses = await Promise.all(
        sessionNames.map(async (name) => ({ name, text: await getSessionStatusText(name) }))
      );

      const local = await getLocalPerformanceSnapshot();

      let remoteStale = false;
      try {
        lastRemotePerf = await getRemotePerformanceSnapshot(config.remote, controlSocketPath);
      } catch {
        // A single cycle's remote fetch failing (transient disconnect,
        // dead socket) doesn't crash the dashboard — see the design
        // spec's "Error handling" section. The panel keeps showing its
        // last-known values with a stale marker until a later cycle
        // succeeds again.
        remoteStale = true;
      }

      process.stdout.write(
        ANSI.redraw +
          renderDashboard({
            remoteLabel,
            intervalSeconds: opts.intervalSeconds,
            syncStatuses,
            local,
            remotePerf: lastRemotePerf,
            remoteStale,
            useColor,
          }) +
          '\n'
      );

      await sleepUnlessStopped(opts.intervalSeconds * 1000, () => stopped);
    }
  } finally {
    process.off('SIGINT', onSigint);
    await stopControlMaster(config.remote, controlSocketPath);
  }

  return 0;
}
```

- [ ] **Step 2: Manual verification — pure rendering functions against fixture inputs (no SSH/Mutagen needed)**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { renderBar, extractStagingPercent, renderDashboard } from './src/monitor.js';

console.log(renderBar(62, false));
console.log(renderBar(90, false));
console.log('staging %:', extractStagingPercent('Status: Staging files\nStaging progress: 46%'));
console.log('watching %:', extractStagingPercent('Status: Watching for changes'));

console.log(renderDashboard({
  remoteLabel: 'Remote (cookie@192.168.1.11)',
  intervalSeconds: 3,
  syncStatuses: [
    { name: 'claude-remote-claude-home', text: 'Status: Watching for changes' },
    { name: 'claude-remote-workspace-x', text: 'Status: Staging files\nStaging progress: 46%' },
  ],
  local: { cpuLoad: 2.1, cpuCores: 4, ramUsedPercent: 62, diskUsedPercent: 58 },
  remotePerf: { cpuLoad: 0.8, cpuCores: 8, ramUsedPercent: 31, diskUsedPercent: 41 },
  remoteStale: false,
  useColor: false,
}));
"
```

Expected output: `renderBar(62, false)` → `[██████░░░░]  62%`; `renderBar(90, false)` → `[█████████░]  90%`; `staging %: 46`; `watching %: null`; then a full multi-line dashboard with a `Sync` section (both sessions, the staging one showing a bar), a `Performance — Mac (local)` section, and a `Performance — Remote (cookie@192.168.1.11)` section — confirm all three sections are present and no line throws/`undefined`s.

---

### Task 4: Wire `monitor` into the CLI, remove the old implementation

**Files:**
- Modify: `src/sync.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `runMonitor` (`src/monitor.ts`, Task 3).
- Removes: `monitorSessions` (`src/sync.ts`) — no longer used anywhere after this task.

- [ ] **Step 1: Remove `monitorSessions` from `src/sync.ts`**

Change the top import line from:
```ts
import { execFile, spawn } from 'node:child_process';
```
to:
```ts
import { execFile } from 'node:child_process';
```
(`spawn` was only ever used by `monitorSessions`, removed next — leaving the unused import would fail `tsc`'s `noUnusedLocals`-style checks under `strict`.)

Delete the entire `monitorSessions` function and its doc comment (the block starting `/**\n * Streams live-updating progress...` and ending at the function's closing `}`) from the end of `src/sync.ts`. Nothing else in the file changes — `sessionExists`, `createSession`, `ensureSession`, `terminateSession`, `getSessionStatusText` stay exactly as they are.

- [ ] **Step 2: Update `src/cli.ts`'s `monitor` command**

Change the import line:
```ts
import { getSessionStatusText, monitorSessions } from './sync.js';
```
to:
```ts
import { getSessionStatusText } from './sync.js';
```

Add a new import for `runMonitor`:
```ts
import { runMonitor } from './monitor.js';
```

Replace the existing `monitor` command block:
```ts
  program
    .command('monitor')
    .description('Live-stream sync progress for both sessions (Ctrl+C stops watching, not the sync itself)')
    .action(async () => {
      const config = loadConfig(program.opts().config);
      const code = await monitorSessions(activeSessionNames(config));
      process.exitCode = code;
    });
```
with:
```ts
  program
    .command('monitor')
    .description(
      'Live-stream sync status and CPU/RAM/disk performance for both machines (Ctrl+C stops watching, not the sync itself)'
    )
    .option('--interval <seconds>', 'refresh interval in seconds', '3')
    .action(async (cmdOpts) => {
      const config = loadConfig(program.opts().config);
      const intervalSeconds = parseInt(cmdOpts.interval, 10);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        throw new Error(`--interval must be a positive number of seconds, got: ${cmdOpts.interval}`);
      }
      const code = await runMonitor(config, activeSessionNames(config), { intervalSeconds });
      process.exitCode = code;
    });
```

- [ ] **Step 3: Manual verification — pure local build + CLI wiring, no network/remote involved**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npm run build
node dist/bin/claude-remote.js monitor --help
```
Expected output: commander's generated help for the `monitor` subcommand, showing the new `--interval <seconds>` option with default `3` and the updated description mentioning both sync status and performance.

Run:
```bash
node dist/bin/claude-remote.js monitor --interval 0 --config ./config.example.yaml
```
Expected output: `Error: --interval must be a positive number of seconds, got: 0` (confirms the validation runs before any SSH/Mutagen call is attempted).

---

### Task 5: README updates

**Files:**
- Modify: `README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update the `monitor` bullet in the Command reference section**

Replace:
```markdown
- `claude-remote monitor` — live-stream sync progress for both sessions
  (wraps `mutagen sync monitor --long`). `Ctrl+C` stops watching, not the
  sync itself — it keeps running in Mutagen's background daemon either way.
```
with:
```markdown
- `claude-remote monitor [--interval <seconds>]` — live-stream a combined
  dashboard: both sessions' Mutagen sync status plus CPU/RAM/disk
  performance for the Mac and the remote, refreshed every `--interval`
  seconds (default `3`). `Ctrl+C` stops watching, not the sync itself — it
  keeps running in Mutagen's background daemon either way. Performance
  numbers come from a handful of cheap one-shot reads
  (`/proc/loadavg`/`free`/`df` on the remote, `uptime`/`vm_stat`/`df` on
  the Mac) bundled into a single SSH call per cycle over a reused
  multiplexed connection — not a continuous sampler — so watching the
  dashboard doesn't itself become a meaningful load on either machine. See
  `docs/superpowers/specs/2026-07-14-monitor-performance-dashboard-design.md`
  for the full design.
```

- [ ] **Step 2: Add new items to the Manual end-to-end verification checklist**

Add these items to the existing checklist (after the last `claude-remote status` item):
```markdown
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
```

- [ ] **Step 3: Manual verification — read-through, no command to run**

Confirm the updated `monitor` bullet's `--interval` flag and default (`3`) match `src/cli.ts` from Task 4, and that the design spec path referenced actually exists (`docs/superpowers/specs/2026-07-14-monitor-performance-dashboard-design.md`, written earlier this session).

---

## Note on committing

Per this plan's Global Constraints, no task above includes a `git commit` step. Once all five tasks are verified, the working tree will have uncommitted changes in `src/ssh.ts`, `src/performance.ts` (new), `src/monitor.ts` (new), `src/sync.ts`, `src/cli.ts`, and `README.md`. The user will commit these themselves once git identity is configured on this machine.
