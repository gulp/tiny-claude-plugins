/// <reference lib="deno.window" />

import {
  encodeOperationJsonl,
  IngressMetrics,
  type Operation,
  resolveMetricsEndpoint,
} from "../src/operator/observability.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

Deno.test("O2 JSONL correlates event batch request and turn without content", () => {
  const line = encodeOperationJsonl({
    schemaVersion: 1,
    at: "2026-07-29T01:00:00.000Z",
    operation: "delivery_accepted",
    correlation: {
      bindingId: "binding-1",
      eventId: "event-1",
      batchId: "batch-1",
      requestId: "request-1",
      turnId: "turn-1",
    },
    outcome: "ok",
    code: "DELIVERY_ACCEPTED",
    detail: {
      subject: "secret subject",
      nested: { body_md: "secret body", attempt: 2 },
    },
  });
  assert(line.endsWith("\n"));
  const parsed = JSON.parse(line);
  assertEquals(parsed.correlation, {
    bindingId: "binding-1",
    eventId: "event-1",
    batchId: "batch-1",
    requestId: "request-1",
    turnId: "turn-1",
  });
  assertEquals(parsed.detail, {
    subject: "<redacted>",
    nested: { body_md: "<redacted>", attempt: 2 },
  });
  assertEquals(line.includes("secret"), false);
});

Deno.test("O2 every drop retry and handoff is representable visibly", () => {
  const operations: Operation[] = [
    "delivery_dropped",
    "delivery_retry",
    "ownership_handoff",
  ];
  for (const operation of operations) {
    const parsed = JSON.parse(encodeOperationJsonl({
      schemaVersion: 1,
      at: "2026-07-29T01:00:00.000Z",
      operation,
      correlation: { bindingId: "binding-1", batchId: "batch-1" },
      outcome: operation === "delivery_dropped" ? "error" : "ok",
      code: operation.toUpperCase(),
    }));
    assertEquals(parsed.operation, operation);
    assert(parsed.code.length > 0);
  }
});

Deno.test("O2 counters gauges and histograms support rollout gates", () => {
  const metrics = new IngressMetrics();
  metrics.increment("events_observed_total", 10);
  metrics.increment("delivery_retries_total");
  metrics.gauge("queue_depth", 4);
  metrics.gauge("active_bindings", 20);
  metrics.observe("wake_latency_ms", 80);
  metrics.observe("wake_latency_ms", 120);
  metrics.observe("batch_size_events", 10);
  assertEquals(metrics.snapshot(), {
    counters: {
      delivery_retries_total: 1,
      events_observed_total: 10,
    },
    gauges: {
      active_bindings: 20,
      queue_depth: 4,
    },
    histograms: {
      wake_latency_ms: { count: 2, sum: 200, min: 80, max: 120 },
      batch_size_events: { count: 1, sum: 10, min: 10, max: 10 },
    },
  });
});

Deno.test("O2 metrics endpoint is off by default and loopback-only", () => {
  assertEquals(resolveMetricsEndpoint(), { enabled: false });
  assertEquals(resolveMetricsEndpoint({ enabled: true }), {
    enabled: true,
    host: "127.0.0.1",
    port: 9464,
  });
  assertEquals(resolveMetricsEndpoint({ enabled: true, host: "::1", port: 9090 }), {
    enabled: true,
    host: "::1",
    port: 9090,
  });
  try {
    resolveMetricsEndpoint({ enabled: true, host: "0.0.0.0" });
    throw new Error("expected non-loopback refusal");
  } catch (error) {
    assert(error instanceof TypeError);
    assert(error.message.includes("loopback"));
  }
});
