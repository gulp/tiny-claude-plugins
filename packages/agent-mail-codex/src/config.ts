/** Validated config loader for agent-mail-codex (F1). */

import { EXIT, fail } from "./errors.ts";

export type MailScope =
  | { kind: "project"; projectPath: string }
  | { kind: "product"; productKey: string };

export type ConfigAdapter =
  | "headless-app-server-owner"
  | "gateway-app-server-owner"
  | "exec-resume-adapter"
  | "native-monitor-owner";

export type ConfigOwnership = "exclusive-headless" | "explicit-handoff";

export interface BindingConfig {
  agent: string;
  mailScope: MailScope;
  codex: {
    adapter: ConfigAdapter;
    ownership: ConfigOwnership;
    threadId?: string;
    cwd: string;
    transport: { kind: "private-stdio" | "unix-socket"; path?: string };
  };
  delivery: {
    batchWindowMs: number;
    maxEvents: number;
    maxBytes: number;
    urgentDuringTurn: "steer" | "queue";
    routineDuringTurn: "queue";
  };
}

export interface IngressConfig {
  schemaVersion: 1;
  statePath: string;
  bindings: Record<string, BindingConfig>;
}

const ADAPTERS: ConfigAdapter[] = [
  "headless-app-server-owner",
  "gateway-app-server-owner",
  "exec-resume-adapter",
  "native-monitor-owner",
];
const OWNERSHIPS: ConfigOwnership[] = ["exclusive-headless", "explicit-handoff"];
const BINDING_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DELIVERY_LIMITS = {
  batchWindowMs: { min: 1, max: 60_000 },
  maxEvents: { min: 1, max: 1_000 },
  maxBytes: { min: 1, max: 1024 * 1024 },
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail("config_invalid", `${ctx}: ${key} must be a non-empty string`, EXIT.CONFIG);
  }
  return value;
}

function requireAbsolutePath(path: string, label: string): string {
  if (!path.startsWith("/")) {
    fail("path_invalid", `${label} must be an absolute path: ${path}`, EXIT.CONFIG);
  }
  return path;
}

function requirePositiveInteger(
  value: unknown,
  fallback: number,
  field: keyof typeof DELIVERY_LIMITS,
  ctx: string,
): number {
  const resolved = value ?? fallback;
  const { min, max } = DELIVERY_LIMITS[field];
  if (
    typeof resolved !== "number" ||
    !Number.isFinite(resolved) ||
    !Number.isSafeInteger(resolved) ||
    resolved < min ||
    resolved > max
  ) {
    fail(
      "config_invalid",
      `${ctx}.${field} must be an integer in [${min},${max}]`,
      EXIT.CONFIG,
    );
  }
  return resolved;
}

function parseScope(raw: unknown, ctx: string): MailScope {
  if (!isObject(raw)) fail("scope_invalid", `${ctx}: mailScope must be an object`, EXIT.CONFIG);
  const kind = raw.kind;
  if (kind === "project") {
    return {
      kind: "project",
      projectPath: requireAbsolutePath(
        requireString(raw, "projectPath", ctx),
        `${ctx}.mailScope.projectPath`,
      ),
    };
  }
  if (kind === "product") {
    requireString(raw, "productKey", ctx);
    fail(
      "scope_invalid",
      `${ctx}: product mailScope is not supported by the v1 production kernel`,
      EXIT.CONFIG,
    );
  }
  fail("scope_invalid", `${ctx}: mailScope.kind must be project|product`, EXIT.CONFIG);
}

function parseBinding(name: string, raw: unknown): BindingConfig {
  const ctx = `bindings.${name}`;
  if (!BINDING_NAME.test(name)) {
    fail(
      "config_invalid",
      `binding name must match ${BINDING_NAME} (got ${JSON.stringify(name)})`,
      EXIT.CONFIG,
    );
  }
  if (!isObject(raw)) fail("config_invalid", `${ctx} must be an object`, EXIT.CONFIG);
  const agent = requireString(raw, "agent", ctx);
  if (!/^[A-Z][a-z]+[A-Z][a-zA-Z]+$/.test(agent)) {
    fail(
      "identity_invalid",
      `${ctx}: agent must look like AdjectiveNoun (got ${agent})`,
      EXIT.CONFIG,
    );
  }
  if (!isObject(raw.codex)) fail("config_invalid", `${ctx}.codex must be an object`, EXIT.CONFIG);
  const adapter = requireString(raw.codex, "adapter", `${ctx}.codex`) as ConfigAdapter;
  if (!ADAPTERS.includes(adapter)) {
    fail("adapter_invalid", `${ctx}: unknown adapter ${adapter}`, EXIT.OWNERSHIP);
  }
  const ownership = requireString(raw.codex, "ownership", `${ctx}.codex`) as ConfigOwnership;
  if (!OWNERSHIPS.includes(ownership)) {
    fail("ownership_invalid", `${ctx}: unknown ownership ${ownership}`, EXIT.OWNERSHIP);
  }
  if (!isObject(raw.codex.transport)) {
    fail("config_invalid", `${ctx}.codex.transport must be an object`, EXIT.CONFIG);
  }
  const transportKind = requireString(raw.codex.transport, "kind", `${ctx}.codex.transport`);
  if (transportKind !== "private-stdio" && transportKind !== "unix-socket") {
    fail("config_invalid", `${ctx}: transport.kind must be private-stdio|unix-socket`, EXIT.CONFIG);
  }
  const transportPath = raw.codex.transport.path;
  if (transportKind === "unix-socket" && typeof transportPath !== "string") {
    fail(
      "path_invalid",
      `${ctx}.codex.transport.path must be an absolute path for unix-socket`,
      EXIT.CONFIG,
    );
  }
  if (!isObject(raw.delivery)) {
    fail("config_invalid", `${ctx}.delivery must be an object`, EXIT.CONFIG);
  }
  const delivery = raw.delivery;
  const urgentDuringTurn = delivery.urgentDuringTurn ?? "queue";
  if (urgentDuringTurn !== "steer" && urgentDuringTurn !== "queue") {
    fail(
      "config_invalid",
      `${ctx}.delivery.urgentDuringTurn must be steer|queue`,
      EXIT.CONFIG,
    );
  }
  return {
    agent,
    mailScope: parseScope(raw.mailScope, ctx),
    codex: {
      adapter,
      ownership,
      threadId: typeof raw.codex.threadId === "string" ? raw.codex.threadId : undefined,
      cwd: requireAbsolutePath(requireString(raw.codex, "cwd", `${ctx}.codex`), `${ctx}.codex.cwd`),
      transport: {
        kind: transportKind,
        path: typeof transportPath === "string"
          ? requireAbsolutePath(transportPath, `${ctx}.codex.transport.path`)
          : undefined,
      },
    },
    delivery: {
      batchWindowMs: requirePositiveInteger(
        delivery.batchWindowMs,
        500,
        "batchWindowMs",
        `${ctx}.delivery`,
      ),
      maxEvents: requirePositiveInteger(
        delivery.maxEvents,
        50,
        "maxEvents",
        `${ctx}.delivery`,
      ),
      maxBytes: requirePositiveInteger(
        delivery.maxBytes,
        32768,
        "maxBytes",
        `${ctx}.delivery`,
      ),
      urgentDuringTurn,
      routineDuringTurn: "queue",
    },
  };
}

export function parseConfig(raw: unknown): IngressConfig {
  if (!isObject(raw)) fail("config_invalid", "config root must be an object", EXIT.CONFIG);
  if (raw.schemaVersion !== 1) {
    fail("config_invalid", `unsupported schemaVersion: ${String(raw.schemaVersion)}`, EXIT.CONFIG);
  }
  const statePath = requireAbsolutePath(
    requireString(raw, "statePath", "config"),
    "statePath",
  );
  if (!isObject(raw.bindings)) {
    fail("config_invalid", "bindings must be an object", EXIT.CONFIG);
  }
  const bindings: Record<string, BindingConfig> = {};
  for (const [name, value] of Object.entries(raw.bindings)) {
    bindings[name] = parseBinding(name, value);
  }
  if (Object.keys(bindings).length === 0) {
    fail("config_invalid", "bindings must contain at least one binding", EXIT.CONFIG);
  }
  return { schemaVersion: 1, statePath, bindings };
}

export async function loadConfigFile(path: string): Promise<IngressConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    fail("config_missing", `cannot read config file: ${path}`, EXIT.CONFIG);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    fail(
      "config_invalid",
      `config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.CONFIG,
    );
  }
  return parseConfig(json);
}

export function requireBinding(config: IngressConfig, name: string): BindingConfig {
  const binding = config.bindings[name];
  if (!binding) {
    fail(
      "binding_missing",
      `unknown binding ${name}; have: ${Object.keys(config.bindings).sort().join(", ")}`,
      EXIT.CONFIG,
    );
  }
  return binding;
}

/** Deterministic resolved view for doctor/status. */
export function resolveBindingView(
  config: IngressConfig,
  bindingName: string,
  flags: Record<string, unknown>,
): Record<string, unknown> {
  const binding = requireBinding(config, bindingName);
  return {
    schemaVersion: config.schemaVersion,
    binding: bindingName,
    statePath: config.statePath,
    agent: binding.agent,
    mailScope: binding.mailScope,
    codex: binding.codex,
    delivery: binding.delivery,
    flags,
  };
}
