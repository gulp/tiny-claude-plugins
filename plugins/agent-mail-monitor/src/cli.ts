#!/usr/bin/env -S deno run --allow-run=am --allow-env --allow-read
// agent-mail — a thin, read-only wrapper over the Agent Mail `am` CLI.
//
// Foundation scaffold (tcp-6yk.9): Commander skeleton + global flags, one
// AbortController driving graceful SIGINT/SIGTERM shutdown, and the
// watch / monitor / doctor commands. `am` is the capability CLI; this layer owns
// only the watch loop, envelopes, and (later) product mode + introspection.

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { resolveScopeSlugs, runWatch } from "./commands/watch.ts";
import { runProductWatch } from "./commands/product.ts";
import { resolveSlugs, runShadow } from "./commands/shadow.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runMessage } from "./commands/message.ts";
import { runCapabilities, runSchema } from "./commands/introspect.ts";
import {
  defaultMailboxRoot,
  isMailWatchScope,
  type MailWatchScope,
  slugForProject,
} from "./core/mailbox.ts";
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
function parseLimit(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    throw new InvalidArgumentError("must be a positive integer (>= 1)");
  }
  return Number(v);
}

interface WatchCmdOpts {
  agent: string;
  project?: string;
  root?: string;
  since?: number;
  interval: number;
}

interface ProductCmdOpts {
  agent: string;
  product?: string;
  limit: number;
  interval: number;
}

interface ShadowCmdOpts {
  agent: string;
  project?: string;
  slugs?: string;
  root?: string;
  confirm: number;
  interval: number;
}

function resolveProject(explicit: string | undefined, globalCwd: string | undefined): string {
  return explicit ?? globalCwd ?? Deno.env.get("CLAUDE_PROJECT_DIR") ?? Deno.cwd();
}

// $MAIL_WATCH_SCOPE (tcp-p0x.16.2) — env-only, read by the `monitor` entrypoint
// (mirrors AGENT_MAIL_PRODUCT / MAIL_POLL_INTERVAL, both already env-driven
// there). The explicit `watch` subcommand stays flag-driven and single-project;
// it never reads this var, so it has nothing new to regress. Unset defaults to
// "project" — byte-identical to pre-tcp-p0x.16.2 behavior. An invalid value
// fails LOUD (stdout + non-zero exit), never a silent fallback to "project".
function resolveWatchScopeEnv(): MailWatchScope {
  const raw = Deno.env.get("MAIL_WATCH_SCOPE") ?? "project";
  if (!isMailWatchScope(raw)) {
    console.log(
      `agent-mail-monitor: MAIL_WATCH_SCOPE='${raw}' is invalid — must be one of: project, all, product.`,
    );
    Deno.exit(ExitCode.USAGE);
  }
  return raw;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("agent-mail")
    .description(
      "Watch/monitor + query wrapper over the Agent Mail `am` CLI. All commands are genuinely non-consuming: watch/monitor (single project) and shadow tail the on-disk git-mailbox, product tails the product bus, and shadow's SQLite cross-check opens the store read-only — none marks mail read. `am check-inbox`, the one consuming path, has been retired from every notification path (tcp-p0x.16.4).",
    )
    .option("--json", "emit versioned JSON envelopes for query/introspection commands", false)
    .option("--output <fmt>", "output format for query commands (json|human)", "human")
    .option("--cwd <path>", "project directory (default: $CLAUDE_PROJECT_DIR or cwd)")
    .exitOverride(); // throw CommanderError instead of calling Deno.exit under us

  program
    .command("watch")
    .description(
      "Emit one stdout line per NEW message for --agent. Tails the durable git-mailbox on disk — read-only, never marks mail read (single project; see the `product` command for cross-project).",
    )
    .requiredOption("--agent <name>", "Agent Mail identity to watch")
    .option("--project <path>", "project key (default: --cwd or $PWD)")
    .option(
      "--root <path>",
      "mailbox repo root (default: $AGENT_MAIL_MAILBOX_ROOT or ~/.mcp_agent_mail_git_mailbox_repo)",
    )
    .option(
      "--since <id>",
      "emit messages with id > ID (replays existing above ID once)",
      parseSince,
    )
    .option("--interval <sec>", "seconds between polls (>= 1)", parseInterval, 30)
    .action(async (opts: WatchCmdOpts) => {
      const g = program.opts();
      const project = resolveProject(opts.project, g.cwd);
      const code = await runWatch({
        agent: opts.agent,
        root: opts.root ?? defaultMailboxRoot(),
        slugs: [slugForProject(project)],
        since: opts.since,
        interval: opts.interval,
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  // product — cross-project bus watch. Frontier is created_ts, lines are labelled
  // with their origin project. Product key from --product or $AGENT_MAIL_PRODUCT.
  program
    .command("product")
    .description(
      "Emit one stdout line per NEW message for --agent across a product bus (read-only).",
    )
    .requiredOption("--agent <name>", "Agent Mail identity to watch")
    .option("--product <key>", "product key (default: $AGENT_MAIL_PRODUCT)")
    .option("--limit <n>", "messages fetched per poll (>= 1)", parseLimit, 200)
    .option("--interval <sec>", "seconds between polls (>= 1)", parseInterval, 30)
    .action(async (opts: ProductCmdOpts) => {
      const productKey = opts.product ?? Deno.env.get("AGENT_MAIL_PRODUCT") ?? "";
      if (!productKey) {
        console.error(
          "agent-mail: product mode needs a product key — pass --product <key> or set $AGENT_MAIL_PRODUCT.",
        );
        Deno.exit(ExitCode.USAGE);
      }
      const code = await runProductWatch({
        productKey,
        agent: opts.agent,
        interval: opts.interval,
        limit: opts.limit,
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  // shadow — PROTOTYPE. Tail the durable git-mailbox (canonical) and cross-check
  // it against a direct, genuinely-read-only `node:sqlite` open (tcp-p0x.16.5;
  // no `am`/check-inbox call involved): emit new canonical mail AND a loud
  // DIVERGENCE line for any canonical message SQLite never corroborates. Arm
  // next to the normal watch to see whether the filesystem store catches what
  // SQLite drops.
  program
    .command("shadow")
    .description(
      "PROTOTYPE: tail the durable git-mailbox and flag mail SQLite hasn't caught up on yet (read-only).",
    )
    .requiredOption("--agent <name>", "Agent Mail identity to tail")
    .option(
      "--project <path>",
      "primary project for the SQLite desync cross-check (default: --cwd/$PWD)",
    )
    .option(
      "--slugs <csv>",
      "comma-separated project slugs to tail (default: derived from --project)",
    )
    .option(
      "--root <path>",
      "mailbox repo root (default: $AGENT_MAIL_MAILBOX_ROOT or ~/.mcp_agent_mail_git_mailbox_repo)",
    )
    .option(
      "--confirm <n>",
      "ok ticks a message may lag in SQLite before DIVERGENCE (>= 1)",
      parseLimit,
      3,
    )
    .option("--interval <sec>", "seconds between polls (>= 1)", parseInterval, 30)
    .action(async (opts: ShadowCmdOpts) => {
      const g = program.opts();
      const project = resolveProject(opts.project, g.cwd);
      const code = await runShadow({
        agent: opts.agent,
        root: opts.root ?? defaultMailboxRoot(),
        slugs: resolveSlugs(opts.slugs, project),
        project,
        primarySlug: slugForProject(project),
        confirm: opts.confirm,
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
    .description(
      "Monitor entrypoint: read AGENT_NAME / CLAUDE_PROJECT_DIR / MAIL_POLL_INTERVAL / MAIL_WATCH_SCOPE from env, then watch.",
    )
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
      // $AGENT_MAIL_PRODUCT set -> watch the cross-project SQLite product bus
      // (existing path, unrelated to MAIL_WATCH_SCOPE — that env only scopes
      // the FS backend's slug set below, and is not consulted here).
      const product = Deno.env.get("AGENT_MAIL_PRODUCT");
      if (product) {
        const code = await runProductWatch({
          productKey: product,
          agent,
          interval: Number(rawInterval),
          signal: shutdown.signal,
        });
        Deno.exit(code);
      }

      // FS backend — MAIL_WATCH_SCOPE picks the slug set. Default "project" is
      // exactly [projectSlug], byte-identical to pre-tcp-p0x.16.2 behavior.
      const scope = resolveWatchScopeEnv();
      const root = defaultMailboxRoot();
      const projectSlug = slugForProject(resolveProject(undefined, g.cwd));
      let slugs: string[];
      try {
        slugs = await resolveScopeSlugs({
          scope,
          root,
          agent,
          projectSlug,
          productKey: Deno.env.get("AGENT_MAIL_PRODUCT") ?? undefined,
        });
      } catch (e) {
        if (e instanceof AppError) {
          console.log(`agent-mail-monitor: ${e.message}`);
          Deno.exit(e.code);
        }
        throw e;
      }
      const code = await runWatch({
        agent,
        root,
        slugs,
        interval: Number(rawInterval),
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  program
    .command("doctor")
    .description(
      "Read-only preflight: deno + am presence, identity, and (in product mode) registration in every linked project.",
    )
    .action(async () => {
      const g = program.opts();
      const code = await runDoctor({ json: Boolean(g.json) || g.output === "json" });
      Deno.exit(code);
    });

  // capabilities — describe the command surface + exit-code contract (envelope).
  program
    .command("capabilities")
    .description(
      "Emit the command surface, exit-code contract, and active mode as a JSON envelope.",
    )
    .action(async () => {
      Deno.exit(await runCapabilities());
    });

  // message <id> — resolve a globally-unique message id across projects in one
  // read-only command (tcp-p0x.1). Human block by default; --json/--output json
  // emits the versioned envelope. --product scopes the fan-out to a product bus.
  program
    .command("message")
    .argument("<id>", "globally-unique Agent Mail message id to resolve")
    .description(
      "Resolve a message id across projects and print it (read-only; --product scopes to a product bus).",
    )
    .option("--product <key>", "scope the search to a product bus (default: $AGENT_MAIL_PRODUCT)")
    .action(async (id: string, opts: { product?: string }) => {
      const g = program.opts();
      const code = await runMessage({
        id,
        product: opts.product ?? Deno.env.get("AGENT_MAIL_PRODUCT") ?? undefined,
        json: Boolean(g.json) || g.output === "json",
        signal: shutdown.signal,
      });
      Deno.exit(code);
    });

  // schema <command> — emit the JSON Schema for a command's --json envelope.
  program
    .command("schema")
    .argument(
      "<command>",
      "command whose --json envelope schema to emit (doctor|message|capabilities|schema)",
    )
    .description("Emit the JSON Schema for a command's --json envelope.")
    .action((command: string) => {
      Deno.exit(runSchema(command));
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
