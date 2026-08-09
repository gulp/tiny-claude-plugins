/**
 * tcp-efp.5.15: shared CODEX_BIN resolution for service + doctor.
 *
 * Rejects package-manager wrappers that perform network/package resolution.
 * Requires a canonical native (ELF) Codex binary. Sanitizes loader-injection
 * env for diagnostic subprocesses. Version probes use a hard deadline that
 * kills the process group so pipe-holding descendants cannot hang the caller.
 */

import { EXIT, IngressError } from "../errors.ts";

/** Actionable diagnostic / resolution codes (also appear in doctor version checks). */
export const CODEX_BIN_CODES = {
  WRAPPER_REJECTED: "CODEX_BIN_WRAPPER_REJECTED",
  NOT_NATIVE: "CODEX_BIN_NOT_NATIVE",
  MISSING: "CODEX_BIN_MISSING",
  NOT_ABSOLUTE: "CODEX_BIN_NOT_ABSOLUTE",
  UNREADABLE: "CODEX_BIN_UNREADABLE",
  PROBE_TIMEOUT: "VERSION_PROBE_TIMEOUT",
  PROBE_FAILED: "VERSION_PROBE_FAILED",
} as const;

export type CodexBinCode = (typeof CODEX_BIN_CODES)[keyof typeof CODEX_BIN_CODES];

export type CodexBinKind =
  | "native_elf"
  | "package_manager_wrapper"
  | "script"
  | "missing"
  | "unreadable";

export type CodexBinInspection = {
  path: string;
  kind: CodexBinKind;
  reason: string;
  code: CodexBinCode | "CODEX_BIN_OK";
};

/** Markers that identify package-manager / online-resolution wrappers. */
const WRAPPER_MARKERS: RegExp[] = [
  /\bnpx\b/,
  /--prefer-online/,
  /\bnpm\s+exec\b/,
  /\byarn\s+dlx\b/,
  /\bpnpm\s+dlx\b/,
  /package=["']@openai\/codex["']/,
  /--package\s+["']?@openai\/codex/,
  /\bnpm\s+install\b/,
  /\bmise\s+(use|x|exec)\b/,
];

const ELF_MAGIC = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
const SCRIPT_SNIFF_BYTES = 16_384;

export class CodexBinError extends IngressError {
  readonly binCode: CodexBinCode;

  constructor(binCode: CodexBinCode, message: string, exitCode = EXIT.DEPENDENCY) {
    super("path_invalid", `${binCode}: ${message}`, exitCode);
    this.name = "CodexBinError";
    this.binCode = binCode;
  }
}

function bytesStartWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}

function looksLikeScript(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true; // #!
  // UTF-8/ASCII text without ELF magic — treat as script for marker scan.
  const sample = bytes.slice(0, Math.min(bytes.length, 256));
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1;
  }
  return sample.length > 0 && printable / sample.length > 0.9;
}

/** Pure classifier over file bytes (unit-testable without host PATH). */
export function classifyCodexBytes(
  path: string,
  bytes: Uint8Array,
): CodexBinInspection {
  if (bytesStartWith(bytes, ELF_MAGIC)) {
    return {
      path,
      kind: "native_elf",
      reason: "ELF executable",
      code: "CODEX_BIN_OK",
    };
  }
  if (looksLikeScript(bytes)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, SCRIPT_SNIFF_BYTES),
    );
    for (const marker of WRAPPER_MARKERS) {
      if (marker.test(text)) {
        return {
          path,
          kind: "package_manager_wrapper",
          reason:
            `package-manager wrapper matched ${marker}; refuses network/package resolution for bounded probes`,
          code: CODEX_BIN_CODES.WRAPPER_REJECTED,
        };
      }
    }
    return {
      path,
      kind: "script",
      reason: "script/shebang without native ELF magic",
      code: CODEX_BIN_CODES.NOT_NATIVE,
    };
  }
  return {
    path,
    kind: "script",
    reason: "not a native ELF executable",
    code: CODEX_BIN_CODES.NOT_NATIVE,
  };
}

export async function inspectCodexBin(path: string): Promise<CodexBinInspection> {
  if (!path || !path.trim()) {
    return {
      path,
      kind: "missing",
      reason: "empty CODEX_BIN",
      code: CODEX_BIN_CODES.MISSING,
    };
  }
  if (!path.startsWith("/")) {
    return {
      path,
      kind: "missing",
      reason: "CODEX_BIN must be an absolute path",
      code: CODEX_BIN_CODES.NOT_ABSOLUTE,
    };
  }
  try {
    const file = await Deno.open(path, { read: true });
    try {
      const buf = new Uint8Array(SCRIPT_SNIFF_BYTES);
      const n = await file.read(buf);
      if (n === null || n === 0) {
        return {
          path,
          kind: "unreadable",
          reason: "empty file",
          code: CODEX_BIN_CODES.UNREADABLE,
        };
      }
      return classifyCodexBytes(path, buf.subarray(0, n));
    } finally {
      file.close();
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        path,
        kind: "missing",
        reason: `missing: ${path}`,
        code: CODEX_BIN_CODES.MISSING,
      };
    }
    return {
      path,
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
      code: CODEX_BIN_CODES.UNREADABLE,
    };
  }
}

async function whichAbsolute(command: string): Promise<string | null> {
  if (command.startsWith("/")) return command;
  const pathEnv = Deno.env.get("PATH") ?? "";
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    const candidate = `${dir}/${command}`;
    try {
      const st = await Deno.stat(candidate);
      if (st.isFile) return await Deno.realPath(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Resolve and validate a canonical native Codex binary.
 * Never returns a package-manager wrapper. Never falls back to network install.
 */
export async function resolveNativeCodexBin(explicit?: string): Promise<string> {
  const raw = (explicit ?? Deno.env.get("CODEX_BIN") ?? "").trim();
  if (!raw) {
    throw new CodexBinError(
      CODEX_BIN_CODES.MISSING,
      "set CODEX_BIN to an absolute native Codex ELF (not a PATH wrapper)",
    );
  }
  let absolute = raw;
  if (!absolute.startsWith("/")) {
    const found = await whichAbsolute(absolute);
    if (!found) {
      throw new CodexBinError(
        CODEX_BIN_CODES.MISSING,
        `cannot resolve ${raw} on PATH; set CODEX_BIN to an absolute native ELF`,
      );
    }
    absolute = found;
  }
  let canonical = absolute;
  try {
    canonical = await Deno.realPath(absolute);
  } catch (error) {
    throw new CodexBinError(
      CODEX_BIN_CODES.MISSING,
      error instanceof Error ? error.message : String(error),
    );
  }
  const inspection = await inspectCodexBin(canonical);
  if (inspection.code === CODEX_BIN_CODES.WRAPPER_REJECTED) {
    throw new CodexBinError(
      CODEX_BIN_CODES.WRAPPER_REJECTED,
      `${canonical}: ${inspection.reason}. Point CODEX_BIN at the vendor ELF (e.g. …/codex-linux-x64/vendor/…/bin/codex), not $(command -v codex).`,
    );
  }
  if (inspection.kind !== "native_elf") {
    throw new CodexBinError(
      inspection.code === "CODEX_BIN_OK" ? CODEX_BIN_CODES.NOT_NATIVE : inspection.code,
      `${canonical}: ${inspection.reason}`,
    );
  }
  return canonical;
}

/** Loader / injection vars that must never reach a diagnostic spawn. */
export const LOADER_INJECTION_VARS = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
] as const;

/** Minimal env for `codex --version` — no loader injection, no secrets. */
export function buildVersionProbeEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "CODEX_HOME",
  ];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  for (const key of LOADER_INJECTION_VARS) {
    delete out[key];
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveSetsidPath(): Promise<string | null> {
  for (const candidate of ["/usr/bin/setsid", "/bin/setsid"]) {
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function killProcessGroup(pid: number): void {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    // Negative PID = process group (setsid child is the leader).
    Deno.kill(-pid, "SIGKILL");
  } catch {
    /* group gone or not a leader */
  }
}

/**
 * Bounded `codex --version` — never starts App Server.
 * Hard deadline returns even if a descendant retains stdout/stderr pipes.
 * Clears loader-injection variables for the child environment.
 */
export async function defaultProbeCodexVersion(
  codexBin: string,
  timeoutMs: number,
  options: { env?: Record<string, string> } = {},
): Promise<string> {
  const env = buildVersionProbeEnv(options.env ?? Deno.env.toObject());
  const setsidPath = await resolveSetsidPath();
  const command = new Deno.Command(setsidPath ?? codexBin, {
    args: setsidPath ? [codexBin, "--version"] : ["--version"],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env,
  });
  const child = command.spawn();
  const pid = child.pid;

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(pid);
  }, timeoutMs);

  try {
    const raced = await Promise.race([
      child.output().then((output) => ({ kind: "output" as const, output })),
      sleep(timeoutMs + 100).then(() => ({ kind: "deadline" as const })),
    ]);
    if (raced.kind === "deadline" || timedOut) {
      killProcessGroup(pid);
      // Abandon any lingering pipe wait — do not await child.output() further.
      throw new CodexBinError(
        CODEX_BIN_CODES.PROBE_TIMEOUT,
        `codex --version exceeded ${timeoutMs}ms (killed process group pid=${pid}); check CODEX_BIN is a native ELF, not a wrapper`,
      );
    }
    const { output } = raced;
    const text = `${new TextDecoder().decode(output.stdout)}${
      new TextDecoder().decode(output.stderr)
    }`;
    if (!output.success) {
      throw new CodexBinError(
        CODEX_BIN_CODES.PROBE_FAILED,
        `codex --version failed (code=${output.code}): ${text.trim() || "<empty>"}`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
    killProcessGroup(pid);
  }
}
