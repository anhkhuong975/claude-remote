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
