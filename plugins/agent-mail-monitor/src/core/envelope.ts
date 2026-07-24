// Versioned JSON envelope for QUERY / INTROSPECTION commands (doctor,
// capabilities, schema, product dumps) under `--json`.
//
// This is deliberately NOT what the watch loop emits. The watch loop prints
// HUMAN notification lines to stdout ("MAIL #<id> from …") because the Monitor
// host turns each stdout line into one notification. Two distinct surfaces:
//   - watch loop        -> human lines on stdout (notification stream)
//   - query/introspect  -> this envelope on stdout under --json
// Keep them separate, or a future reader will "fix" the watch loop to emit
// JSON and break every notification.

export const SCHEMA_VERSION = 1;

export interface EnvelopeMeta {
  command: string;
  [k: string]: unknown;
}

export interface OkEnvelope<T> {
  schemaVersion: number;
  ok: true;
  data: T;
  meta: EnvelopeMeta;
}

export interface ErrEnvelope {
  schemaVersion: number;
  ok: false;
  error: { code: number; name: string; message: string };
  meta: EnvelopeMeta;
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export function ok<T>(
  command: string,
  data: T,
  meta: Record<string, unknown> = {},
): OkEnvelope<T> {
  return { schemaVersion: SCHEMA_VERSION, ok: true, data, meta: { command, ...meta } };
}

export function err(
  command: string,
  code: number,
  name: string,
  message: string,
  meta: Record<string, unknown> = {},
): ErrEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code, name, message },
    meta: { command, ...meta },
  };
}

export function printEnvelope(env: Envelope<unknown>): void {
  console.log(JSON.stringify(env, null, 2));
}
