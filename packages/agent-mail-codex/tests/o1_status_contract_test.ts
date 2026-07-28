/// <reference lib="deno.window" />

import {
  type CheckName,
  type DiagnosticCheck,
  inspectStatus,
  renderStatusHuman,
  type StatusContext,
  type StatusProbe,
} from "../src/operator/status.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

const NAMES: CheckName[] = [
  "config",
  "mailbox",
  "store",
  "lease",
  "owner",
  "thread",
  "cursor",
  "queue",
  "version",
];

function probes(
  override?: Partial<Record<CheckName, DiagnosticCheck | Error>>,
): Record<CheckName, StatusProbe> {
  return Object.fromEntries(NAMES.map((name) => [
    name,
    {
      snapshot: () => {
        const value = override?.[name] ?? {
          name,
          state: "healthy",
          code: `${name.toUpperCase()}_OK`,
          detail: `${name} ready`,
        };
        if (value instanceof Error) throw value;
        return value;
      },
    },
  ])) as Record<CheckName, StatusProbe>;
}

function context(overrides: Partial<StatusContext> = {}): StatusContext {
  return {
    bindingId: "binding-o1",
    agent: "BeigeHorizon",
    projectSlug: "home-gulp-projects-tiny-claude-plugins",
    threadId: "thread-exact",
    owner: "headless",
    cursor: 421,
    queueDepth: 3,
    lastError: null,
    probes: probes(),
    ...overrides,
  };
}

Deno.test("O1 stable JSON report covers every operator dimension", async () => {
  const report = await inspectStatus(
    context(),
    () => "2026-07-29T01:30:00.000Z",
  );
  assertEquals(report.schemaVersion, 1);
  assertEquals(report.healthy, true);
  assertEquals(report.checks.map((check) => check.name), NAMES);
  assertEquals(report, JSON.parse(JSON.stringify(report)));
});

Deno.test("O1 unknown is never silently green and requires actionable code", async () => {
  const report = await inspectStatus(context({
    probes: probes({
      owner: {
        name: "owner",
        state: "unknown",
        code: "UNKNOWN",
        detail: "owner cannot be determined",
      },
    }),
  }));
  assertEquals(report.healthy, false);
  assertEquals(report.checks.find((check) => check.name === "owner"), {
    name: "owner",
    state: "unhealthy",
    code: "OWNER_MISSING_ACTION_CODE",
    detail: "owner cannot be determined",
  });
});

Deno.test("O1 probe failure has a stable actionable error code", async () => {
  const report = await inspectStatus(context({
    probes: probes({ mailbox: new Error("inbox layout unreadable") }),
  }));
  assertEquals(report.healthy, false);
  assertEquals(report.checks.find((check) => check.name === "mailbox"), {
    name: "mailbox",
    state: "unhealthy",
    code: "MAILBOX_PROBE_FAILED",
    detail: "inbox layout unreadable",
  });
});

Deno.test("O1 human output names resolved binding and ownership", async () => {
  const human = renderStatusHuman(await inspectStatus(context()));
  assert(human.includes("Binding: binding-o1"));
  assert(human.includes("Thread: thread-exact"));
  assert(human.includes("Owner: headless"));
  assert(human.includes("Queue: 3"));
});

Deno.test("O1 diagnostic probe contract exposes no mutators", () => {
  const probe: StatusProbe = {
    snapshot: () => ({
      name: "store",
      state: "healthy",
      code: "STORE_OK",
      detail: "readable",
    }),
  };
  assertEquals(Object.keys(probe), ["snapshot"]);
  assertEquals("acquire" in probe, false);
  assertEquals("acknowledge" in probe, false);
  assertEquals("write" in probe, false);
});
