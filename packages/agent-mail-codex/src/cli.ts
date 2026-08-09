#!/usr/bin/env -S deno run --allow-read --allow-env --allow-write --allow-ffi --allow-run

/**
 * agent-mail-codex — production Codex ingress CLI.
 * run: private App Server + production IngressKernel (O3 follow-up).
 * run --shadow: R1 observation + Claude-monitor compare; no Codex delivery.
 * doctor/status: read-only probes.
 */

import { loadConfigFile, requireBinding } from "./config.ts";
import { EXIT, IngressError } from "./errors.ts";
import { resolveFeatureFlags } from "./flags.ts";
import { FsMailboxSource, slugForProject } from "./mailbox/mod.ts";
import { inspectLiveStatus } from "./operator/live_status.ts";
import { LiveOwnershipCommands, UnixLiveOwnershipClient } from "./operator/live_ownership.ts";
import {
  formatOwnershipResult,
  OwnershipCommandError,
  type OwnerStateStore,
  type PersistedOwnerState,
} from "./operator/ownership_commands.ts";
import { CodexBinError, resolveNativeCodexBin } from "./operator/codex_bin.ts";
import { runProductionIngress } from "./operator/production_run.ts";
import {
  APP_SERVER_ENV_ALLOWLIST,
  buildAppServerEnv,
  computeServicePermissions,
} from "./operator/service_permissions.ts";
import { renderStatusHuman } from "./operator/status.ts";
import { resolveRuntimePaths } from "./operator/supervisor.ts";
import { SystemClock } from "./retry/mod.ts";
import { SqliteDurableStateStore } from "./store/mod.ts";
import { encodeShadowGateArtifact, runShadowObservation } from "./verification/shadow.ts";

function usage(): string {
  return `agent-mail-codex — Codex Agent Mail ingress

Usage:
  agent-mail-codex run --config <path> --binding <name> [--shadow]
  agent-mail-codex doctor --config <path> --binding <name>
  agent-mail-codex status --config <path> [--binding <name>] [--json]
  agent-mail-codex permissions --config <path> --binding <name> [--json|--shell]
  agent-mail-codex binding release-owner <binding> --to human [--request-id <id>] [--json]
  agent-mail-codex binding acquire-owner <binding> --owner headless --thread <id> [--request-id <id>] [--json]
  agent-mail-codex --help

Exit codes:
  0    ok / clean production or shadow shutdown
  1    runtime failure (lease/ownership/kernel); also shadow compare failure
  2    usage / bad arguments
  4    invalid or missing config / binding / path
  5    invalid adapter or ownership selection
  127  missing dependency (codex / deno tools)

Feature flags (env, resolved once at startup):
  CODEX_INGRESS_ENABLED
  CODEX_INGRESS_ADAPTER=headless-owner|gateway-owner-spike|exec-resume-spike
  CODEX_INGRESS_OWNERSHIP=exclusive-headless|explicit-handoff
  CODEX_INGRESS_URGENT_STEER
  CODEX_INGRESS_DETERMINISTIC_COLLAPSE
  CODEX_INGRESS_METRICS_HTTP
  CODEX_BIN                       absolute native Codex ELF (required; never a PATH npx wrapper)
  CODEX_INGRESS_SHADOW=1          same as run --shadow (R1)

Does not read MAIL_WATCH_* (Claude monitor).
run spawns a private codex app-server and drives createProductionKernel.
run --shadow observes + batches with delivery off; compares to a second mailbox
scan (Claude-monitor oracle); never calls Codex / never advances delivery cursor.
permissions prints the least-privilege Deno flags + App Server env allowlist (tcp-efp.5.13).
`;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new IngressError("usage", `${name} requires a value`, EXIT.USAGE);
  }
  return value;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(usage());
    return EXIT.OK;
  }

  let flags;
  try {
    flags = resolveFeatureFlags();
  } catch (error) {
    console.error(
      `flag_invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.OWNERSHIP;
  }

  if (command === "binding") {
    return await runBindingCommand(args, flags.adapter === "gateway-owner-spike");
  }

  const configPath = option(args, "--config");
  if (!configPath) {
    console.error("usage: --config <path> is required");
    return EXIT.USAGE;
  }

  const config = await loadConfigFile(configPath);

  if (command === "status") {
    const bindingName = option(args, "--binding");
    const asJson = flag(args, "--json");
    if (bindingName) {
      requireBinding(config, bindingName);
      const report = await inspectLiveStatus({ config, bindingName });
      console.log(asJson ? JSON.stringify(report, null, 2) : renderStatusHuman(report));
      return report.healthy ? EXIT.OK : EXIT.FAILURE;
    }
    const reports = await Promise.all(
      Object.keys(config.bindings).sort().map((name) =>
        inspectLiveStatus({ config, bindingName: name })
      ),
    );
    console.log(
      asJson
        ? JSON.stringify({ schemaVersion: 1, reports }, null, 2)
        : reports.map(renderStatusHuman).join("\n\n"),
    );
    return reports.every((report) => report.healthy) ? EXIT.OK : EXIT.FAILURE;
  }

  if (command === "doctor" || command === "run" || command === "permissions") {
    const bindingName = option(args, "--binding");
    if (!bindingName) {
      console.error("usage: --binding <name> is required");
      return EXIT.USAGE;
    }
    const binding = requireBinding(config, bindingName);

    if (command === "permissions") {
      return await runPermissionsCommand({
        config,
        configPath,
        bindingName,
        binding,
        asJson: flag(args, "--json"),
        asShell: flag(args, "--shell"),
      });
    }

    if (command === "doctor") {
      const report = await inspectLiveStatus({ config, bindingName });
      console.log(renderStatusHuman(report));
      console.log(
        `Delivery flag: ${flags.enabled ? "enabled" : "disabled (safe default)"}`,
      );
      return report.healthy ? EXIT.OK : EXIT.FAILURE;
    }

    const shadowRequested = flag(args, "--shadow") ||
      Deno.env.get("CODEX_INGRESS_SHADOW") === "1" ||
      Deno.env.get("CODEX_INGRESS_SHADOW")?.toLowerCase() === "true";

    // run: private App Server + production kernel (O3 follow-up).
    // run --shadow: R1 observation gate — delivery must stay off.
    const controller = new AbortController();
    const stop = () => controller.abort();
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
    try {
      if (shadowRequested) {
        return await runShadowCommand({
          config,
          bindingName,
          binding,
          flagsEnabled: flags.enabled,
          signal: controller.signal,
        });
      }
      if (!flags.enabled) {
        console.error(
          "run_refused: CODEX_INGRESS_ENABLED=false; production delivery remains disabled",
        );
        return EXIT.OWNERSHIP;
      }
      const result = await runProductionIngress({
        config,
        bindingName,
        signal: controller.signal,
      });
      return result.ok ? EXIT.OK : EXIT.FAILURE;
    } finally {
      try {
        Deno.removeSignalListener("SIGTERM", stop);
        Deno.removeSignalListener("SIGINT", stop);
      } catch {
        // Listener cleanup is best-effort on exotic runtimes.
      }
    }
  }

  console.error(`unknown command: ${command}`);
  console.error(usage());
  return EXIT.USAGE;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function runPermissionsCommand(options: {
  config: Awaited<ReturnType<typeof loadConfigFile>>;
  configPath: string;
  bindingName: string;
  binding: ReturnType<typeof requireBinding>;
  asJson: boolean;
  asShell: boolean;
}): Promise<number> {
  if (options.binding.mailScope.kind !== "project") {
    console.error("permissions_refused: project mailScope required");
    return EXIT.CONFIG;
  }
  const home = Deno.env.get("HOME");
  if (!home?.startsWith("/")) {
    console.error("permissions_refused: HOME must be an absolute path");
    return EXIT.CONFIG;
  }
  const packageRoot = Deno.env.get("AGENT_MAIL_CODEX_ROOT") ??
    parentDir(parentDir(new URL(import.meta.url).pathname));
  const paths = resolveRuntimePaths(options.config, options.bindingName);
  let codexBin: string;
  try {
    codexBin = await resolveNativeCodexBin();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`permissions_refused: ${message}`);
    return error instanceof CodexBinError ? error.exitCode : EXIT.DEPENDENCY;
  }
  try {
    const permissions = await computeServicePermissions({
      packageRoot,
      configPath: options.configPath,
      statePath: paths.statePath,
      mailboxRoot: paths.mailboxRoot,
      codexBin,
      projectCwd: options.binding.codex.cwd,
      homeDir: home,
      tmpDir: Deno.env.get("TMPDIR") ?? "/tmp",
      requireExists: true,
    });
    for (const arg of permissions.denoArgs) {
      if (
        arg === "--allow-read" || arg === "--allow-write" ||
        arg === "--allow-env" || arg === "--allow-run"
      ) {
        console.error(`permissions_refused: bare flag ${arg}`);
        return EXIT.CONFIG;
      }
    }
    const childEnv = buildAppServerEnv(Deno.env.toObject(), { codexBin });
    if (options.asShell) {
      for (const arg of permissions.denoArgs) console.log(arg);
      return EXIT.OK;
    }
    const report = {
      schemaVersion: 1,
      binding: options.bindingName,
      denoArgs: permissions.denoArgs,
      allowRead: permissions.allowRead,
      allowWrite: permissions.allowWrite,
      allowRun: permissions.allowRun,
      appServerEnvAllowlist: [...APP_SERVER_ENV_ALLOWLIST],
      appServerEnvKeysPresent: Object.keys(childEnv).sort(),
      deniedExamples: permissions.deniedExamples,
    };
    if (options.asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`binding: ${options.bindingName}`);
      console.log(`denoArgs:\n  ${permissions.denoArgs.join("\n  ")}`);
      console.log(`appServerEnvAllowlist: ${APP_SERVER_ENV_ALLOWLIST.join(",")}`);
      console.log(`deny read example: ${permissions.deniedExamples.unrelatedHomeFile}`);
    }
    return EXIT.OK;
  } catch (error) {
    console.error(
      `permissions_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.CONFIG;
  }
}

async function runShadowCommand(options: {
  config: Awaited<ReturnType<typeof loadConfigFile>>;
  bindingName: string;
  binding: ReturnType<typeof requireBinding>;
  flagsEnabled: boolean;
  signal: AbortSignal;
}): Promise<number> {
  if (options.flagsEnabled) {
    console.error(
      "shadow_refused: CODEX_INGRESS_ENABLED=true; R1 requires delivery flag off",
    );
    return EXIT.OWNERSHIP;
  }
  if (options.binding.mailScope.kind !== "project") {
    console.error("shadow_refused: R1 shadow supports project mailScope only");
    return EXIT.CONFIG;
  }
  if (options.binding.codex.adapter !== "headless-app-server-owner") {
    console.error(
      `shadow_refused: adapter ${options.binding.codex.adapter}; headless-app-server-owner only`,
    );
    return EXIT.OWNERSHIP;
  }

  const mailboxRoot = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT") ??
    `${Deno.env.get("HOME")}/.mcp_agent_mail_git_mailbox_repo`;
  if (!mailboxRoot.startsWith("/")) {
    console.error("shadow_refused: AGENT_MAIL_MAILBOX_ROOT must be absolute");
    return EXIT.CONFIG;
  }

  const mailbox = new FsMailboxSource({ root: mailboxRoot });
  // Second independent scan over the same root = Claude-monitor oracle.
  const referenceMailbox = new FsMailboxSource({ root: mailboxRoot });
  const store = new SqliteDurableStateStore({ path: options.config.statePath });
  const projectPath = options.binding.mailScope.projectPath;
  const projectSlug = slugForProject(projectPath);
  const reportDir = `${parentDir(options.config.statePath)}/shadow`;
  await Deno.mkdir(reportDir, { recursive: true });
  const reportPath = `${reportDir}/${options.bindingName}.json`;

  console.log(JSON.stringify({
    ok: true,
    event: "shadow.started",
    bindingId: options.bindingName,
    deliveryEnabled: false,
    mailboxRoot,
    reportPath,
  }));

  try {
    const result = await runShadowObservation({
      store,
      mailbox,
      referenceMailbox,
      clock: new SystemClock(),
      binding: {
        bindingId: options.bindingName,
        agent: options.binding.agent,
        configHash: "cli-shadow",
        adapter: options.binding.codex.adapter,
        projectSlug,
        projectPath,
        threadId: options.binding.codex.threadId ?? null,
      },
      signal: options.signal,
      batchWindowMs: options.binding.delivery.batchWindowMs,
      pollIntervalMs: 1_000,
      // Mid-poll compare races a second FS scan; gate on final compare only.
      compareEachPoll: false,
    });
    const artifact = encodeShadowGateArtifact(result);
    await Deno.writeTextFile(reportPath, artifact);
    console.log(JSON.stringify({
      ok: result.ok,
      event: "shadow.finished",
      reason: result.reason,
      reportPath,
      compare: result.compare,
      deliveryCursor: result.deliveryCursor,
      modelCalls: result.modelCalls,
    }));
    return result.ok ? EXIT.OK : EXIT.FAILURE;
  } finally {
    await store.close().catch(() => {});
  }
}

class FileOwnerStateStore implements OwnerStateStore {
  constructor(private readonly dir: string) {}

  async load(bindingId: string): Promise<PersistedOwnerState | null> {
    try {
      const text = await Deno.readTextFile(`${this.dir}/${bindingId}.json`);
      return JSON.parse(text) as PersistedOwnerState;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  async save(state: PersistedOwnerState): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = `${this.dir}/${state.bindingId}.json`;
    const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(
        tmp,
        `${JSON.stringify(state, null, 2)}\n`,
        { create: true, mode: 0o600 },
      );
      await Deno.chmod(tmp, 0o600);
      await Deno.rename(tmp, path);
    } catch (error) {
      await Deno.remove(tmp).catch(() => {});
      throw error;
    }
  }
}

async function runBindingCommand(args: string[], gatewaySelected: boolean): Promise<number> {
  const [action, bindingId, ...rest] = args;
  if (!action || !bindingId) {
    console.error(
      "usage: agent-mail-codex binding release-owner|acquire-owner <binding> ...",
    );
    return EXIT.USAGE;
  }
  const configPath = option(rest, "--config");
  if (!configPath) {
    console.error("usage: --config <path> is required");
    return EXIT.USAGE;
  }
  const config = await loadConfigFile(configPath);
  requireBinding(config, bindingId);
  const stateDir = option(rest, "--state-dir") ??
    `${parentDir(config.statePath)}/owner-state`;
  const socketPath = option(rest, "--control-socket") ??
    `${parentDir(config.statePath)}/runtime/${bindingId}.ownership.sock`;
  const requestId = option(rest, "--request-id") ?? crypto.randomUUID();
  const asJson = flag(rest, "--json");
  const cmds = new LiveOwnershipCommands({
    client: new UnixLiveOwnershipClient(socketPath),
    store: new FileOwnerStateStore(stateDir),
  });
  if (gatewaySelected) {
    console.error(
      "gateway_not_applicable: gateway ownership not selected for v1",
    );
    return EXIT.OWNERSHIP;
  }

  try {
    if (action === "release-owner") {
      const to = option(rest, "--to");
      if (to !== "human") {
        console.error("usage: --to human is required");
        return EXIT.USAGE;
      }
      const result = await cmds.releaseOwnerToHuman(bindingId, requestId);
      console.log(asJson ? JSON.stringify(result, null, 2) : formatOwnershipResult(result));
      return EXIT.OK;
    }
    if (action === "acquire-owner") {
      const owner = option(rest, "--owner");
      const threadId = option(rest, "--thread");
      if (owner !== "headless" || !threadId) {
        console.error("usage: --owner headless --thread <id> are required");
        return EXIT.USAGE;
      }
      const result = await cmds.acquireOwnerHeadless(
        bindingId,
        requestId,
        threadId,
      );
      console.log(asJson ? JSON.stringify(result, null, 2) : formatOwnershipResult(result));
      return EXIT.OK;
    }
    console.error(`unknown binding action: ${action}`);
    return EXIT.USAGE;
  } catch (error) {
    if (error instanceof OwnershipCommandError) {
      console.error(`${error.code}: ${error.message}`);
      return error.code === "usage" || error.code === "not_found" ? EXIT.USAGE : EXIT.OWNERSHIP;
    }
    throw error;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    if (error instanceof IngressError) {
      console.error(`${error.code}: ${error.message}`);
      Deno.exit(error.exitCode);
    }
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(EXIT.FAILURE);
  }
}

export { main };
