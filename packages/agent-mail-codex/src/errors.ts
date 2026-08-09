/** Typed exit codes and error taxonomy for agent-mail-codex (F1). */

export const EXIT = {
  OK: 0,
  /** Runtime / delivery failure (reserved; F1 CLI has no delivery). */
  FAILURE: 1,
  /** Bad arguments or unreadable CLI usage. */
  USAGE: 2,
  /** Missing required identity / env (reserved for later hooks). */
  IDENTITY: 3,
  /** Invalid or unusable configuration / binding / path. */
  CONFIG: 4,
  /** Invalid adapter or ownership selection. */
  OWNERSHIP: 5,
  /** Missing dependency (git, deno runtime tools, etc.). */
  DEPENDENCY: 127,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorCode =
  | "usage"
  | "config_invalid"
  | "config_missing"
  | "binding_missing"
  | "identity_invalid"
  | "scope_invalid"
  | "path_invalid"
  | "adapter_invalid"
  | "ownership_invalid"
  | "flag_invalid";

export class IngressError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: ErrorCode, message: string, exitCode: ExitCode) {
    super(message);
    this.name = "IngressError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function fail(code: ErrorCode, message: string, exitCode: ExitCode): never {
  throw new IngressError(code, message, exitCode);
}
