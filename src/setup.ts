import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkConnectivity, runRemoteCommand, shellQuote } from './ssh.js';
import { ensureSession } from './sync.js';
import { resolveWorkspaceLocal, resolveWorkspaceRemote, type Config } from './config.js';

/**
 * Exported (not just a local const) so cli.ts's `status` command checks
 * the exact same session claude-home was created under, instead of a
 * second hardcoded copy of this string that could drift out of sync.
 */
export const CLAUDE_HOME_SESSION_NAME = 'claude-remote-claude-home';

/**
 * Prints each remote command before running it. Unlike launch.ts (which
 * hands off to a real interactive terminal once it starts), setup only
 * runs once per machine and does the least-tested, most
 * environment-dependent work in this whole tool — detecting a Linux
 * distro's package manager, installing system packages over SSH. If it
 * fails on someone's real remote machine, a step-by-step transcript of
 * exactly what ran is the difference between "grep the output" and
 * "reproduce it by hand over SSH."
 */
function logStep(description: string): void {
  console.log(`\n→ ${description}`);
}

async function detectRemoteOs(config: Config): Promise<void> {
  logStep('Detecting remote OS');
  const result = await runRemoteCommand(config.remote, 'uname -a');
  const isWsl = /microsoft/i.test(result.stdout);

  if (config.remote.os === 'windows-wsl2' && !isWsl) {
    throw new Error(
      `config.yaml declares remote.os: windows-wsl2, but 'uname -a' on ${config.remote.host} ` +
        `doesn't look like WSL2 (got: ${result.stdout.trim()}). ` +
        `If this is a fresh Windows machine, install WSL2 first: https://learn.microsoft.com/windows/wsl/install`
    );
  }
  if (config.remote.os === 'linux' && isWsl) {
    console.warn(
      `Note: ${config.remote.host} looks like WSL2, but config.yaml declares remote.os: linux. ` +
        `This still works (WSL2 is a real Linux userspace) — just double check that's intentional.`
    );
  }
  console.log(`  OK: ${result.stdout.trim()}`);
}

/**
 * Checks for a single dependency via `command -v` and installs it with
 * apt if missing. apt-only is a deliberate scope limit (spec's "OS
 * support" decision) — WSL2's default distro is Ubuntu, and supporting a
 * hand-picked non-Ubuntu WSL distro is out of scope for v1.
 */
async function ensureAptPackage(config: Config, binaryName: string, aptPackageName: string): Promise<void> {
  logStep(`Checking for ${binaryName}`);
  const check = await runRemoteCommand(config.remote, `command -v ${binaryName}`);
  if (check.code === 0) {
    console.log(`  OK: already installed (${check.stdout.trim()})`);
    return;
  }

  logStep(`Installing ${aptPackageName} (sudo apt-get update && sudo apt-get install -y ${aptPackageName})`);
  const install = await runRemoteCommand(
    config.remote,
    `sudo apt-get update && sudo apt-get install -y ${aptPackageName}`
  );
  if (install.code !== 0) {
    throw new Error(
      `Failed to install ${aptPackageName} on ${config.remote.host}:\n${install.stderr.trim()}\n` +
        `You may need to run this manually over SSH and re-run setup.`
    );
  }
  console.log(`  OK: installed ${aptPackageName}`);
}

async function ensureClaudeCodeCli(config: Config): Promise<void> {
  logStep('Checking for the Claude Code CLI');
  const check = await runRemoteCommand(config.remote, 'command -v claude');
  if (check.code === 0) {
    console.log(`  OK: already installed (${check.stdout.trim()})`);
    return;
  }

  logStep('Installing Claude Code CLI (npm install -g @anthropic-ai/claude-code)');
  const install = await runRemoteCommand(config.remote, 'npm install -g @anthropic-ai/claude-code');
  if (install.code !== 0) {
    throw new Error(`Failed to install Claude Code CLI on ${config.remote.host}:\n${install.stderr.trim()}`);
  }
  console.log('  OK: installed');
}

/**
 * Creates the directory structure on the remote that the
 * identical-absolute-path trick depends on: homeMirrorPath/.claude (the
 * claude-home sync target) and the workspace's parent directory (so the
 * workspace sync session has somewhere to write into). Both are plain
 * `mkdir -p`, which creates every missing intermediate directory in one
 * call — idempotent by construction, safe to re-run.
 */
async function ensureRemoteDirectories(config: Config, workspaceLocal: string): Promise<void> {
  const claudeHomeRemote = join(config.remote.homeMirrorPath, '.claude');
  const workspaceRemote = resolveWorkspaceRemote(workspaceLocal);
  const workspaceParentRemote = join(workspaceRemote, '..');

  logStep(`Creating remote directories: ${claudeHomeRemote}, ${workspaceParentRemote}`);
  // Quoted with shellQuote (not raw-interpolated) because these paths
  // come from user-editable config (homeMirrorPath, workspace.local) and
  // may contain spaces — an unquoted path like `/Users/pak/My Projects`
  // would make `mkdir -p` create two separate directories instead of one
  // path with a space, and the later Mutagen sync would then target a
  // directory that was never actually created.
  const result = await runRemoteCommand(
    config.remote,
    `mkdir -p ${shellQuote(claudeHomeRemote)} ${shellQuote(workspaceParentRemote)}`
  );
  if (result.code !== 0) {
    throw new Error(`Failed to create remote directories:\n${result.stderr.trim()}`);
  }
  console.log('  OK');
}

/**
 * The claude-home sync session is created once, here, and left running
 * permanently in the background — unlike the workspace session (owned
 * by launch.ts), it is never retargeted or torn down as part of normal
 * use, since it's tied to the Mac's own ~/.claude rather than to
 * whichever project is currently active.
 */
async function ensureClaudeHomeSync(config: Config): Promise<void> {
  logStep('Creating claude-home sync session (~/.claude <-> remote mirror)');
  await ensureSession({
    name: CLAUDE_HOME_SESSION_NAME,
    alpha: join(homedir(), '.claude'),
    beta: `${config.remote.user}@${config.remote.host}:${join(config.remote.homeMirrorPath, '.claude')}`,
    ignore: [],
  });
  console.log('  OK');
}

export async function runSetup(config: Config): Promise<void> {
  logStep(`Checking SSH connectivity to ${config.remote.host}`);
  await checkConnectivity(config.remote);
  console.log('  OK');

  await detectRemoteOs(config);
  await ensureAptPackage(config, 'tmux', 'tmux');
  // Debian/Ubuntu's own `nodejs` apt package is often several major
  // versions behind current — if that turns out to be too old for the
  // Claude Code CLI's own requirements, switch this to NodeSource's
  // setup script or nvm instead of plain apt. Not preemptively solved
  // here (YAGNI): it depends on exactly which Ubuntu release apt
  // resolves to on whatever WSL2/Linux install this targets.
  await ensureAptPackage(config, 'node', 'nodejs');
  await ensureClaudeCodeCli(config);

  const workspaceLocal = resolveWorkspaceLocal(config);
  await ensureRemoteDirectories(config, workspaceLocal);
  await ensureClaudeHomeSync(config);

  console.log('\nSetup complete.');
}
