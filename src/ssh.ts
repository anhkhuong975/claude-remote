import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
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
 * Prefixes a remote command with nvm's shell-sourcing preamble.
 * Confirmed empirically against a real remote (2026-07-14): nvm's own
 * installer only wires its PATH setup into ~/.bashrc, which a
 * non-interactive SSH command (`ssh host "some command"`) never sources
 * — without this prefix, `node`/`npm`/`claude` silently resolve to
 * whatever (older, or nonexistent) version apt installed system-wide
 * instead of failing loudly, which is a much worse failure mode than an
 * explicit "not found". Every remote command that needs node/npm/claude
 * must go through this, not just the nvm-install step itself — see
 * setup.ts's `ensureNodeViaNvm` for why nvm is used instead of apt's own
 * `nodejs` package in the first place.
 *
 * `[ -s "$NVM_DIR/nvm.sh" ] &&` guards against nvm not being installed
 * yet, so a command wrapped in this before setup has run fails with a
 * normal "command not found" instead of an unrelated sourcing error.
 */
export function withNvmInit(command: string): string {
  return `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ${command}`;
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
    ? withNvmInit(`${exportsAndCd} && claude ${opts.claudeArgs.map(shellQuote).join(' ')}`)
    : `${exportsAndCd} && exec $SHELL`;

  const tmuxCommand = `tmux new-session -A -s ${shellQuote(opts.tmuxSessionName)} ${shellQuote(innerCommand)}`;

  return ['-t', ...buildSshBaseArgs(remote), tmuxCommand];
}

/**
 * Where a session's SSH multiplexing control socket lives while a
 * ControlMaster connection from this process is open. Keyed by both
 * remote.host and process.pid so two claude-remote processes targeting
 * the same remote at once (e.g. `launch` running in one terminal,
 * `monitor` in another) never collide on the same socket file.
 *
 * Built under `/tmp` directly rather than `os.tmpdir()` — on macOS,
 * tmpdir() often resolves to a long per-process path like
 * `/var/folders/ab/cdefghijklmnop/T/`, and AF_UNIX socket paths have a
 * platform limit around 104 bytes; a long tmpdir prefix plus this file's
 * own name can exceed that and make startControlMaster fail outright.
 * `/tmp` is fixed and short, which is why many other SSH multiplexing
 * setups (and OpenSSH's own docs) use it explicitly instead of relying on
 * the OS temp dir default.
 */
function controlSocketPath(remote: Config['remote']): string {
  return join('/tmp', `claude-remote-ssh-${remote.host}-${process.pid}.sock`);
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
    child.on('error', async (err) => {
      console.warn(`Warning: failed to close SSH control master: ${err.message}`);
      await unlinkSocketFile(socketPath);
      resolvePromise();
    });
    child.on('close', async (code) => {
      if (code !== 0) {
        console.warn(`Warning: SSH control master exit reported non-zero (${code}): ${stderr.trim()}`);
      }
      // `-O exit` above tells the master to shut down cleanly, but if it
      // died abnormally earlier (crash, killed process — the reason
      // this cleanup path is being hit at all in some cases) it can leave
      // the socket file behind on disk. Best-effort delete it regardless
      // of whether the exit command itself succeeded, same "never throws"
      // contract as the rest of this function.
      await unlinkSocketFile(socketPath);
      resolvePromise();
    });
  });
}

/**
 * Deletes a leftover control-socket file without ever throwing — a
 * missing file (ENOENT, i.e. it's already gone, the common case when
 * `-O exit` succeeded cleanly) is expected and silently ignored; any
 * other error (permissions, etc.) is a non-fatal warning, consistent with
 * stopControlMaster's own "never throws" contract.
 */
async function unlinkSocketFile(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Warning: failed to remove leftover SSH control socket file: ${(err as Error).message}`);
    }
  }
}
