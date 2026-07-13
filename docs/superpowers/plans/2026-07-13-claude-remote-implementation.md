# claude-remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `claude-remote` CLI: a Node/TypeScript tool run from the Mac that installs dependencies on a trusted remote machine (Linux or Windows+WSL2), keeps `~/.claude` and the active project workspace synced to it via Mutagen, and drops into a live Claude Code session there over SSH+tmux.

**Architecture:** Three orchestration entry points (`setup`, `launch`, `status`) built on four small, independently-testable modules (`config.ts`, `ssh.ts`, `sync.ts`) wired together by `cli.ts`. Two Mutagen sync sessions: a persistent `claude-home` session created once by `setup`, and a `workspace` session created/retargeted by `launch` based on `CLAUDE_REMOTE_WORKSPACE`.

**Tech Stack:** TypeScript (strict, NodeNext modules), `zod` (config validation), `yaml` (config parsing), `commander` (CLI), `tsx` (dev-time execution), compiled via `tsc` to `dist/`. No test framework — manual verification only (see Global Constraints).

## Global Constraints

- Node.js >= 18, TypeScript `strict: true`.
- **Manual verification only** — no vitest/CI, matching `claude-docker`'s convention for this personal, low-change-frequency tool (spec's "Testing" section). Every task below ends with a manual run + expected output instead of an automated test.
- **Every file must carry detailed, WHY-focused comments** — not what the code does, but why it exists, what precedent it follows, what breaks without it. Matches the density already used in `claude-docker`'s `Dockerfile`/`entrypoint.sh`. This was an explicit, repeated user request — do not write sparse or purely-descriptive comments.
- SSH key setup is never automated by this tool (no key generation, no `ssh-copy-id`) — key access is assumed to already exist (spec's "SSH key setup" decision).
- Windows remote support is WSL2-only, never native PowerShell/cmd.exe (spec's "OS support" decision).
- `~/.claude` is synced in full (not scoped to a subdirectory) — a deliberate choice matching `claude-docker`'s precedent (spec + user confirmation).
- Default Mutagen conflict resolution: remote side wins (`--default-conflict-resolution=beta`, with alpha always the Mac path and beta always the remote path).
- Config file default location: `~/.config/claude-remote/config.yaml` — deliberately *not* resolved relative to `process.cwd()`, since this CLI runs from wherever the user happens to be (spec discussion). `config.example.yaml` is the only config file committed to the repo.
- **Verification boundary (read before executing):** SSH from this Mac to `localhost` is refused (Remote Login is off) and `mutagen`/`tmux` are not installed on this machine — the user declined enabling those for this implementation pass. Every task's manual verification below is designed to exercise real code against that refused-connection state (which is itself a legitimate, reproducible test of the error-handling paths) or against pure in-process logic that needs no network access at all. Nothing in this plan can verify a *successful* SSH connection, a real Mutagen sync, or a real `tmux`/`claude` launch — that remains for the user to run once `setup` targets an actual reachable remote machine. Each task says explicitly which category its verification falls into.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `bin/claude-remote.ts` (stub)

**Interfaces:**
- Produces: a working `npm run build` (tsc → `dist/`) and `npm run dev` (tsx, for fast iteration) that later tasks build on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-remote",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Run Claude Code on a trusted remote machine, kept in sync with the Mac via Mutagen.",
  "bin": {
    "claude-remote": "./dist/bin/claude-remote.js"
  },
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx bin/claude-remote.ts"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "yaml": "^2.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["bin", "src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
node_modules/
dist/
# The real, machine-specific config — only config.example.yaml is
# committed. This also covers the case of testing with --config
# ./config.yaml instead of the default ~/.config/claude-remote/ path.
config.yaml
*.log
.DS_Store
```

- [ ] **Step 4: Create a stub entrypoint so the build has something to compile**

`bin/claude-remote.ts`:
```ts
#!/usr/bin/env node
console.log('claude-remote: scaffolding in place, CLI not wired up yet.');
```

- [ ] **Step 5: Install dependencies**

Run: `cd /Users/pak/Projects/Deepsel/claude-remote && npm install`
Expected: installs cleanly, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 6: Verify the build works (manual verification — pure local build, no network/remote involved)**

Run: `npm run build && node dist/bin/claude-remote.js`
Expected output: `claude-remote: scaffolding in place, CLI not wired up yet.`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore bin/claude-remote.ts
git commit -m "Scaffold claude-remote: package.json, tsconfig, stub entrypoint"
```

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/config.ts`
- Create: `config.example.yaml`

**Interfaces:**
- Produces: `loadConfig(configPath?): Config`, `resolveWorkspaceLocal(config): string`, `resolveWorkspaceRemote(workspaceLocal): string`, `DEFAULT_CONFIG_PATH: string`, `WORKSPACE_ENV_VAR: string`, and the `Config` type — every later task imports from here.
- Consumes: nothing (leaf module).

- [ ] **Step 1: Create `config.example.yaml`**

```yaml
remote:
  host: 192.168.1.50
  user: pak
  sshKeyPath: ~/.ssh/id_ed25519
  os: linux
  homeMirrorPath: /Users/pak

workspace:
  local: /Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site

sync:
  ignore: [node_modules, .venv, dist, build, __pycache__]

tmux:
  sessionName: claude-remote

launch:
  autoStartClaude: true
  claudeArgs: ["--dangerously-skip-permissions"]
```

- [ ] **Step 2: Write `src/config.ts`**

```ts
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
```

- [ ] **Step 3: Manual verification — pure local logic, no network/remote involved**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
CLAUDE_REMOTE_WORKSPACE=/tmp/other-project npx tsx -e "
import { loadConfig, resolveWorkspaceLocal, resolveWorkspaceRemote } from './src/config.js';
const config = loadConfig('./config.example.yaml');
const local = resolveWorkspaceLocal(config);
console.log(JSON.stringify({ local, remote: resolveWorkspaceRemote(local) }, null, 2));
"
```
Expected output:
```json
{
  "local": "/tmp/other-project",
  "remote": "/tmp/other-project"
}
```
This confirms the env var override wins over `config.example.yaml`'s `workspace.local`. Then re-run without the env var prefix and confirm `local` becomes `/Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site` (the config file's default) instead.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts config.example.yaml
git commit -m "Add config schema, loader, and workspace path resolution"
```

---

### Task 3: SSH command builders and connectivity check

**Files:**
- Create: `src/ssh.ts`

**Interfaces:**
- Consumes: `Config['remote']` from `src/config.ts`.
- Produces: `checkConnectivity(remote): Promise<void>`, `runRemoteCommand(remote, command): Promise<SshResult>`, `buildInteractiveLaunchArgs(remote, opts): string[]`, type `SshResult` — used by `setup.ts`, `launch.ts`, `cli.ts`.

- [ ] **Step 1: Write `src/ssh.ts`**

```ts
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
 */
function shellQuote(value: string): string {
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
```

- [ ] **Step 2: Manual verification — real SSH process, exercising the failure path (localhost refuses connections since Remote Login is off; this is a genuine, reproducible test of the error-handling branch, not a stub)**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { checkConnectivity } from './src/ssh.js';
const remote = { host: 'localhost', user: 'pak', os: 'linux' as const, homeMirrorPath: '/tmp' };
checkConnectivity(remote)
  .then(() => console.log('UNEXPECTED: connected'))
  .catch((err) => console.log('EXPECTED FAILURE:\n' + err.message));
"
```
Expected output: starts with `EXPECTED FAILURE:` and includes `SSH connectivity check failed` (SSH itself runs, connects, gets refused by the OS, and exits non-zero — this is the `result.code !== 0` branch, not the `catch` block around the spawn, which is only for exec-level failures like `ssh` missing from PATH).

- [ ] **Step 3: Commit**

```bash
git add src/ssh.ts
git commit -m "Add SSH connectivity check and interactive launch command builder"
```

---

### Task 4: Mutagen CLI wrapper

**Files:**
- Create: `src/sync.ts`

**Interfaces:**
- Produces: `sessionExists(name): Promise<boolean>`, `createSession(opts): Promise<void>`, `ensureSession(opts): Promise<void>`, `terminateSession(name): Promise<void>`, `getSessionStatusText(name): Promise<string>` — used by `setup.ts`, `launch.ts`, `cli.ts`.

- [ ] **Step 1: Write `src/sync.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Wraps the `mutagen` CLI rather than any Go/Node SDK — there is no
 * first-party Node binding, and this tool only ever needs to create,
 * check, and list two long-lived sync sessions, not build a full sync
 * client. Shelling out to the same binary a human would run by hand is
 * the simplest correct option, and keeps this module's behavior
 * identical to what `mutagen sync ...` does when you type it yourself.
 */

const MUTAGEN_NOT_FOUND_HINT =
  "'mutagen' was not found on PATH. Install it first: brew install mutagen-io/mutagen/mutagen";

/**
 * Wraps every mutagen invocation to turn the raw ENOENT (binary missing)
 * into an actionable hint instead of a bare stack trace — this is the
 * single most likely first-run failure for anyone who hasn't installed
 * Mutagen yet, and by far the easiest one to make self-explanatory.
 */
async function runMutagen(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('mutagen', args);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new Error(MUTAGEN_NOT_FOUND_HINT);
    }
    throw err;
  }
}

/**
 * True if a sync session with this exact name already exists (running,
 * paused, or in an error state — any state counts as "exists" here,
 * since the caller's job is just deciding whether to create one).
 * `mutagen sync list <name>` exits non-zero when no session matches that
 * name, so existence is a plain exit-code check rather than parsing
 * Mutagen's human-readable list output, which keeps this robust across
 * Mutagen versions that might reformat that output.
 */
export async function sessionExists(name: string): Promise<boolean> {
  try {
    await runMutagen(['sync', 'list', name]);
    return true;
  } catch (err) {
    if ((err as Error).message === MUTAGEN_NOT_FOUND_HINT) {
      throw err;
    }
    return false;
  }
}

/**
 * Creates a named two-way sync session. `--sync-mode=two-way-resolved`
 * with `--default-conflict-resolution=beta` implements the spec's
 * conflict default ("remote wins"): every caller in this codebase passes
 * the Mac path as alpha and the remote path as beta, so beta-wins means
 * the remote's edit survives when both sides changed the same file
 * while disconnected.
 */
export async function createSession(opts: {
  name: string;
  alpha: string;
  beta: string;
  ignore: string[];
}): Promise<void> {
  const args = [
    'sync',
    'create',
    opts.alpha,
    opts.beta,
    `--name=${opts.name}`,
    '--sync-mode=two-way-resolved',
    '--default-conflict-resolution=beta',
    ...opts.ignore.map((pattern) => `--ignore=${pattern}`),
  ];
  await runMutagen(args);
}

/**
 * Idempotent entry point used by both setup.ts (the claude-home session)
 * and launch.ts (the workspace session): creates the session only if it
 * doesn't already exist, so re-running setup or re-launching into the
 * same workspace repeatedly never errors on "session already exists".
 */
export async function ensureSession(opts: {
  name: string;
  alpha: string;
  beta: string;
  ignore: string[];
}): Promise<void> {
  if (await sessionExists(opts.name)) {
    return;
  }
  await createSession(opts);
}

export async function terminateSession(name: string): Promise<void> {
  await runMutagen(['sync', 'terminate', name]);
}

/**
 * Raw text status for a session, surfaced as-is by `claude-remote
 * status` rather than parsed into a typed structure — Mutagen's own
 * `--long` list output already answers the only questions status needs
 * to show (syncing / paused / conflicted), so parsing it into our own
 * types would just be a lossy re-encoding of information Mutagen already
 * presents clearly.
 */
export async function getSessionStatusText(name: string): Promise<string> {
  const { stdout } = await runMutagen(['sync', 'list', name, '--long']);
  return stdout;
}
```

- [ ] **Step 2: Manual verification — real process spawn, exercising the "mutagen not installed" path (mutagen genuinely isn't installed on this machine, so this is a real, reproducible failure, not a stub)**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { sessionExists } from './src/sync.js';
sessionExists('test-session')
  .then((exists) => console.log('UNEXPECTED, mutagen must be installed:', exists))
  .catch((err) => console.log('EXPECTED FAILURE:\n' + err.message));
"
```
Expected output:
```
EXPECTED FAILURE:
'mutagen' was not found on PATH. Install it first: brew install mutagen-io/mutagen/mutagen
```

**Note for whoever runs this against a real Mutagen install:** double-check `mutagen sync create`'s exact flags against `mutagen sync create --help` before the first real run — `createSession` above was written from general knowledge of Mutagen's CLI, not verified against a live install in this implementation pass (see Global Constraints' verification boundary).

- [ ] **Step 3: Commit**

```bash
git add src/sync.ts
git commit -m "Add Mutagen CLI wrapper: session create/exists/status"
```

---

### Task 5: Setup wizard

**Files:**
- Create: `src/setup.ts`

**Interfaces:**
- Consumes: `checkConnectivity`, `runRemoteCommand` (`src/ssh.ts`); `ensureSession` (`src/sync.ts`); `Config`, `resolveWorkspaceLocal`, `resolveWorkspaceRemote` (`src/config.ts`).
- Produces: `runSetup(config): Promise<void>`, `CLAUDE_HOME_SESSION_NAME: string` (exported so `cli.ts`'s `status` command and `launch.ts` can reference the same session name without duplicating the string).

- [ ] **Step 1: Write `src/setup.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkConnectivity, runRemoteCommand } from './ssh.js';
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
  const result = await runRemoteCommand(config.remote, `mkdir -p ${claudeHomeRemote} ${workspaceParentRemote}`);
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
```

- [ ] **Step 2: Manual verification — real code path up to the first remote call, which fails against the refused localhost connection exactly like Task 3's check**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { runSetup } from './src/setup.js';
import { loadConfig } from './src/config.js';
const config = loadConfig('./config.example.yaml');
config.remote.host = 'localhost';
runSetup(config).catch((err) => console.log('EXPECTED FAILURE:\n' + err.message));
"
```
Expected output: prints `→ Checking SSH connectivity to localhost`, then `EXPECTED FAILURE:` followed by the same `SSH connectivity check failed` message Task 3 verified — confirming `runSetup`'s step ordering and error propagation without needing the later steps (which require a real reachable remote) to run.

- [ ] **Step 3: Commit**

```bash
git add src/setup.ts
git commit -m "Add setup wizard: connectivity, OS detection, dependency install, claude-home sync"
```

---

### Task 6: Launch

**Files:**
- Create: `src/launch.ts`

**Interfaces:**
- Consumes: `checkConnectivity`, `buildInteractiveLaunchArgs` (`src/ssh.ts`); `ensureSession` (`src/sync.ts`); `Config`, `resolveWorkspaceLocal`, `resolveWorkspaceRemote` (`src/config.ts`).
- Produces: `runLaunch(config, opts): Promise<number>`, `sessionNameForWorkspace(workspaceLocal): string` (exported so `cli.ts`'s `status` command can compute the same dynamic session name).

- [ ] **Step 1: Write `src/launch.ts`**

```ts
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
```

- [ ] **Step 2: Manual verification — real code path up to the first remote call, same refused-localhost pattern as Tasks 3 and 5**

Run:
```bash
cd /Users/pak/Projects/Deepsel/claude-remote
npx tsx -e "
import { runLaunch } from './src/launch.js';
import { loadConfig } from './src/config.js';
const config = loadConfig('./config.example.yaml');
config.remote.host = 'localhost';
runLaunch(config, { skipConfirm: true }).catch((err) => console.log('EXPECTED FAILURE:\n' + err.message));
"
```
Expected output: `EXPECTED FAILURE:` followed by the `SSH connectivity check failed` message — `runLaunch` checks connectivity before touching Mutagen or prompting for confirmation, so this fails at the same first step regardless of `skipConfirm`.

Also verify `sessionNameForWorkspace` directly (pure function, no network):
```bash
npx tsx -e "
import { sessionNameForWorkspace } from './src/launch.js';
console.log(sessionNameForWorkspace('/Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site'));
"
```
Expected output: `claude-remote-workspace-Users-pak-Projects-Deepsel-DeepselSystems-alcoris-site`

- [ ] **Step 3: Commit**

```bash
git add src/launch.ts
git commit -m "Add launch: workspace sync, concurrent-session confirmation, SSH+tmux handoff"
```

---

### Task 7: CLI wiring

**Files:**
- Modify: `bin/claude-remote.ts` (replace stub from Task 1)
- Create: `src/cli.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2–6 (`loadConfig`, `DEFAULT_CONFIG_PATH`, `resolveWorkspaceLocal`, `resolveWorkspaceRemote` from `config.ts`; `checkConnectivity` from `ssh.ts`; `getSessionStatusText` from `sync.ts`; `runSetup`, `CLAUDE_HOME_SESSION_NAME` from `setup.ts`; `runLaunch`, `sessionNameForWorkspace` from `launch.ts`).
- Produces: `buildCli(): Command`, the finished executable.

- [ ] **Step 1: Write `src/cli.ts`**

```ts
import { Command } from 'commander';
import { join } from 'node:path';
import {
  loadConfig,
  DEFAULT_CONFIG_PATH,
  resolveWorkspaceLocal,
  resolveWorkspaceRemote,
} from './config.js';
import { runSetup, CLAUDE_HOME_SESSION_NAME } from './setup.js';
import { runLaunch, sessionNameForWorkspace } from './launch.js';
import { checkConnectivity } from './ssh.js';
import { getSessionStatusText } from './sync.js';

/**
 * Factored out from bin/claude-remote.ts so the CLI's wiring can be
 * exercised without going through a real process invocation — not used
 * by an automated test today (this project has none, see Global
 * Constraints), but keeps the entrypoint file itself a one-liner that
 * only handles process-level concerns (argv, exit code).
 */
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
      const workspaceLocal = resolveWorkspaceLocal(config);
      const sessionNames = [CLAUDE_HOME_SESSION_NAME, sessionNameForWorkspace(workspaceLocal)];

      for (const name of sessionNames) {
        console.log(`\n${name}:`);
        try {
          console.log(await getSessionStatusText(name));
        } catch (err) {
          console.log(`  ${(err as Error).message}`);
        }
      }
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
```

- [ ] **Step 2: Replace the stub `bin/claude-remote.ts`**

```ts
#!/usr/bin/env node
import { buildCli } from '../src/cli.js';

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  });
```

- [ ] **Step 3: Manual verification — pure local CLI behavior, no network/remote involved**

Run: `npm run build && node dist/bin/claude-remote.js --help`
Expected output: commander's generated help listing `setup`, `launch`, `status`, `config` with the descriptions written above.

Run: `node dist/bin/claude-remote.js config --config ./config.example.yaml`
Expected output: JSON with `config.remote.host` = `"192.168.1.50"`, `resolvedWorkspaceLocal` = `"/Users/pak/Projects/Deepsel/DeepselSystems/alcoris-site"`, `resolvedWorkspaceRemote` equal to the same value, and `resolvedClaudeConfigDirRemote` = `"/Users/pak/.claude"`.

Run: `CLAUDE_REMOTE_WORKSPACE=/tmp/other-project node dist/bin/claude-remote.js config --config ./config.example.yaml`
Expected: `resolvedWorkspaceLocal` and `resolvedWorkspaceRemote` both become `"/tmp/other-project"`, confirming the env override reaches all the way through the real CLI (not just the Task 2 unit-level check).

Run: `node dist/bin/claude-remote.js status --config ./config.example.yaml`
Expected: `SSH: unreachable` (config.example.yaml's `host: 192.168.1.50` is not a real reachable host in this environment) followed by the connectivity error message, then both session names each followed by the Mutagen-not-installed hint from Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts bin/claude-remote.ts
git commit -m "Wire up CLI: setup, launch, status, config subcommands"
```

---

### Task 8: README and end-to-end verification checklist

**Files:**
- Create: `README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Write `README.md`**

```markdown
# claude-remote

Run Claude Code (with `--dangerously-skip-permissions`) on a fully-trusted,
physically separate machine instead of in a local Docker container. Keeps
`~/.claude` and the active project workspace continuously synced to that
machine via [Mutagen](https://mutagen.io), and drops you into a live Claude
Code session there over SSH + tmux.

Sibling tool to `claude-docker` — same author, same personal/local-only
status (never pushed to a remote git host). Full design rationale:
`docs/superpowers/specs/2026-07-13-claude-remote-design.md`.

## Prerequisites

**On the Mac (control machine):**
- `brew install mutagen-io/mutagen/mutagen`
- SSH key access to the remote already working (`ssh <user>@<host>` should
  need no password or prompt) — this tool never generates or copies keys
  for you.

**On the remote machine:**
- Linux (any apt-based distro) or Windows with WSL2 already installed
  (native Windows without WSL2 is not supported — see the design spec).
- Reachable over SSH from the Mac.
- Everything else (`tmux`, Node.js, the Claude Code CLI) is installed
  automatically by `claude-remote setup`.

## Setup

```bash
npm install
npm run build
npm link          # puts `claude-remote` on PATH

mkdir -p ~/.config/claude-remote
cp config.example.yaml ~/.config/claude-remote/config.yaml
# edit ~/.config/claude-remote/config.yaml: remote.host, remote.user,
# remote.sshKeyPath, remote.homeMirrorPath (should match `echo $HOME` on
# the Mac, e.g. /Users/pak), workspace.local

claude-remote setup
```

## Daily use

```bash
claude-remote launch
# or, to work on a different project without editing config.yaml:
CLAUDE_REMOTE_WORKSPACE=/path/to/other/repo claude-remote launch
```

`launch` drops you into a tmux session on the remote, running Claude Code
in the synced workspace. Detach with `Ctrl-b d` any time; running
`claude-remote launch` again reattaches to the same session instead of
starting a new one.

Check sync/connectivity state without launching: `claude-remote status`.

## Operational rules (read before your first real session)

- **Never run Claude Code on both the Mac and the remote at the same
  time.** `~/.claude` is synced continuously, not instantly — running
  both sides at once can clobber the Mac's session/memory state (the
  remote side wins on conflict). `launch` prompts you to confirm this
  before every session; don't reflexively pass `--yes` unless you've
  actually checked.
- **Avoid git write operations (commit, checkout, merge) on both sides at
  the same time**, for the same reason — both sides have a live,
  bidirectionally-synced `.git` directory.
- Conflicts, if they happen, default to "remote wins". Check
  `claude-remote status` if something looks like it reverted unexpectedly.

## Manual end-to-end verification checklist

This project has no automated tests (see the design spec's "Testing"
section) and was implemented without a reachable SSH target available
(macOS Remote Login was left off during implementation — see the plan's
"Global Constraints"). Everything up through real command construction
and local error-handling paths was verified during implementation; the
following still needs a real run against an actual remote machine before
trusting this day-to-day:

- [ ] `claude-remote setup` against a real, freshly-provisioned Linux or
      WSL2 machine: completes without error, leaves `tmux`, `node`, and
      `claude` installed, and `mutagen sync list claude-remote-claude-home`
      shows the session as `Watching for changes`.
- [ ] Edit a file inside `~/.claude/projects/` on the Mac; confirm it
      appears on the remote within a few seconds (and vice versa).
- [ ] `claude-remote launch`: confirm it attaches to the correct tmux
      session, in the correct directory, with `CLAUDE_CONFIG_DIR` set
      correctly (`echo $CLAUDE_CONFIG_DIR` inside the session), and that
      Claude Code can resume a session that has history from the Mac.
- [ ] Detach (`Ctrl-b d`), run `claude-remote launch` again: confirm it
      reattaches to the same tmux session instead of creating a new one.
- [ ] Edit a file in the workspace on the remote; confirm it propagates
      back to the Mac.
- [ ] `claude-remote status`: confirm both sessions show as syncing and
      SSH shows as reachable.
```

- [ ] **Step 2: Manual verification — read-through, no command to run**

Confirm every command in the README (`npm install`, `npm run build`,
`npm link`, `claude-remote setup`, `claude-remote launch`,
`claude-remote status`) matches an actual `package.json` script or CLI
subcommand defined in Tasks 1–7 — this is a documentation/code
consistency check, not something with a pass/fail command output.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Add README with setup instructions and manual E2E verification checklist"
```
