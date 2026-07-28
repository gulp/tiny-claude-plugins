/** O2: content-safe structured operations and in-process metrics. */

export type Operation =
  | "event_observed"
  | "batch_created"
  | "delivery_started"
  | "delivery_accepted"
  | "delivery_dropped"
  | "delivery_retry"
  | "ownership_handoff"
  | "request_received"
  | "request_resolved"
  | "turn_completed";

export interface Correlation {
  bindingId: string;
  eventId?: string;
  batchId?: string;
  requestId?: string;
  turnId?: string;
}

export interface OperationRecord {
  schemaVersion: 1;
  at: string;
  operation: Operation;
  correlation: Correlation;
  outcome: "ok" | "error";
  code: string;
  detail?: Record<string, unknown>;
}

const CONTENT_KEYS = new Set([
  "subject",
  "body",
  "body_md",
  "content",
  "prompt",
  "text",
]);

export function encodeOperationJsonl(record: OperationRecord): string {
  if (!record.correlation.bindingId.trim()) throw new TypeError("bindingId required");
  const safe = redact(record) as unknown as OperationRecord;
  return `${JSON.stringify(safe)}\n`;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number }>;
}

export class IngressMetrics {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #histograms = new Map<string, number[]>();

  increment(name: string, amount = 1): void {
    positiveFinite(amount, "counter amount");
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  gauge(name: string, value: number): void {
    finite(value, "gauge value");
    this.#gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    finite(value, "histogram value");
    const values = this.#histograms.get(name) ?? [];
    values.push(value);
    this.#histograms.set(name, values);
  }

  snapshot(): MetricsSnapshot {
    const histograms: MetricsSnapshot["histograms"] = {};
    for (const [name, values] of this.#histograms) {
      histograms[name] = {
        count: values.length,
        sum: values.reduce((sum, value) => sum + value, 0),
        min: Math.min(...values),
        max: Math.max(...values),
      };
    }
    return {
      counters: Object.fromEntries([...this.#counters].sort()),
      gauges: Object.fromEntries([...this.#gauges].sort()),
      histograms,
    };
  }
}

export interface MetricsEndpointConfig {
  enabled: boolean;
  host?: string;
  port?: number;
}

export function resolveMetricsEndpoint(
  config: MetricsEndpointConfig = { enabled: false },
): { enabled: false } | { enabled: true; host: "127.0.0.1" | "::1"; port: number } {
  if (!config.enabled) return { enabled: false };
  const host = config.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TypeError("metrics endpoint must bind loopback only");
  }
  const port = config.port ?? 9464;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("metrics port must be 1..65535");
  }
  return { enabled: true, host, port };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      CONTENT_KEYS.has(key.toLowerCase()) ? "<redacted>" : redact(item),
    ]),
  );
}

function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
}

function positiveFinite(value: number, field: string): void {
  finite(value, field);
  if (value < 0) throw new TypeError(`${field} must be non-negative`);
}
