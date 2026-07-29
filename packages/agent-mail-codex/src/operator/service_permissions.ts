/**
 * tcp-efp.5.13: least-privilege path/env computation for the systemd-facing run.
 *
 * Source of truth for Deno allowlists and the private App Server child environment.
 * Rejects missing or non-absolute paths. Never logs secret values.
 */

import { EXIT, IngressError } from "../errors.ts";

/** Documented App Server child env keys (values copied from parent if set). */
export const APP_SERVER_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
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
  "CODEX_BIN",
  // Codex / OpenAI auth — operator must set deliberately; never invent.
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "CHATGPT_ACCOUNT_ID",
  // TLS trust stores
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
] as const;

export type AppServerEnvKey = (typeof APP_SERVER_ENV_ALLOWLIST)[number];

/** Env keys the Deno service process itself may read (superset of child allowlist). */
export const DENO_SERVICE_ENV_ALLOWLIST = [
  ...APP_SERVER_ENV_ALLOWLIST,
  "AGENT_MAIL_CODEX_CONFIG",
  "AGENT_MAIL_CODEX_ROOT",
  "AGENT_MAIL_CODEX_BINDING",
  "AGENT_MAIL_CODEX_LIB_DIR",
  "AGENT_MAIL_MAILBOX_ROOT",
  "CODEX_INGRESS_ENABLED",
  "CODEX_INGRESS_ADAPTER",
  "CODEX_INGRESS_OWNERSHIP",
  "CODEX_INGRESS_URGENT_STEER",
  "CODEX_INGRESS_DETERMINISTIC_COLLAPSE",
  "CODEX_INGRESS_METRICS_HTTP",
  "CODEX_INGRESS_SHADOW",
  "DENO_BIN",
  "DENO_DIR",
] as const;

export type ServicePermissionInput = {
  packageRoot: string;
  configPath: string;
  statePath: string;
  mailboxRoot: string;
  codexBin: string;
  /** Binding codex.cwd — project read only, never write. */
  projectCwd: string;
  homeDir: string;
  tmpDir: string;
  codexHome?: string;
  /** Extra read-only paths (must already be absolute). */
  extraReadPaths?: string[];
  /** When true, require paths to exist (install-time / doctor). */
  requireExists?: boolean;
};

export type ServicePermissions = {
  allowRead: string[];
  allowWrite: string[];
  allowRun: string[];
  codexHome: string;
  stateRoot: string;
  denoArgs: string[];
  deniedExamples: {
    unrelatedHomeFile: string;
    unrelatedProjectFile: string;
    secretEnvKeys: string[];
  };
};

function assertAbsolute(path: string, label: string): string {
  if (!path.startsWith("/")) {
    throw new IngressError(
      "path_invalid",
      `${label} must be an absolute path: ${path}`,
      EXIT.CONFIG,
    );
  }
  if (path.includes("\0") || path.includes("\n")) {
    throw new IngressError(
      "path_invalid",
      `${label} contains illegal characters`,
      EXIT.CONFIG,
    );
  }
  // Reject path traversal segments before resolution.
  const parts = path.split("/");
  if (parts.includes("..")) {
    throw new IngressError(
      "path_invalid",
      `${label} must not contain '..' segments: ${path}`,
      EXIT.CONFIG,
    );
  }
  return path;
}

async function resolveCanonical(
  path: string,
  label: string,
  requireExists: boolean,
): Promise<string> {
  const absolute = assertAbsolute(path, label);
  try {
    return await Deno.realPath(absolute);
  } catch (error) {
    if (!requireExists && error instanceof Deno.errors.NotFound) {
      // Parent may not exist yet for state roots — keep absolute form.
      return absolute;
    }
    throw new IngressError(
      "path_invalid",
      `${label} is missing or unresolvable: ${absolute}`,
      EXIT.CONFIG,
    );
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function uniquePreserve(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Compute bounded Deno permissions for `agent-mail-codex run`.
 * Does not include bare `--allow-read` / `--allow-write`.
 */
export async function computeServicePermissions(
  input: ServicePermissionInput,
): Promise<ServicePermissions> {
  const requireExists = input.requireExists ?? true;
  const packageRoot = await resolveCanonical(
    input.packageRoot,
    "packageRoot",
    requireExists,
  );
  const configPath = await resolveCanonical(
    input.configPath,
    "configPath",
    requireExists,
  );
  const statePath = assertAbsolute(input.statePath, "statePath");
  const stateRoot = parentDir(statePath);
  const mailboxRoot = await resolveCanonical(
    input.mailboxRoot,
    "mailboxRoot",
    requireExists,
  );
  const codexBin = await resolveCanonical(input.codexBin, "codexBin", requireExists);
  const projectCwd = await resolveCanonical(
    input.projectCwd,
    "projectCwd",
    requireExists,
  );
  const homeDir = await resolveCanonical(input.homeDir, "homeDir", requireExists);
  const tmpDir = assertAbsolute(input.tmpDir, "tmpDir");
  const codexHome = await resolveCanonical(
    input.codexHome ?? `${homeDir}/.codex`,
    "codexHome",
    false,
  );

  // Optional TLS / resolver paths — include only when present.
  const optionalReads = [
    "/etc/ssl/certs",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
  ];
  const existingOptional: string[] = [];
  for (const path of optionalReads) {
    try {
      existingOptional.push(await Deno.realPath(path));
    } catch {
      // omit
    }
  }

  const extra = (input.extraReadPaths ?? []).map((p) => assertAbsolute(p, "extraRead"));

  const allowRead = uniqueSorted([
    packageRoot,
    configPath,
    parentDir(configPath),
    stateRoot,
    mailboxRoot,
    codexBin,
    parentDir(codexBin),
    projectCwd,
    codexHome,
    tmpDir,
    ...existingOptional,
    ...extra,
  ]);

  const allowWrite = uniqueSorted([stateRoot, tmpDir, codexHome]);
  const allowRun = [codexBin];

  const denoArgs = [
    `--allow-read=${allowRead.join(",")}`,
    `--allow-write=${allowWrite.join(",")}`,
    `--allow-env=${DENO_SERVICE_ENV_ALLOWLIST.join(",")}`,
    "--allow-ffi",
    `--allow-run=${allowRun.join(",")}`,
  ];

  // Project cwd is read-only: must never appear in allowWrite.
  if (allowWrite.some((root) => projectCwd === root || projectCwd.startsWith(`${root}/`))) {
    throw new IngressError(
      "path_invalid",
      "project cwd must not be writable by the service",
      EXIT.CONFIG,
    );
  }

  return {
    allowRead,
    allowWrite,
    allowRun,
    codexHome,
    stateRoot,
    denoArgs,
    deniedExamples: {
      unrelatedHomeFile: `${homeDir}/.ssh/id_rsa`,
      unrelatedProjectFile: `${parentDir(projectCwd)}/unrelated-secrets.env`,
      secretEnvKeys: [
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "ANTHROPIC_API_KEY",
        "AGENT_MAIL_BEARER_TOKEN",
      ],
    },
  };
}

/** Build the private App Server environment from an allowlist only. */
export function buildAppServerEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
  options: { pathDirs?: string[]; codexBin?: string } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of APP_SERVER_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  // Never pass linker injection vars even if somehow allowlisted later.
  delete out.LD_PRELOAD;
  delete out.LD_LIBRARY_PATH;
  delete out.DYLD_INSERT_LIBRARIES;

  if (options.codexBin) {
    out.CODEX_BIN = options.codexBin;
  }
  if (options.pathDirs?.length) {
    const existing = (out.PATH ?? "").split(":").filter(Boolean);
    out.PATH = uniquePreserve([...options.pathDirs, ...existing]).join(":");
  }
  return out;
}

/** True when a candidate path is outside every allowRead prefix. */
export function isPathDenied(candidate: string, allowRead: string[]): boolean {
  const abs = assertAbsolute(candidate, "candidate");
  return !allowRead.some((root) => abs === root || abs.startsWith(`${root}/`));
}

export function formatDenoPermissionArgs(permissions: ServicePermissions): string {
  return permissions.denoArgs.join(" ");
}
