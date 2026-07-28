/// <reference lib="deno.window" />

import {
  encodeHarnessArtifact,
  executeLoadSuite,
  type HarnessMeasurements,
  type HarnessVersions,
  LOAD_PROFILES,
  percentile,
  runLoadProfile,
} from "../src/verification/load_harness.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

const versions: HarnessVersions = {
  codex: "0.144.6",
  daemon: "0.1.0-phase0",
  plugin: "0.1.0-phase0",
  schema: 1,
  os: "linux",
  architecture: "x86_64",
};

function passing(): HarnessMeasurements {
  return {
    observationLatencyMs: [200, 300, 400, 500, 600],
    acceptanceLatencyMs: [100, 200, 300, 400, 500],
    endToEndLatencyMs: [300, 500, 700, 900, 1_100],
    recoveryLatencyMs: [1_000, 2_000, 3_000],
    eventsObserved: 100,
    batchesAccepted: 10,
    duplicateAcceptedBatches: 0,
    lostEvents: 0,
    wrongBindingDeliveries: 0,
    attemptedWithoutOwnership: 0,
    competingResponses: 0,
    modelCallsWhileQuiet: 0,
    rssBytesByBinding: [50 * 1024 * 1024],
    idleCpuPercentByBinding: [0.25],
    sqliteGrowthBytesPer10k: 10 * 1024 * 1024,
  };
}

Deno.test("V1 declares every required load and failure profile", () => {
  assertEquals(Object.keys(LOAD_PROFILES).sort(), [
    "app_server_outage",
    "burst",
    "multi_binding",
    "poison",
    "restart_boundary",
    "steady",
    "turn_race",
  ]);
  assertEquals(LOAD_PROFILES.multi_binding.bindings, 20);
  assertEquals(LOAD_PROFILES.app_server_outage.durationMs, 30_000);
  assertEquals(LOAD_PROFILES.burst.events, 100);
});

Deno.test("V1 produces p50/p95 metrics and a passing verdict", () => {
  const artifact = runLoadProfile("burst", versions, passing());
  assertEquals(artifact.summary.p50.observation, 400);
  assertEquals(artifact.summary.p95.observation, 600);
  assertEquals(artifact.summary.coalescingRatio, 10);
  assertEquals(artifact.result, "pass");
  assertEquals(
    artifact.verdicts.every((item) => item.state === "pass"),
    true,
  );
});

Deno.test("V1 hard alerts on loss, wrong binding, ownership, and races", () => {
  const measurements = passing();
  measurements.lostEvents = 1;
  measurements.wrongBindingDeliveries = 1;
  measurements.attemptedWithoutOwnership = 1;
  measurements.competingResponses = 1;
  const artifact = runLoadProfile("restart_boundary", versions, measurements);
  assertEquals(artifact.result, "hard_alert");
  const hard = artifact.verdicts
    .filter((item) => item.state === "hard_alert")
    .map((item) => item.metric)
    .sort();
  assertEquals(hard, [
    "attempted_without_ownership",
    "competing_responses",
    "lost_events",
    "wrong_binding_deliveries",
  ]);
});

Deno.test("V1 separates target warnings from hard thresholds", () => {
  const warning = passing();
  warning.observationLatencyMs = [1_500];
  warning.rssBytesByBinding = [100 * 1024 * 1024];
  assertEquals(runLoadProfile("steady", versions, warning).result, "warning");

  const hard = passing();
  hard.observationLatencyMs = [2_001];
  hard.recoveryLatencyMs = [30_001];
  hard.sqliteGrowthBytesPer10k = 51 * 1024 * 1024;
  assertEquals(
    runLoadProfile("app_server_outage", versions, hard).result,
    "hard_alert",
  );
});

Deno.test("V1 artifact retains raw samples and exact versions", () => {
  const measurements = passing();
  const artifact = runLoadProfile("multi_binding", versions, measurements);
  const encoded = JSON.parse(encodeHarnessArtifact(artifact));
  assertEquals(encoded.versions, versions);
  assertEquals(
    encoded.measurements.observationLatencyMs,
    measurements.observationLatencyMs,
  );
  assertEquals(encoded.profileDefinition.bindings, 20);
  assert(!encodeHarnessArtifact(artifact).includes("subject"));
  assert(!encodeHarnessArtifact(artifact).includes("body_md"));
});

Deno.test("V1 percentile uses deterministic nearest-rank semantics", () => {
  assertEquals(percentile([5, 1, 4, 2, 3], 50), 3);
  assertEquals(percentile([5, 1, 4, 2, 3], 95), 5);
  assertEquals(percentile([], 95), 0);
  let failed = false;
  try {
    percentile([1], 101);
  } catch {
    failed = true;
  }
  assert(failed, "invalid percentile must fail");
});

Deno.test("V1 executor runs every disposable profile with zero model budget", async () => {
  const contexts: unknown[] = [];
  const suite = await executeLoadSuite({
    versions: () => versions,
    measure: (context) => {
      contexts.push(context);
      return passing();
    },
  }, 2);
  assertEquals(suite.artifacts.length, Object.keys(LOAD_PROFILES).length * 2);
  assertEquals(suite.result, "pass");
  for (const raw of contexts) {
    const context = raw as {
      modelCallBudget: number;
      disposable: boolean;
    };
    assertEquals(context.modelCallBudget, 0);
    assertEquals(context.disposable, true);
  }
});
