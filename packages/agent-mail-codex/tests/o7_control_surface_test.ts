/**
 * O7: control API + version/cache drift contract tests.
 */

import {
  CONTROL_API_VERSION,
  type ControlRequest,
  detectVersionDrift,
  dispatchControl,
  PLUGIN_IDENTITY,
} from "../src/operator/control.ts";
import type { RuntimeSnapshot } from "../src/operator/supervisor.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message ?? "assertEquals"}: expected ${Deno.inspect(expected)}, got ${
        Deno.inspect(actual)
      }`,
    );
  }
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    pid: 42,
    bindingId: "demo",
    agent: "CobaltJaguar",
    threadId: "thread-o7",
    owner: "headless",
    ownership: "explicit-handoff",
    adapter: "headless-app-server-owner",
    statePath: "/tmp/state.sqlite3",
    runtimePath: "/tmp/runtime/demo.json",
    ownerStateDir: "/tmp/owner-state",
    mailboxRoot: "/tmp/mailbox",
    projectPath: "/home/gulp/projects/tiny-claude-plugins",
    leaseOwnerId: "agent-mail-codex-supervisor:42",
    leaseTtlSeconds: 20,
    leaseRenewSeconds: 5,
    heartbeatAt: "2026-07-28T23:00:00.000Z",
    startedAt: "2026-07-28T22:00:00.000Z",
    ...overrides,
  };
}

function base(overrides: Partial<ControlRequest> = {}): ControlRequest {
  return {
    action: "doctor",
    bindingId: "demo",
    agent: "CobaltJaguar",
    observedPluginVersion: PLUGIN_IDENTITY.expectedVersion,
    observedPluginRoot:
      `/home/gulp/.codex/plugins/cache/tiny-claude-plugins/agent-mail-monitor/${PLUGIN_IDENTITY.expectedVersion}`,
    runtimeSnapshot: snapshot(),
    unitActive: true,
    mailboxRootExists: true,
    ...overrides,
  };
}

Deno.test("O7: doctor reports all readiness dimensions", () => {
  const result = dispatchControl(base());
  assert(result.ok, result.message);
  assertEquals(result.code, "ok");
  assert(result.doctor?.length === 7, `expected 7 checks, got ${result.doctor?.length}`);
  const names = result.doctor!.map((c) => c.name).sort();
  assertEquals(names, [
    "daemon",
    "identity",
    "inbox",
    "notification",
    "ownership",
    "transport",
    "version",
  ]);
  assert(result.doctor!.every((c) => c.state === "healthy"), Deno.inspect(result.doctor));
  assertEquals(result.plugin.controlApiVersion, CONTROL_API_VERSION);
});

Deno.test("O7: doctor fails loud on missing identity and inactive daemon", () => {
  const forced = dispatchControl(base({
    agent: undefined,
    runtimeSnapshot: snapshot({ agent: "" }),
    unitActive: false,
    mailboxRootExists: false,
  }));
  assert(!forced.ok, "doctor must fail");
  const codes = new Set(forced.doctor!.filter((c) => c.state === "unhealthy").map((c) => c.code));
  assert(codes.has("IDENTITY_MISSING"), Deno.inspect(forced.doctor));
  assert(codes.has("DAEMON_INACTIVE"), Deno.inspect(forced.doctor));
  assert(codes.has("MAILBOX_MISSING"), Deno.inspect(forced.doctor));
});

Deno.test("O7: stale cache version drift is distinct from plain version_drift", () => {
  const stale = detectVersionDrift({
    observedPluginVersion: "0.1.0+codex.old",
    observedPluginRoot:
      "/home/gulp/.codex/plugins/cache/tiny-claude-plugins/agent-mail-monitor/0.1.0+codex.old",
  });
  assertEquals(stale.code, "stale_cache");
  assert(stale.drifted, "stale cache must drift");

  const plain = detectVersionDrift({
    observedPluginVersion: "0.1.0+codex.old",
    observedPluginRoot: "/home/gulp/projects/tiny-claude-plugins/plugins/agent-mail-monitor",
  });
  assertEquals(plain.code, "version_drift");
});

Deno.test("O7: start/stop/inspect refuse silent fallbacks", () => {
  const start = dispatchControl(base({ action: "start", unitActive: false }));
  assert(start.ok, start.message);
  assert(
    !!start.commands?.some((c) => c.includes("systemctl --user start")),
    "start emits systemctl",
  );

  const already = dispatchControl(base({ action: "start", unitActive: true }));
  assertEquals(already.code, "daemon_active");

  const noAgent = dispatchControl(base({ action: "start", agent: undefined, unitActive: false }));
  assertEquals(noAgent.code, "identity_missing");

  const drifted = dispatchControl(base({
    action: "inspect",
    observedPluginVersion: "0.0.1",
  }));
  assert(!drifted.ok, "inspect must fail on drift");
  assert(
    drifted.code === "stale_cache" || drifted.code === "version_drift",
    drifted.code,
  );

  const stop = dispatchControl(base({ action: "stop" }));
  assert(stop.ok, stop.message);
  assert(!!stop.commands?.[0].includes("stop"), "stop emits systemctl stop");
});

Deno.test("O7: handoff/acquire require explicit confirm", () => {
  const handoff = dispatchControl(base({ action: "handoff", threadId: "thread-o7" }));
  assertEquals(handoff.code, "confirm_required");

  const handoffOk = dispatchControl(base({
    action: "handoff",
    threadId: "thread-o7",
    confirm: true,
  }));
  assert(handoffOk.ok, handoffOk.message);
  assert(
    !!handoffOk.commands?.[0].includes("release-owner"),
    "handoff emits release-owner",
  );

  const acquire = dispatchControl(base({ action: "acquire", threadId: "thread-o7" }));
  assertEquals(acquire.code, "confirm_required");

  const acquireOk = dispatchControl(base({
    action: "acquire",
    threadId: "thread-o7",
    confirm: true,
  }));
  assert(acquireOk.ok, acquireOk.message);
  assert(
    !!acquireOk.commands?.[0].includes("acquire-owner"),
    "acquire emits acquire-owner",
  );
});

Deno.test("O7: PLUGIN_IDENTITY expectedVersion is cachebuster-shaped", () => {
  assert(
    /^0\.1\.0\+codex\.\d{14}$/.test(PLUGIN_IDENTITY.expectedVersion),
    PLUGIN_IDENTITY.expectedVersion,
  );
});
