import { spawn } from 'node:child_process';
import type { Config } from './config.js';

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Base SSH args shared by every invocation. BatchMode=yes disables
 * interactive prompts (password, host-key-verification prompt) entirely
 * — if key auth isn't already working, we want a fast, clear failure
 * here rather than an ssh process silently hanging waiting for input
 * that will never come (this CLI runs non-interactively in places like
 * `launch`'s pre-flight checks, before it hands off to a real terminal).
 * ConnectTimeout=10 bounds how long a genuinely unreachable host takes
 * to fail, instead of hanging on the OS's own (much longer) TCP timeout.
 */
function buildSshBaseArgs(remote: Config['remote']): string[] {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (remote.sshKeyPath) {
    args.push('-i', remote.sshKeyPath);
  }
  args.push(`${remote.user}@${remote.host}`);
  return args;
}

/**
 * Runs a single command on the remote over SSH and captures its output.
 * Used by setup.ts for OS detection and dependency checks, where the
 * result is needed programmatically rather than streamed to the
 * terminal (contrast with launch.ts's interactive session, which uses
 * stdio: 'inherit' instead).
 */
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

/**
 * Verifies SSH connectivity before any setup/launch step proceeds.
 * Deliberately does not attempt to fix anything (no key generation, no
 * ssh-copy-id) — per the spec's "SSH key setup" decision, key access is
 * assumed to already exist; this only diagnoses and reports clearly.
 */
export async function checkConnectivity(remote: Config['remote']): Promise<void> {
  const displayArgs = [...buildSshBaseArgs(remote), 'echo', 'ok'];
  let result: SshResult;
  try {
    result = await runRemoteCommand(remote, 'echo ok');
  } catch (err) {
    throw new Error(
      `Failed to run: ssh ${displayArgs.join(' ')}\n` +
        `${(err as Error).message}\n` +
        `Check that ssh itself is on PATH.`
    );
  }

  if (result.code !== 0 || result.stdout.trim() !== 'ok') {
    throw new Error(
      `SSH connectivity check failed: ssh ${displayArgs.join(' ')}\n` +
        `exit code: ${result.code}\n` +
        `stderr: ${result.stderr.trim()}\n` +
        `Check that '${remote.host}' is reachable and that ~/.ssh/config / the configured ` +
        `sshKeyPath ('${remote.sshKeyPath ?? '(none, using default identity)'}') are correct.`
    );
  }
}

/**
 * Minimal POSIX shell single-quoting for the command string handed to
 * tmux/ssh below. The remote side always runs bash/tmux — Windows
 * targets are WSL2, a real Linux userspace — so this deliberately never
 * has to handle cmd.exe/PowerShell quoting rules (native Windows support
 * was explicitly rejected in the spec's "OS support" decision).
 *
 * Exported so setup.ts's `ensureRemoteDirectories` can reuse it for the
 * `mkdir -p` command it builds — any path-containing-a-space bug fixed
 * here should be fixed everywhere paths get interpolated into a remote
 * shell command, not just here.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the full ssh argv for launch.ts's interactive session: attach
 * to (or create) a named tmux session on the remote, cd into the
 * workspace, export CLAUDE_CONFIG_DIR so Claude Code reads/writes the
 * synced ~/.claude mirror instead of the remote's own real home (see the
 * spec's "identical-absolute-path trick"), then run claude with the
 * configured args.
 *
 * `-t` forces a pseudo-terminal, required for tmux to work at all over
 * SSH. `tmux new-session -A -s <name>` attaches to an existing session
 * with this name if one is already running (e.g. you detached earlier
 * with Ctrl-b d) instead of creating a duplicate — this is what makes a
 * long-running Claude Code session survive you closing your laptop lid
 * and reconnecting later.
 */
export function buildInteractiveLaunchArgs(
  remote: Config['remote'],
  opts: {
    workspaceRemotePath: string;
    claudeConfigDir: string;
    tmuxSessionName: string;
    autoStartClaude: boolean;
    claudeArgs: string[];
  }
): string[] {
  const exportsAndCd =
    `cd ${shellQuote(opts.workspaceRemotePath)} && ` +
    `export CLAUDE_CONFIG_DIR=${shellQuote(opts.claudeConfigDir)}`;

  const innerCommand = opts.autoStartClaude
    ? `${exportsAndCd} && claude ${opts.claudeArgs.map(shellQuote).join(' ')}`
    : `${exportsAndCd} && exec $SHELL`;

  const tmuxCommand = `tmux new-session -A -s ${shellQuote(opts.tmuxSessionName)} ${shellQuote(innerCommand)}`;

  return ['-t', ...buildSshBaseArgs(remote), tmuxCommand];
}
