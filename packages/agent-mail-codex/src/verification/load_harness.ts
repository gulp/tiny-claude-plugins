/** V1: deterministic load/resource/failure profile evaluator. */

export const LOAD_PROFILES = {
  steady: {
    bindings: 1,
    events: 60,
    durationMs: 60 * 60 * 1_000,
    description: "one event/minute for one hour",
  },
  burst: {
    bindings: 1,
    events: 100,
    durationMs: 1_000,
    description: "100 events in one second",
  },
  multi_binding: {
    bindings: 20,
    events: 500,
    durationMs: 1_000,
    description: "20 bindings with five simultaneous 100-event bursts",
  },
  restart_boundary: {
    bindings: 1,
    events: 6,
    durationMs: 0,
    description: "kill once at every durable transaction boundary",
  },
  app_server_outage: {
    bindings: 1,
    events: 1,
    durationMs: 30_000,
    description: "30 second outage followed by exact-thread recovery",
  },
  poison: {
    bindings: 1,
    events: 2,
    durationMs: 0,
    description: "malformed frontmatter plus one MiB input",
  },
  turn_race: {
    bindings: 1,
    events: 3,
    durationMs: 0,
    description: "events cross turn/start, turn/steer, and turn/completed",
  },
} as const;

export type LoadProfileName = keyof typeof LOAD_PROFILES;
export type VerdictState = "pass" | "warning" | "hard_alert";

export interface HarnessVersions {
  codex: string;
  daemon: string;
  plugin: string;
  schema: number;
  os: string;
  architecture: string;
}

export interface HarnessMeasurements {
  observationLatencyMs: number[];
  acceptanceLatencyMs: number[];
  endToEndLatencyMs: number[];
  recoveryLatencyMs: number[];
  eventsObserved: number;
  batchesAccepted: number;
  duplicateAcceptedBatches: number;
  lostEvents: number;
  wrongBindingDeliveries: number;
  attemptedWithoutOwnership: number;
  competingResponses: number;
  modelCallsWhileQuiet: number;
  rssBytesByBinding: number[];
  idleCpuPercentByBinding: number[];
  sqliteGrowthBytesPer10k: number;
}

export interface MetricVerdict {
  metric: string;
  value: number;
  target: string;
  hardAlert: string;
  state: VerdictState;
}

export interface HarnessArtifact {
  schemaVersion: 1;
  profile: LoadProfileName;
  profileDefinition: typeof LOAD_PROFILES[LoadProfileName];
  versions: HarnessVersions;
  measurements: HarnessMeasurements;
  summary: {
    p50: Record<string, number>;
    p95: Record<string, number>;
    coalescingRatio: number;
    duplicatePercent: number;
  };
  verdicts: MetricVerdict[];
  result: VerdictState;
}

export interface ProfileRunContext {
  profile: LoadProfileName;
  definition: typeof LOAD_PROFILES[LoadProfileName];
  run: number;
  modelCallBudget: 0;
  disposable: true;
}

export interface LoadProfileRunner {
  versions(): HarnessVersions | Promise<HarnessVersions>;
  measure(
    context: ProfileRunContext,
  ): HarnessMeasurements | Promise<HarnessMeasurements>;
}

export interface LoadSuiteResult {
  schemaVersion: 1;
  runsPerProfile: number;
  artifacts: HarnessArtifact[];
  result: VerdictState;
}

/** Execute every declared profile against disposable, zero-model-spend fixtures. */
export async function executeLoadSuite(
  runner: LoadProfileRunner,
  runsPerProfile = 1,
): Promise<LoadSuiteResult> {
  if (!Number.isSafeInteger(runsPerProfile) || runsPerProfile < 1) {
    throw new TypeError("runsPerProfile must be positive");
  }
  const versions = await runner.versions();
  validateVersions(versions);
  const artifacts: HarnessArtifact[] = [];
  for (const profile of Object.keys(LOAD_PROFILES) as LoadProfileName[]) {
    for (let run = 1; run <= runsPerProfile; run++) {
      const measurements = await runner.measure({
        profile,
        definition: LOAD_PROFILES[profile],
        run,
        modelCallBudget: 0,
        disposable: true,
      });
      artifacts.push(runLoadProfile(profile, versions, measurements));
    }
  }
  return {
    schemaVersion: 1,
    runsPerProfile,
    artifacts,
    result: overall(artifacts.flatMap((artifact) => artifact.verdicts)),
  };
}

export function runLoadProfile(
  profile: LoadProfileName,
  versions: HarnessVersions,
  measurements: HarnessMeasurements,
): HarnessArtifact {
  validateVersions(versions);
  validateMeasurements(measurements);
  const p50 = latencyPercentiles(measurements, 50);
  const p95 = latencyPercentiles(measurements, 95);
  const coalescingRatio = measurements.batchesAccepted === 0
    ? measurements.eventsObserved === 0 ? 0 : Number.POSITIVE_INFINITY
    : measurements.eventsObserved / measurements.batchesAccepted;
  const duplicatePercent = measurements.batchesAccepted === 0
    ? 0
    : measurements.duplicateAcceptedBatches /
      measurements.batchesAccepted * 100;
  const maxRssMiB = bytesToMiB(Math.max(0, ...measurements.rssBytesByBinding));
  const maxIdleCpu = Math.max(0, ...measurements.idleCpuPercentByBinding);
  const stateGrowthMiB = bytesToMiB(measurements.sqliteGrowthBytesPer10k);

  const verdicts: MetricVerdict[] = [
    maxIs("quiet_model_calls", measurements.modelCallsWhileQuiet, 0, 0),
    maxIs("observation_p95_ms", p95.observation, 1_000, 2_000),
    maxIs("acceptance_p95_ms", p95.acceptance, 750, 2_000),
    maxIs("end_to_end_p95_ms", p95.endToEnd, 1_750, 4_000),
    minIs("burst_coalescing_ratio", coalescingRatio, 10, 5),
    maxIs("duplicate_accepted_percent", duplicatePercent, 0.1, 1),
    zeroIs("lost_events", measurements.lostEvents),
    zeroIs("wrong_binding_deliveries", measurements.wrongBindingDeliveries),
    maxIs("rss_mib_per_binding", maxRssMiB, 75, 150),
    maxIs("idle_cpu_percent_per_binding", maxIdleCpu, 0.5, 2),
    maxIs("sqlite_growth_mib_per_10k", stateGrowthMiB, 20, 50),
    maxIs("recovery_p95_ms", p95.recovery, 10_000, 30_000),
    zeroIs(
      "attempted_without_ownership",
      measurements.attemptedWithoutOwnership,
    ),
    zeroIs("competing_responses", measurements.competingResponses),
  ];
  return {
    schemaVersion: 1,
    profile,
    profileDefinition: LOAD_PROFILES[profile],
    versions,
    measurements: structuredClone(measurements),
    summary: { p50, p95, coalescingRatio, duplicatePercent },
    verdicts,
    result: overall(verdicts),
  };
}

export function encodeHarnessArtifact(artifact: HarnessArtifact): string {
  return `${JSON.stringify(artifact)}\n`;
}

export function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  if (values.length === 0) return 0;
  if (
    !Number.isFinite(percentileValue) ||
    percentileValue < 0 ||
    percentileValue > 100
  ) {
    throw new TypeError("percentile must be in [0,100]");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue / 100 * sorted.length));
  return sorted[rank - 1]!;
}

function latencyPercentiles(
  measurements: HarnessMeasurements,
  percentileValue: number,
): Record<string, number> {
  return {
    observation: percentile(
      measurements.observationLatencyMs,
      percentileValue,
    ),
    acceptance: percentile(
      measurements.acceptanceLatencyMs,
      percentileValue,
    ),
    endToEnd: percentile(
      measurements.endToEndLatencyMs,
      percentileValue,
    ),
    recovery: percentile(
      measurements.recoveryLatencyMs,
      percentileValue,
    ),
  };
}

function maxIs(
  metric: string,
  value: number,
  target: number,
  hard: number,
): MetricVerdict {
  return {
    metric,
    value,
    target: `<=${target}`,
    hardAlert: `>${hard}`,
    state: value > hard ? "hard_alert" : value > target ? "warning" : "pass",
  };
}

function minIs(
  metric: string,
  value: number,
  target: number,
  hard: number,
): MetricVerdict {
  return {
    metric,
    value,
    target: `>=${target}`,
    hardAlert: `<${hard}`,
    state: value < hard ? "hard_alert" : value < target ? "warning" : "pass",
  };
}

function zeroIs(metric: string, value: number): MetricVerdict {
  return {
    metric,
    value,
    target: "0",
    hardAlert: "any",
    state: value === 0 ? "pass" : "hard_alert",
  };
}

function overall(verdicts: readonly MetricVerdict[]): VerdictState {
  if (verdicts.some((item) => item.state === "hard_alert")) {
    return "hard_alert";
  }
  return verdicts.some((item) => item.state === "warning") ? "warning" : "pass";
}

function bytesToMiB(value: number): number {
  return value / 1024 / 1024;
}

function validateVersions(versions: HarnessVersions): void {
  for (
    const field of [
      "codex",
      "daemon",
      "plugin",
      "os",
      "architecture",
    ] as const
  ) {
    if (!versions[field].trim()) {
      throw new TypeError(`versions.${field} is required`);
    }
  }
  if (!Number.isSafeInteger(versions.schema) || versions.schema < 1) {
    throw new TypeError("versions.schema must be positive");
  }
}

function validateMeasurements(measurements: HarnessMeasurements): void {
  for (const [key, value] of Object.entries(measurements)) {
    const values = Array.isArray(value) ? value : [value];
    if (
      values.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)
    ) {
      throw new TypeError(`${key} must contain non-negative finite numbers`);
    }
  }
}
