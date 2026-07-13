import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Default location for the user's config.yaml. Deliberately NOT resolved
 * relative to process.cwd() — this CLI is meant to be run via `npm link`
 * from anywhere on the Mac (e.g. from inside whatever project directory
 * you're currently in), so a cwd-relative default would silently pick up
 * the wrong file (or none) depending on where you happened to run the
 * command from. ~/.config/<tool> is the standard convention for a global
 * CLI's own config, independent of cwd.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'claude-remote', 'config.yaml');

/**
 * Env var used to override `workspace.local` from config.yaml on a
 * per-invocation basis, without editing the file. This is what lets you
 * point claude-remote at a different project directory for one run
 * (`CLAUDE_REMOTE_WORKSPACE=/path/to/other/repo claude-remote launch`)
 * instead of maintaining multiple config files or a multi-workspace list
 * — see docs/superpowers/specs/2026-07-13-claude-remote-design.md's
 * "Multi-machine" decision: the same YAGNI reasoning applied to
 * workspaces (one active workspace, overridable, instead of a list).
 */
export const WORKSPACE_ENV_VAR = 'CLAUDE_REMOTE_WORKSPACE';

const RemoteOsSchema = z.enum(['linux', 'windows-wsl2']);

const RemoteConfigSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  // Optional: falls back to ssh-agent / whatever identity is already
  // configured in ~/.ssh/config if omitted. claude-remote deliberately
  // never generates or copies keys itself (see the spec's "SSH key
  // setup" decision) — key access is assumed to already exist.
  sshKeyPath: z.string().optional(),
  os: RemoteOsSchema,
  // Base path created on the remote to mirror the Mac's own absolute
  // paths (e.g. "/Users/pak"), even though it isn't that machine's real
  // home directory. This is what makes Claude Code's sanitized-path
  // project keys line up between Mac and remote — see the spec's
  // "identical-absolute-path trick" section. It only works if this is
  // set to literally match the Mac's own homedir() value.
  homeMirrorPath: z.string().min(1),
});

const WorkspaceConfigSchema = z.object({
  local: z.string().min(1),
});

const SyncConfigSchema = z.object({
  ignore: z.array(z.string()).default(['node_modules', '.venv', 'dist', 'build', '__pycache__']),
});

const TmuxConfigSchema = z.object({
  sessionName: z.string().min(1).default('claude-remote'),
});

const LaunchConfigSchema = z.object({
  autoStartClaude: z.boolean().default(true),
  claudeArgs: z.array(z.string()).default(['--dangerously-skip-permissions']),
});

export const ConfigSchema = z.object({
  remote: RemoteConfigSchema,
  workspace: WorkspaceConfigSchema,
  sync: SyncConfigSchema.default({}),
  tmux: TmuxConfigSchema.default({}),
  launch: LaunchConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates config.yaml. Throws a human-readable error (not a
 * raw Zod stack trace) on a missing file or schema violation, since this
 * is the first thing every subcommand does — a confusing error here is
 * everyone's first impression of the tool.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const resolvedPath = resolve(configPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found at ${resolvedPath}\n` +
        `Copy config.example.yaml to that path and fill in your remote machine's details, ` +
        `or pass --config <path> to point at a different file.`
    );
  }

  const raw = parseYaml(readFileSync(resolvedPath, 'utf-8'));
  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config at ${resolvedPath}:\n${issues}`);
  }

  return result.data;
}

/**
 * Resolves the workspace path actually in play for this invocation:
 * CLAUDE_REMOTE_WORKSPACE wins if set (lets you switch projects without
 * touching config.yaml), otherwise falls back to config.workspace.local.
 */
export function resolveWorkspaceLocal(config: Config): string {
  const override = process.env[WORKSPACE_ENV_VAR];
  return override && override.trim().length > 0 ? resolve(override) : config.workspace.local;
}

/**
 * The remote workspace path is never independently configured — there is
 * no "workspace.remote" field in the schema above. It is always the
 * identical absolute path as the local one; this only works because
 * remote.homeMirrorPath is set to match the Mac's real home directory,
 * so any path under it (like a workspace under /Users/pak/Projects/...)
 * stays valid unchanged when reused on the remote. setup.ts uses
 * homeMirrorPath separately to know what to `mkdir -p` on the remote
 * before anything can be synced there.
 */
export function resolveWorkspaceRemote(workspaceLocal: string): string {
  return workspaceLocal;
}
