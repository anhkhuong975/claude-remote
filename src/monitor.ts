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
 * `mutagen sync list --long` puts the actual session status on a line
 * starting with `Status:`, near the END of the block (after Session/
 * Identifier/Labels/Alpha/Beta headers) — not the first non-empty line,
 * which is always the `Session: sync_XXXX` header. Falls back to the LAST
 * non-empty line (not the first) if no `Status:` line is found, since an
 * unrecognized future Mutagen format is still more likely to put summary
 * info near the end than in the header, and this must never throw on
 * unexpected output.
 */
export function extractStatusLine(statusText: string): string {
  const lines = statusText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const statusLine = lines.find((l) => l.startsWith('Status:'));
  if (statusLine) return statusLine;
  return lines[lines.length - 1] ?? statusText;
}

/**
 * Mutagen's own status text already says everything the Sync panel needs
 * (see sync.ts's getSessionStatusText comment on why this project doesn't
 * re-parse Mutagen's output into typed fields) — this extracts *only* a
 * staging percentage, when present, purely to drive the panel's progress
 * bar. Restricted to a line containing `Staging progress` (rather than a
 * bare `\d+%` search across the whole block) so it can't accidentally
 * match an unrelated percent-looking field elsewhere in the block in a
 * future Mutagen version; when no such line is present (e.g. "Watching
 * for changes"), the caller falls back to printing the raw status line
 * with no bar.
 */
export function extractStagingPercent(statusText: string): number | null {
  const progressLine = statusText.split('\n').find((l) => l.includes('Staging progress'));
  if (!progressLine) return null;
  const match = progressLine.match(/(\d+)%/);
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
    const statusLine = extractStatusLine(session.text);
    const suffix = percent !== null ? `  ${renderBar(percent, inputs.useColor)}` : '';
    lines.push(`  ${session.name}`);
    lines.push(`    ${statusLine}${suffix}`);
  }
  lines.push('');
  lines.push(...renderPerformanceSection('Performance — Mac (local)', inputs.local, inputs.useColor));
  lines.push('');

  if (inputs.remotePerf) {
    lines.push(...renderPerformanceSection(`Performance — ${inputs.remoteLabel}`, inputs.remotePerf, inputs.useColor));
    if (inputs.remoteStale) {
      // Gated on useColor like renderBar above — a piped/redirected run
      // (`claude-remote monitor > log.txt`) must never accumulate raw
      // ANSI escape bytes in a non-terminal output stream.
      const staleText = '(stale — most recent fetch failed, showing last-known values)';
      lines.push(inputs.useColor ? `  ${ANSI.dim}${staleText}${ANSI.reset}` : `  ${staleText}`);
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

      // Same isTTY check as useColor above: the clear-screen escape only
      // makes sense on a real terminal — piping/redirecting output
      // (`claude-remote monitor > log.txt`) must not accumulate raw
      // escape codes in the file.
      const redrawPrefix = process.stdout.isTTY === true ? ANSI.redraw : '';
      process.stdout.write(
        redrawPrefix +
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
