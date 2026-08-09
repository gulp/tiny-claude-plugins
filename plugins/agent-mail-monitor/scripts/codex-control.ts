#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * Codex plugin control CLI (O7) — thin wrapper over the package control API.
 * Skills must call this script (or agent-mail-codex) rather than inventing paths.
 */

import {
  CONTROL_API_VERSION,
  dispatchControl,
  formatControlResult,
  PLUGIN_IDENTITY,
  type ControlAction,
  type ControlRequest,
} from "../../../packages/agent-mail-codex/src/operator/control.ts";
import type { RuntimeSnapshot } from "../../../packages/agent-mail-codex/src/operator/supervisor.ts";

function usage(): string {
  return `codex-control — Agent Mail Codex production control surface (O7)

Usage:
  codex-control <action> --binding <name> [options]

Actions:
  start | stop | status | doctor | inspect | handoff | acquire | recovery-preview

Options:
  --binding <name>              required
  --agent <AdjectiveNoun>       required for start; identity never guessed
  --thread <id>                 required for handoff/acquire when not in runtime
  --config <path>               ingress config (recorded in payload)
  --plugin-version <ver>        observed .codex-plugin/plugin.json version
  --plugin-root <path>          observed install/cache root
  --expected-root <path>        expected source root (local installs)
  --runtime <path>              runtime/<binding>.json snapshot
  --unit-active true|false      systemd unit probe result
  --mailbox-exists true|false   canonical mailbox root probe
  --confirm                     required for handoff/acquire
  --json                        machine-readable envelope
  --help

Exit codes:
  0 ok
  2 usage
  4 configuration / version / readiness failure
  5 ownership / confirm required

Control API ${CONTROL_API_VERSION}; expected plugin ${PLUGIN_IDENTITY.expectedVersion}
`;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function boolOption(args: string[], name: string): boolean | null {
  const raw = option(args, name);
  if (raw === undefined) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true|false`);
}

async function loadRuntime(path: string | undefined): Promise<RuntimeSnapshot | null> {
  if (!path) return null;
  try {
    return JSON.parse(await Deno.readTextFile(path)) as RuntimeSnapshot;
  } catch (error) {
    throw new Error(
      `cannot read runtime snapshot ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadPluginVersion(pluginRoot: string | undefined): Promise<string | undefined> {
  if (!pluginRoot) return undefined;
  const manifest = `${pluginRoot}/.codex-plugin/plugin.json`;
  try {
    const json = JSON.parse(await Deno.readTextFile(manifest)) as { version?: string };
    return json.version;
  } catch {
    return undefined;
  }
}

const ACTIONS = new Set<ControlAction>([
  "start",
  "stop",
  "status",
  "doctor",
  "inspect",
  "handoff",
  "acquire",
  "recovery-preview",
]);

async function main(argv: string[]): Promise<number> {
  const [actionRaw, ...args] = argv;
  if (!actionRaw || actionRaw === "-h" || actionRaw === "--help" || actionRaw === "help") {
    console.log(usage());
    return 0;
  }
  if (!ACTIONS.has(actionRaw as ControlAction)) {
    console.error(`unknown action: ${actionRaw}`);
    console.error(usage());
    return 2;
  }

  const bindingId = option(args, "--binding");
  if (!bindingId) {
    console.error("usage: --binding <name> is required");
    return 2;
  }

  const pluginRoot = option(args, "--plugin-root");
  const observedFromRoot = await loadPluginVersion(pluginRoot);
  const runtimePath = option(args, "--runtime");
  const runtimeSnapshot = await loadRuntime(runtimePath);

  const req: ControlRequest = {
    action: actionRaw as ControlAction,
    bindingId,
    agent: option(args, "--agent") ?? runtimeSnapshot?.agent,
    threadId: option(args, "--thread") ?? runtimeSnapshot?.threadId ?? undefined,
    observedPluginVersion: option(args, "--plugin-version") ?? observedFromRoot,
    observedPluginRoot: pluginRoot,
    expectedPluginRoot: option(args, "--expected-root"),
    configPath: option(args, "--config"),
    statePath: runtimeSnapshot?.statePath,
    runtimeSnapshot,
    unitActive: boolOption(args, "--unit-active"),
    mailboxRootExists: boolOption(args, "--mailbox-exists"),
    owner: runtimeSnapshot?.owner,
    confirm: flag(args, "--confirm"),
  };

  const result = dispatchControl(req);
  if (flag(args, "--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatControlResult(result));
  }

  if (result.ok) return 0;
  if (
    result.code === "confirm_required" ||
    result.code === "ownership_blocked" ||
    result.code === "thread_missing"
  ) {
    return 5;
  }
  if (result.code === "usage" || result.code === "identity_missing") return 2;
  return 4;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}

export { main };
