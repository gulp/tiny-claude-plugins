// capabilities + schema — read-only introspection. Both emit the standard
// versioned envelope (schemaVersion/ok/data/meta) so a caller can discover what
// this CLI does and the exact shape of what it returns, without running a watch.
//
//   capabilities  -> the command surface, exit-code contract, and active mode
//   schema <cmd>  -> the JSON Schema for a command's --json envelope

import { ok, printEnvelope, SCHEMA_VERSION } from "../core/envelope.ts";
import { ExitCode } from "../core/exit.ts";
import { amPresent } from "../core/am.ts";

// The command surface, described once. `mode` distinguishes the two output
// surfaces the envelope doc warns about: notification lines vs. JSON envelopes.
const COMMANDS = [
  { name: "watch", summary: "watch one project inbox (notification lines)", mode: "notification" },
  {
    name: "product",
    summary: "watch a product bus across projects (notification lines)",
    mode: "notification",
  },
  {
    name: "monitor",
    summary: "Monitor entrypoint: read identity from env, then watch",
    mode: "notification",
  },
  {
    name: "doctor",
    summary: "read-only preflight incl. product registration-gap",
    mode: "envelope",
  },
  {
    name: "message",
    summary: "resolve a message id across projects (read-only query)",
    mode: "envelope",
  },
  { name: "capabilities", summary: "this command surface", mode: "envelope" },
  { name: "schema", summary: "JSON Schema for a command's --json envelope", mode: "envelope" },
] as const;

export type SchemaTarget = (typeof COMMANDS)[number]["name"];
const ENVELOPE_COMMANDS = new Set(["doctor", "message", "capabilities", "schema"]);

export async function runCapabilities(): Promise<number> {
  printEnvelope(
    ok("capabilities", {
      name: "agent-mail",
      schemaVersion: SCHEMA_VERSION,
      productMode: Boolean(Deno.env.get("AGENT_MAIL_PRODUCT")),
      amPresent: await amPresent(),
      commands: COMMANDS,
      exitCodes: ExitCode,
    }),
  );
  return ExitCode.OK;
}

// The envelope's JSON Schema, shared by every --json command. `command` names
// which command's envelope this describes; the wrapper shape is identical for
// all of them (only `data` varies, which we leave open here).
function envelopeJsonSchema(command: string): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `agent-mail ${command} --json envelope`,
    type: "object",
    required: ["schemaVersion", "ok", "meta"],
    properties: {
      schemaVersion: { type: "integer", const: SCHEMA_VERSION },
      ok: { type: "boolean" },
      data: { description: "present when ok=true; command-specific payload" },
      error: {
        type: "object",
        required: ["code", "name", "message"],
        properties: {
          code: { type: "integer" },
          name: { type: "string" },
          message: { type: "string" },
        },
      },
      meta: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string", const: command } },
      },
    },
  };
}

/** Emit the envelope JSON Schema for `target`, itself wrapped in an envelope. */
export function runSchema(target: string): number {
  if (!ENVELOPE_COMMANDS.has(target)) {
    // A watch-family command has no --json envelope (it emits notification
    // lines), so there is no schema to hand back. USAGE, loud.
    console.error(
      `agent-mail: 'schema' takes a command with a --json envelope (${
        [...ENVELOPE_COMMANDS].join(", ")
      }); '${target}' emits notification lines, not an envelope.`,
    );
    return ExitCode.USAGE;
  }
  printEnvelope(ok("schema", { command: target, schema: envelopeJsonSchema(target) }));
  return ExitCode.OK;
}
