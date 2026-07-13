import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { checkConnectivity, buildInteractiveLaunchArgs } from './ssh.js';
import { ensureSession } from './sync.js';
import { resolveWorkspaceLocal, resolveWorkspaceRemote, type Config } from './config.js';

const WORKSPACE_SESSION_PREFIX = 'claude-remote-workspace-';

/**
 * Mutagen session names must be stable and filesystem-path-safe; derives
 * one deterministically from the workspace path so switching back to a
 * previously-used workspace reuses (rather than duplicates) its sync
 * session. Not a cryptographic hash — collisions are acceptable here
 * (this is a friendly local identifier, not a security boundary), so a
 * short, readable transform is preferred over pulling in a hash library
 * for a handful of characters of uniqueness we don't actually need.
 */
export function sessionNameForWorkspace(workspaceLocal: string): string {
  const safe = workspaceLocal.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${WORKSPACE_SESSION_PREFIX}${safe}`;
}

/**
 * Both `~/.claude` (synced continuously by the claude-home session since
 * setup) and the workspace get edited by whichever side is actively
 * running Claude Code. Mutagen's sync latency (seconds, not the
 * near-instant consistency of claude-docker's live bind mount) means
 * running Claude Code on both sides at once risks losing edits under the
 * "remote wins" conflict default — most sharply on singleton files
 * Claude Code rewrites constantly (~/.claude.json, MEMORY.md), which
 * don't merge on conflict, they just get clobbered by whichever side
 * "wins". claude-docker gets away with sharing ~/.claude only because
 * it's a live bind mount (zero latency) *and* the user never runs both
 * sides at once anyway — this confirmation is the only guard against
 * that assumption breaking here. Skippable with --yes for scripting, but
 * on by default since silently losing the Mac-side session/memory state
 * is a bad failure mode to hit by accident.
 */
async function confirmNoConcurrentClaudeSession(skip: boolean): Promise<void> {
  if (skip) return;

  console.log(
    '\n⚠ Before continuing: make sure no Claude Code session is currently running against\n' +
      '  ~/.claude on this Mac. ~/.claude syncs continuously to the remote — running Claude\n' +
      "  Code on both sides at once can clobber the Mac's session/memory state (the remote\n" +
      '  side wins on conflict). Pass --yes to skip this prompt.\n'
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Continue? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    throw new Error('Aborted.');
  }
}

export async function runLaunch(config: Config, opts: { skipConfirm: boolean }): Promise<number> {
  await checkConnectivity(config.remote);

  const workspaceLocal = resolveWorkspaceLocal(config);
  const workspaceRemote = resolveWorkspaceRemote(workspaceLocal);
  const claudeConfigDirRemote = join(config.remote.homeMirrorPath, '.claude');

  console.log(`Workspace: ${workspaceLocal}`);
  console.log(`Remote:    ${config.remote.user}@${config.remote.host}:${workspaceRemote}`);

  // Note: unlike setup.ts's `ensureRemoteDirectories`, launch never
  // explicitly creates `workspaceRemote`'s parent directory before
  // pointing Mutagen at it. That's fine for `config.workspace.local`
  // (setup already created it), but if CLAUDE_REMOTE_WORKSPACE points at
  // a local directory that's never been synced before, nothing here
  // ensures its remote parent exists first. Mutagen is expected to
  // create the sync root itself on first sync, so this asymmetry likely
  // isn't a functional break — but it's unverified (no live Mutagen
  // available during implementation) and worth confirming on a real run.
  await ensureSession({
    name: sessionNameForWorkspace(workspaceLocal),
    alpha: workspaceLocal,
    beta: `${config.remote.user}@${config.remote.host}:${workspaceRemote}`,
    ignore: config.sync.ignore,
  });

  await confirmNoConcurrentClaudeSession(opts.skipConfirm);

  const args = buildInteractiveLaunchArgs(config.remote, {
    workspaceRemotePath: workspaceRemote,
    claudeConfigDir: claudeConfigDirRemote,
    tmuxSessionName: config.tmux.sessionName,
    autoStartClaude: config.launch.autoStartClaude,
    claudeArgs: config.launch.claudeArgs,
  });

  // stdio: 'inherit' hands the real terminal to ssh/tmux/claude directly
  // — this needs to be a genuine interactive session (tmux, then Claude
  // Code's own REPL), not something this process reads/writes through
  // line by line.
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
