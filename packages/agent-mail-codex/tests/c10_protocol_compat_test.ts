/// <reference lib="deno.window" />

import {
  ACCEPTANCE_CODEX_VERSION,
  assessCompatibility,
  CompatibilityError,
  type CompatibilityInput,
  requireAcceptanceCompatibility,
} from "../src/owner/protocol_compat.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

const REQUIRED = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
];

function fixture(overrides: Partial<CompatibilityInput> = {}): CompatibilityInput {
  return {
    codexVersion: ACCEPTANCE_CODEX_VERSION,
    capabilities: { protocolVersion: "2026-07-28", methods: REQUIRED },
    daemonVersion: "0.1.0-phase0",
    pluginVersion: "0.1.0-phase0",
    schemaVersion: 1,
    ...overrides,
  };
}

Deno.test("C10 accepts only the pinned 0.144.6 baseline", () => {
  const report = requireAcceptanceCompatibility(fixture());
  assertEquals(report.disposition, "acceptance");
  assertEquals(report.baseline, "0.144.6");
  assertEquals(report.provenance, {
    daemonVersion: "0.1.0-phase0",
    pluginVersion: "0.1.0-phase0",
    schemaVersion: 1,
  });
});

Deno.test("C10 labels newer versions drift probes and never promotes them", () => {
  const report = assessCompatibility(fixture({ codexVersion: "0.145.0" }));
  assertEquals(report.disposition, "drift_probe");
  try {
    requireAcceptanceCompatibility(fixture({ codexVersion: "0.145.0" }));
    throw new Error("expected compatibility rejection");
  } catch (error) {
    if (!(error instanceof CompatibilityError)) throw error;
    assertEquals(error.report.disposition, "drift_probe");
  }
});

Deno.test("C10 rejects older and malformed versions", () => {
  assertEquals(
    assessCompatibility(fixture({ codexVersion: "0.144.5" })).disposition,
    "unsupported",
  );
  assertEquals(
    assessCompatibility(fixture({ codexVersion: "v0.144.6" })).disposition,
    "unsupported",
  );
  assertEquals(
    assessCompatibility(fixture({ codexVersion: "0.144" })).disposition,
    "unsupported",
  );
});

Deno.test("C10 rejects missing or malformed capabilities", () => {
  const missing = assessCompatibility(fixture({
    capabilities: { protocolVersion: "2026-07-28", methods: REQUIRED.slice(0, -1) },
  }));
  assertEquals(missing.disposition, "unsupported");
  assertEquals(missing.reasons.includes("missing required App Server method: turn/steer"), true);

  const malformed = assessCompatibility(fixture({
    capabilities: { protocolVersion: 7 as unknown as string, methods: REQUIRED },
  }));
  assertEquals(malformed.disposition, "unsupported");
});

Deno.test("C10 rejects daemon/plugin and schema skew visibly", () => {
  const report = assessCompatibility(fixture({
    daemonVersion: "0.1.1",
    pluginVersion: "0.1.0",
    schemaVersion: 2,
  }));
  assertEquals(report.disposition, "unsupported");
  assertEquals(report.reasons, [
    "matches acceptance baseline 0.144.6",
    "component skew: daemon 0.1.1 != plugin 0.1.0",
    "schema skew: observed 2 != supported 1",
  ]);
});
