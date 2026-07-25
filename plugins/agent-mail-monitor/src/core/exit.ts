// Exit-code contract for the `agent-mail` CLI.
//
// These numbers are PART OF THE CONTRACT that skills, monitors, and agents rely
// on — keep them STABLE. Ported and refined from the bash entrypoints
// (mail-monitor.sh / watch-mail.sh) per tcp-6yk.9. The watch loop reports
// failures on stdout (the only stream a Monitor turns into a notification); the
// exit code is the machine-readable half of that same signal.

export const ExitCode = {
  /** Clean success, or `--help`/`--version` printed. */
  OK: 0,
  /** A query ran cleanly but the requested resource does not exist — e.g.
   *  `message <id>` resolved across every candidate project and found no match.
   *  A NEGATIVE RESULT, not an error: distinct from USAGE (bad invocation) and
   *  SERVER_UNREACHABLE (could not query). Follows the grep/test convention that
   *  exit 1 means "ran fine, answer is no". */
  NOT_FOUND: 1,
  /** Bad invocation: unknown flag/arg, or a non-integer interval/since. */
  USAGE: 2,
  /** AGENT_NAME unset — no inbox to watch. Idle, but LOUD (never a silent no-op). */
  NO_IDENTITY: 3,
  /** The very FIRST check-inbox poll failed — almost always misconfiguration. */
  FIRST_POLL_FAILED: 4,
  /** `am` ran but the server/poll is unreachable (health probe / query failure). */
  SERVER_UNREACHABLE: 5,
  /** The `am` CLI is not on PATH / not runnable. */
  AM_MISSING: 6,
  /** Unexpected internal error (EX_SOFTWARE). A bug, not a user/env condition. */
  INTERNAL: 70,
} as const;

export type ExitName = keyof typeof ExitCode;
export type ExitValue = (typeof ExitCode)[ExitName];

/**
 * An error carrying the process exit code it should map to. Thrown from the
 * command layer and translated to `Deno.exit(code)` once, at the CLI boundary.
 */
export class AppError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
