#!/usr/bin/env -S deno run --allow-run=am --allow-env --allow-read
// agent-mail — a thin, read-only wrapper over the Agent Mail `am` CLI.
//
// Foundation scaffold (tcp-6yk.9): Commander skeleton + global flags, one
// AbortController driving graceful SIGINT/SIGTERM shutdown, and the
// watch / monitor / doctor commands. `am` is the capability CLI; this layer owns
// only the watch loop, envelopes, and (later) product mode + introspection.

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { runWatch } from "./commands/watch.ts";
import { runDoctor } from "./commands/doctor.ts";
import { AppError, ExitCode } from "./core/exit.ts";

// --- graceful shutdown: one AbortController kills the `am` child AND ends the
// watch loop. SIGTERM listener is unsupported on Windows; targets are Linux/macOS.
const shutdown = new AbortController();
let shuttingDown = false;
function onSignal(name: string): () => void {
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown.abort(new Error(`received ${name}`));
  };
}
Deno.addSignalListener("SIGINT", onSignal("SIGINT"));
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", onSignal("SIGTERM"));
}

// --- option coercers: InvalidArgumentError is Commander's channel for a bad
// option value (it prints the message and, under exitOverride, throws a
// CommanderError we map to USAGE).
function parseInterval(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    throw new InvalidArgumentError("must be a positive integer (>= 1)");
  }
  return Number(v);
}
function parseSince(v: string): number {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError("must be a non-negative integer");
  return Number(v);
}

interface WatchCmdOpts {
  agent: string;
  project?: string;
  since?: number;
  interval: number;
}

function resolveProject(explicit: string | undefined, globalCwd: string | undefined): string {
  return explicit ?? globalCwd ?? Deno.env.get("CLAUDE_PROJECT_DIR") ?? Deno.cwd();
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("agent-mail")
    .description("Read-only wrapper over the Agent Mail `am` CLI (monitor + query).")
    .option("--json", "emit versioned JSON envelopes for query/introspection commands", false)
    .option("--output <fmt>", "output format for query commands (json|human)", "human")
    .option("--cwd <path>", "project directory (default: $CLAUDE_PROJECT_DIR or cwd)")
    .exitOverride(); // throw CommanderError instead of calling Deno.exit under us

  program
    .command("watch")
    .description("Emit one stdout line per NEW message for --agent (read-only).")
    .requiredOption("--agent <name>", "Agent Mail identity to watch")
    .option("--project <path>", "project key (default: --cwd or $PWD)")
    .option("--since <id>", "emit messages with id > ID (replays existing above ID once)", parseSince)
    .option("--interval <sec>", "seconds between polls (>= 1)", parseInterval, 30)
    .action(async (opts: WatchCmdOpts) => {
      const g = program.opts();
      const code = await runWatch({
        agent: opts.agent,
        project: resolveProject(opts.project, g.cwd),
        since: opts.since,
        interval: opts.interval,
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  // monitor — the Monitor entrypoint (replaces mail-monitor.sh). Reads identity
  // from the ENV because the Monitor host only substitutes its own allowlisted
  // vars into the command string, not arbitrary ones like $AGENT_NAME.
  program
    .command("monitor")
    .description("Monitor entrypoint: read AGENT_NAME / CLAUDE_PROJECT_DIR / MAIL_POLL_INTERVAL from env, then watch.")
    .action(async () => {
      const g = program.opts();
      const agent = Deno.env.get("AGENT_NAME") ?? "";
      if (!agent) {
        // Loud on stdout (the only stream a Monitor surfaces), non-zero exit.
        console.log(
          "agent-mail-monitor: AGENT_NAME unset — NOT watching any inbox (idle). No mail will be reported.",
        );
        console.log(
          "agent-mail-monitor: fix — relaunch with an identity, e.g.  AGENT_NAME=YourName claude  (or run the agent-mail-monitor:doctor skill).",
        );
        Deno.exit(ExitCode.NO_IDENTITY);
      }
      const rawInterval = Deno.env.get("MAIL_POLL_INTERVAL") ?? "30";
      if (!/^\d+$/.test(rawInterval) || Number(rawInterval) < 1) {
        console.log(
          `agent-mail-monitor: MAIL_POLL_INTERVAL='${rawInterval}' is not a positive integer — cannot start.`,
        );
        Deno.exit(ExitCode.USAGE);
      }
      const code = await runWatch({
        agent,
        project: resolveProject(undefined, g.cwd),
        interval: Number(rawInterval),
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  program
    .command("doctor")
    .description("Read-only preflight: deno + am presence, identity (full check set in a later release).")
    .action(async () => {
      const g = program.opts();
      const code = await runDoctor({ json: Boolean(g.json) || g.output === "json" });
      Deno.exit(code);
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(Deno.args, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      // exitOverride: help/version print then throw with exitCode 0.
      Deno.exit(e.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE);
    }
    if (e instanceof AppError) {
      console.error(`agent-mail: ${e.message}`);
      Deno.exit(e.code);
    }
    console.error(
      `agent-mail: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    Deno.exit(ExitCode.INTERNAL);
  }
}

if (import.meta.main) {
  await main();
}
