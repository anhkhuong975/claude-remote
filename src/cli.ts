import { Command } from 'commander';
import { join } from 'node:path';
import {
  loadConfig,
  DEFAULT_CONFIG_PATH,
  resolveWorkspaceLocal,
  resolveWorkspaceRemote,
  type Config,
} from './config.js';
import { runSetup, CLAUDE_HOME_SESSION_NAME } from './setup.js';
import { runLaunch, sessionNameForWorkspace } from './launch.js';
import { checkConnectivity } from './ssh.js';
import { getSessionStatusText, monitorSessions } from './sync.js';

/**
 * Factored out from bin/claude-remote.ts so the CLI's wiring can be
 * exercised without going through a real process invocation — not used
 * by an automated test today (this project has none, see Global
 * Constraints), but keeps the entrypoint file itself a one-liner that
 * only handles process-level concerns (argv, exit code).
 */
/**
 * Shared by `status` and `monitor` so both always watch the exact same
 * two sessions (the persistent claude-home one plus whichever workspace
 * session corresponds to the currently-active workspace) — a single
 * source of truth instead of two copies that could drift apart.
 */
function activeSessionNames(config: Config): string[] {
  const workspaceLocal = resolveWorkspaceLocal(config);
  return [CLAUDE_HOME_SESSION_NAME, sessionNameForWorkspace(workspaceLocal)];
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name('claude-remote')
    .description('Run Claude Code on a trusted remote machine, kept in sync with the Mac via Mutagen.')
    .option('--config <path>', 'path to config.yaml', DEFAULT_CONFIG_PATH);

  program
    .command('setup')
    .description('One-time: verify SSH access, install remote dependencies, start the ~/.claude sync session')
    .action(async () => {
      const config = loadConfig(program.opts().config);
      await runSetup(config);
    });

  program
    .command('launch')
    .description('Sync the active workspace and drop into a live Claude Code session on the remote')
    .option('-y, --yes', 'skip the concurrent-session confirmation prompt', false)
    .action(async (cmdOpts) => {
      const config = loadConfig(program.opts().config);
      const code = await runLaunch(config, { skipConfirm: cmdOpts.yes });
      process.exitCode = code;
    });

  program
    .command('status')
    .description("Show SSH connectivity and both sync sessions' state")
    .action(async () => {
      const config = loadConfig(program.opts().config);

      console.log(`Remote: ${config.remote.user}@${config.remote.host}`);
      try {
        await checkConnectivity(config.remote);
        console.log('  SSH: reachable');
      } catch (err) {
        console.log(`  SSH: unreachable\n  ${(err as Error).message}`);
      }

      // Checks both sync sessions: the persistent claude-home one from
      // setup, and whichever workspace session corresponds to the
      // currently-active workspace (env override or config default) —
      // there may be other, older workspace sessions from previously
      // used projects that this deliberately doesn't enumerate (v1 has
      // no session-listing/cleanup command; see spec's YAGNI framing).
      for (const name of activeSessionNames(config)) {
        console.log(`\n${name}:`);
        try {
          console.log(await getSessionStatusText(name));
        } catch (err) {
          console.log(`  ${(err as Error).message}`);
        }
      }
    });

  program
    .command('monitor')
    .description('Live-stream sync progress for both sessions (Ctrl+C stops watching, not the sync itself)')
    .action(async () => {
      const config = loadConfig(program.opts().config);
      const code = await monitorSessions(activeSessionNames(config));
      process.exitCode = code;
    });

  program
    .command('config')
    .description('Print the resolved config (after CLAUDE_REMOTE_WORKSPACE override) as JSON')
    .action(() => {
      const config = loadConfig(program.opts().config);
      const workspaceLocal = resolveWorkspaceLocal(config);
      console.log(
        JSON.stringify(
          {
            config,
            resolvedWorkspaceLocal: workspaceLocal,
            resolvedWorkspaceRemote: resolveWorkspaceRemote(workspaceLocal),
            resolvedClaudeConfigDirRemote: join(config.remote.homeMirrorPath, '.claude'),
          },
          null,
          2
        )
      );
    });

  return program;
}
