/** C10: explicit Codex App Server baseline and compatibility gate. */

export const ACCEPTANCE_CODEX_VERSION = "0.144.6";
export const INGRESS_PROTOCOL_SCHEMA = 1;
export const INGRESS_COMPONENT_VERSION = "0.1.0-phase0";

export interface AppServerCapabilities {
  methods: string[];
  protocolVersion: string;
}

export interface CompatibilityInput {
  codexVersion: string;
  capabilities: AppServerCapabilities;
  daemonVersion: string;
  pluginVersion: string;
  schemaVersion: number;
}

export type CompatibilityDisposition =
  | "acceptance"
  | "drift_probe"
  | "unsupported";

export interface CompatibilityReport {
  disposition: CompatibilityDisposition;
  baseline: string;
  observedCodexVersion: string;
  protocolVersion: string;
  reasons: string[];
  provenance: {
    daemonVersion: string;
    pluginVersion: string;
    schemaVersion: number;
  };
}

export class CompatibilityError extends Error {
  constructor(
    message: string,
    readonly report: CompatibilityReport,
  ) {
    super(message);
    this.name = "CompatibilityError";
  }
}

const REQUIRED_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
] as const;

type Version = readonly [major: number, minor: number, patch: number];

export function assessCompatibility(input: CompatibilityInput): CompatibilityReport {
  const reasons: string[] = [];
  const observed = parseVersion(input.codexVersion);
  const baseline = parseVersion(ACCEPTANCE_CODEX_VERSION)!;
  let disposition: CompatibilityDisposition;

  if (!observed) {
    disposition = "unsupported";
    reasons.push(`malformed Codex version: ${input.codexVersion}`);
  } else {
    const comparison = compareVersion(observed, baseline);
    if (comparison === 0) {
      disposition = "acceptance";
      reasons.push(`matches acceptance baseline ${ACCEPTANCE_CODEX_VERSION}`);
    } else if (comparison > 0) {
      disposition = "drift_probe";
      reasons.push(
        `newer than acceptance baseline ${ACCEPTANCE_CODEX_VERSION}; evidence is drift-only`,
      );
    } else {
      disposition = "unsupported";
      reasons.push(`older than acceptance baseline ${ACCEPTANCE_CODEX_VERSION}`);
    }
  }

  if (!input.capabilities || typeof input.capabilities.protocolVersion !== "string") {
    disposition = "unsupported";
    reasons.push("malformed App Server capabilities");
  } else {
    for (const method of REQUIRED_METHODS) {
      if (!input.capabilities.methods.includes(method)) {
        disposition = "unsupported";
        reasons.push(`missing required App Server method: ${method}`);
      }
    }
  }

  if (input.daemonVersion !== input.pluginVersion) {
    disposition = "unsupported";
    reasons.push(
      `component skew: daemon ${input.daemonVersion} != plugin ${input.pluginVersion}`,
    );
  }
  if (input.schemaVersion !== INGRESS_PROTOCOL_SCHEMA) {
    disposition = "unsupported";
    reasons.push(
      `schema skew: observed ${input.schemaVersion} != supported ${INGRESS_PROTOCOL_SCHEMA}`,
    );
  }

  return {
    disposition,
    baseline: ACCEPTANCE_CODEX_VERSION,
    observedCodexVersion: input.codexVersion,
    protocolVersion: input.capabilities?.protocolVersion ?? "<malformed>",
    reasons,
    provenance: {
      daemonVersion: input.daemonVersion,
      pluginVersion: input.pluginVersion,
      schemaVersion: input.schemaVersion,
    },
  };
}

/** Startup gate: drift probes and unsupported combinations never enter production delivery. */
export function requireAcceptanceCompatibility(input: CompatibilityInput): CompatibilityReport {
  const report = assessCompatibility(input);
  if (report.disposition !== "acceptance") {
    throw new CompatibilityError(
      `App Server compatibility gate rejected ${report.disposition}: ${report.reasons.join("; ")}`,
      report,
    );
  }
  return report;
}

function parseVersion(value: string): Version | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: Version, right: Version): number {
  const differences = [
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  ];
  for (const difference of differences) {
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
