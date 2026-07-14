import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkConnectivity, runRemoteCommand, shellQuote, withNvmInit } from './ssh.js';
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

/**
 * Minimum Node.js major version the Claude Code CLI's own package.json
 * requires (`engines.node`). Checked explicitly rather than just trying
 * the npm install and hoping — see `ensureNodeViaNvm`'s comment for why
 * apt's own nodejs package can't be trusted to satisfy this.
 */
const REQUIRED_NODE_MAJOR = 22;

/**
 * Ensures a Node.js >= REQUIRED_NODE_MAJOR is available on the remote via
 * nvm, not apt. Originally this called `ensureAptPackage(config, 'node',
 * 'nodejs')`; changed after a real run against a live remote (2026-07-14)
 * hit two failures at once from that approach: Ubuntu/WSL2's `nodejs` apt
 * package installed v18 (several majors behind the Claude Code CLI's
 * `engines.node >= 22.0.0`), and separately, apt's nodejs installs into a
 * root-owned /usr/local/lib/node_modules, so `npm install -g` as a
 * non-root remote user failed with EACCES on top of the version mismatch.
 * nvm fixes both at once: `nvm install <major>` always gets a current
 * release regardless of the distro's own package repo, and it installs
 * entirely under the user's home directory (~/.nvm), so global npm
 * installs afterward need no sudo at all.
 *
 * Every remote command after this point that needs node/npm/claude must
 * be wrapped in `withNvmInit` (ssh.ts) — a plain non-interactive SSH
 * command does not pick up nvm's PATH setup on its own (confirmed
 * empirically; see withNvmInit's own comment for why).
 */
async function ensureNodeViaNvm(config: Config): Promise<void> {
  logStep(`Checking for Node.js >= ${REQUIRED_NODE_MAJOR} (via nvm)`);
  const check = await runRemoteCommand(config.remote, withNvmInit('node --version'));
  const currentMajor = check.code === 0 ? parseInt(check.stdout.trim().replace(/^v/, ''), 10) : 0;
  if (currentMajor >= REQUIRED_NODE_MAJOR) {
    console.log(`  OK: already installed (${check.stdout.trim()})`);
    return;
  }

  logStep('Installing nvm (curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash)');
  // curl is assumed present on any reasonably current Ubuntu/WSL2 image;
  // installed via the same scoped apt sudoers rule as tmux/nodejs if it
  // isn't, rather than adding a third install path to reason about.
  const installNvm = await runRemoteCommand(
    config.remote,
    'command -v curl >/dev/null || (sudo apt-get update && sudo apt-get install -y curl); ' +
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
  );
  if (installNvm.code !== 0) {
    throw new Error(`Failed to install nvm on ${config.remote.host}:\n${installNvm.stderr.trim()}`);
  }

  logStep(`Installing Node.js ${REQUIRED_NODE_MAJOR} via nvm`);
  const installNode = await runRemoteCommand(
    config.remote,
    withNvmInit(`nvm install ${REQUIRED_NODE_MAJOR}`)
  );
  if (installNode.code !== 0) {
    throw new Error(`Failed to install Node.js via nvm on ${config.remote.host}:\n${installNode.stderr.trim()}`);
  }
  console.log(`  OK: installed via nvm (${installNode.stdout.trim().split('\n').pop()})`);
}

async function ensureClaudeCodeCli(config: Config): Promise<void> {
  logStep('Checking for the Claude Code CLI');
  const check = await runRemoteCommand(config.remote, withNvmInit('command -v claude'));
  if (check.code === 0 && check.stdout.trim()) {
    console.log(`  OK: already installed (${check.stdout.trim()})`);
    return;
  }

  logStep('Installing Claude Code CLI (npm install -g @anthropic-ai/claude-code)');
  const install = await runRemoteCommand(config.remote, withNvmInit('npm install -g @anthropic-ai/claude-code'));
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
/**
 * Returns the first path segment under the filesystem root, e.g.
 * "/Users/pak/Projects" -> "/Users". homeMirrorPath is meant to mirror
 * the Mac's own home directory (always /Users/<user> on macOS) onto a
 * remote that's usually Linux/WSL2, where "/Users" doesn't exist and
 * can't be created by a regular user — creating anything directly under
 * "/" requires root. Isolating just this one segment lets the one-time
 * root-requiring bootstrap stay minimal: create+chown "/Users" once,
 * then everything nested under it is normal user-owned directory
 * creation, no further sudo needed.
 */
function topLevelSegment(absolutePath: string): string {
  const firstSegment = absolutePath.split('/').filter(Boolean)[0];
  return `/${firstSegment}`;
}

/**
 * Bootstraps ownership of homeMirrorPath's top-level segment (e.g.
 * "/Users") so the current remote user can create everything under it
 * without further sudo. Discovered necessary against a real remote
 * (2026-07-14): a plain `mkdir -p /Users/pak/.claude` as a non-root user
 * fails with "mkdir: cannot create directory '/Users': Permission
 * denied", since "/Users" is a macOS-specific top-level path that
 * doesn't pre-exist on Linux/WSL2 and creating anything directly under
 * "/" needs root. This only ever needs to run once per remote — after
 * the chown, this user owns the directory and every later `mkdir -p`
 * under it (here and in launch.ts's workspace retargeting) works as a
 * normal user, and re-running this is a harmless no-op since `mkdir -p`
 * and `chown` on an already-correct directory just succeed again.
 *
 * Requires passwordless sudo for `mkdir`/`chown` on the remote — same
 * pattern as the apt-get sudoers rule setup.ts already assumes for
 * package installs; see the thrown error's instructions if it's missing.
 */
async function ensureHomeMirrorTopLevelOwned(config: Config): Promise<void> {
  const topLevel = topLevelSegment(config.remote.homeMirrorPath);
  logStep(`Ensuring ${topLevel} exists and is owned by ${config.remote.user} (needs sudo once)`);
  const result = await runRemoteCommand(
    config.remote,
    `sudo mkdir -p ${shellQuote(topLevel)} && sudo chown ${config.remote.user}:${config.remote.user} ${shellQuote(topLevel)}`
  );
  if (result.code !== 0) {
    throw new Error(
      `Failed to create/chown ${topLevel} on ${config.remote.host}:\n${result.stderr.trim()}\n` +
        `This needs passwordless sudo for mkdir/chown on the remote. Add it there:\n` +
        `  echo "${config.remote.user} ALL=(root) NOPASSWD: /usr/bin/mkdir, /usr/bin/chown" | sudo tee /etc/sudoers.d/claude-remote-mkdir\n` +
        `  sudo chmod 0440 /etc/sudoers.d/claude-remote-mkdir\n` +
        `then re-run setup.`
    );
  }
  console.log(`  OK`);
}

async function ensureRemoteDirectories(config: Config, workspaceLocal: string): Promise<void> {
  await ensureHomeMirrorTopLevelOwned(config);

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
 *
 * alpha/beta are the *remote* and *local* paths respectively, not the
 * other way around — see createSession's docstring (sync.ts): Mutagen's
 * `two-way-resolved` mode always makes alpha win conflicts, with no flag
 * to reverse it, so "remote wins" (this project's documented safety
 * property) requires the remote to be alpha.
 */
async function ensureClaudeHomeSync(config: Config): Promise<void> {
  logStep('Creating claude-home sync session (~/.claude <-> remote mirror)');
  await ensureSession({
    name: CLAUDE_HOME_SESSION_NAME,
    alpha: `${config.remote.user}@${config.remote.host}:${join(config.remote.homeMirrorPath, '.claude')}`,
    beta: join(homedir(), '.claude'),
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
  await ensureNodeViaNvm(config);
  await ensureClaudeCodeCli(config);

  const workspaceLocal = resolveWorkspaceLocal(config);
  await ensureRemoteDirectories(config, workspaceLocal);
  await ensureClaudeHomeSync(config);

  console.log('\nSetup complete.');
}
