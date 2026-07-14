import { execFile, spawn } from 'node:child_process';
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
 * Creates a named two-way sync session using `--sync-mode=two-way-resolved`.
 *
 * RESOLVED (2026-07-14, checked against a real `mutagen sync create --help`
 * and Mutagen's own docs on a live install — this was previously an
 * unverified guess, now confirmed): there is no
 * `--default-conflict-resolution` flag — it never existed, and the
 * original code that passed it would have made every `mutagen sync
 * create` call fail outright with an unknown-flag error on first real
 * `setup`. `two-way-resolved` mode has a *fixed*, non-configurable rule
 * instead: **alpha always wins every conflict** (including deletions
 * overwriting the other side's edits). There is no flag or config to
 * reverse this — the only way to control which side wins is to control
 * which endpoint you pass as `alpha`.
 *
 * Because of this, **every caller in this codebase must pass the side
 * that should win conflicts as `alpha` and the other side as `beta`** —
 * this is the opposite of what the parameter names might suggest if you
 * think of "alpha" as "primary"/"the Mac". To implement this project's
 * "remote wins" safety property (README's "Operational rules",
 * launch.ts's `confirmNoConcurrentClaudeSession`), callers pass the
 * *remote* path as `alpha` and the *Mac* path as `beta` — see setup.ts's
 * `ensureClaudeHomeSync` and launch.ts's workspace session creation.
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
    ...opts.ignore.map((pattern) => `--ignore=${pattern}`),
  ];
  await runMutagen(args);
}

/**
 * Idempotent entry point used by both setup.ts (the claude-home session)
 * and launch.ts (the workspace session): creates the session only if it
 * doesn't already exist, so re-running setup or re-launching into the
 * same workspace repeatedly never errors on "session already exists".
 *
 * KNOWN v1 LIMITATION (not an oversight — needs design input beyond a
 * fix pass, so documented rather than silently patched): this only
 * checks existence by name. It never retargets or validates an
 * existing session's actual alpha/beta against the alpha/beta being
 * requested now. Two ways that bites:
 *   - If `remote.host`, `homeMirrorPath`, or `sshKeyPath` changes and
 *     you re-launch a previously-used workspace, the stale session
 *     keeps quietly syncing to the *old* target — nothing here notices
 *     the drift.
 *   - `sessionNameForWorkspace` (launch.ts) collapses every run of
 *     non-alphanumeric characters to a single hyphen, so two distinct
 *     workspace paths (e.g. `/a/foo-bar` and `/a/foo/bar`) can collide
 *     on the same session name — if that happens, this function would
 *     reuse a session actually pointed at the wrong directory.
 * Until this is addressed, the manual workaround for either case is to
 * run `mutagen sync terminate <name>` yourself before re-running
 * setup/launch, so a fresh session gets created against the correct
 * endpoints.
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

/**
 * Not called from any CLI command in v1 — `sessionExists`/`createSession`
 * cover setup/launch's actual needs, and there's no `claude-remote`
 * subcommand yet for tearing a session down. Kept exported anyway: it's
 * the manual escape hatch for the stale/misdirected-session cases noted
 * on `ensureSession` above (run it via a one-off script or a REPL —
 * `mutagen sync terminate <name>` — before re-running setup/launch), and
 * it's the natural primitive a future cleanup subcommand would wrap.
 */
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
 *
 * "Session doesn't exist" is a normal, expected state here (e.g. before
 * `setup`/`launch` has ever created it for the current workspace), not
 * an error — so it's handled explicitly via `sessionExists` rather than
 * letting `mutagen sync list`'s non-zero exit bubble up as a raw
 * `execFileAsync` "Command failed: ..." message, which reads like a
 * crash to someone just checking status. The ENOENT (mutagen not
 * installed) case still propagates as a real error, same as
 * `sessionExists` does, since that one *is* actionable and worth
 * surfacing loudly.
 */
export async function getSessionStatusText(name: string): Promise<string> {
  if (!(await sessionExists(name))) {
    return '(no session found — has setup/launch created it yet?)';
  }
  const { stdout } = await runMutagen(['sync', 'list', name, '--long']);
  return stdout;
}

/**
 * Streams live-updating progress for one or more sessions via `mutagen
 * sync monitor`, used by `claude-remote monitor`. Unlike every other
 * function in this file, this doesn't use `runMutagen`/`execFileAsync` —
 * `sync monitor` is a long-running, continuously-redrawing terminal
 * command (like `top`), not a one-shot call whose output you capture and
 * return. `stdio: 'inherit'` hands the real terminal to mutagen directly
 * so its live redraw works, the same pattern launch.ts uses for handing
 * off to ssh/tmux. Resolves when the user Ctrl+C's out of watching —
 * that only stops the terminal view, not the background sync itself.
 */
export function monitorSessions(names: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('mutagen', ['sync', 'monitor', '--long', ...names], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
