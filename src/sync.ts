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
