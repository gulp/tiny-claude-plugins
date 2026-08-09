/**
 * tcp-efp.5.14: deep live probes — Codex C10 drift, config/runtime match, mailbox layout.
 */
import type { IngressConfig } from "../src/config.ts";
import { slugForProject } from "../src/mailbox/mod.ts";
import {
  assessCodexCliVersion,
  inspectLiveStatus,
  parseCodexCliVersion,
  probeConfigConsistency,
  probeMailboxLayout,
} from "../src/operator/live_status.ts";
import type { RuntimeSnapshot } from "../src/operator/supervisor.ts";
import { ACCEPTANCE_CODEX_VERSION } from "../src/owner/protocol_compat.ts";
import { SqliteDurableStateStore } from "../src/store/sqlite.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message ?? "assertEquals"}: expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`,
    );
  }
}

function configFor(statePath: string, projectPath: string): IngressConfig {
  return {
    schemaVersion: 1,
    statePath,
    bindings: {
      demo: {
        agent: "AzureFalcon",
        mailScope: { kind: "project", projectPath },
        codex: {
          adapter: "headless-app-server-owner",
          ownership: "explicit-handoff",
          threadId: "thread-live-o1",
          cwd: projectPath,
          transport: { kind: "private-stdio" },
        },
        delivery: {
          batchWindowMs: 500,
          maxEvents: 50,
          maxBytes: 32_768,
          urgentDuringTurn: "steer",
          routineDuringTurn: "queue",
        },
      },
    },
  };
}

Deno.test("5.14 parse/assess Codex CLI versions under C10 policy", () => {
  assertEquals(parseCodexCliVersion("codex-cli 0.145.0"), "0.145.0");
  assertEquals(assessCodexCliVersion("0.144.6").disposition, "acceptance");
  assertEquals(assessCodexCliVersion("codex-cli 0.145.0").disposition, "drift_probe");
  assertEquals(assessCodexCliVersion("0.144.5").disposition, "unsupported");
  assertEquals(assessCodexCliVersion("bogus").disposition, "unsupported");
  assertEquals(assessCodexCliVersion("0.145.0").baseline, ACCEPTANCE_CODEX_VERSION);
});

Deno.test("5.14 VERSION_DRIFT for newer installed Codex via injected probe", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o1-drift-" });
  const projectPath = "/home/fixture/o1-drift";
  const mailboxRoot = `${tmp}/mailbox`;
  const statePath = `${tmp}/state.sqlite3`;
  const inbox =
    `${mailboxRoot}/projects/${slugForProject(projectPath)}/agents/AzureFalcon/inbox`;
  await Deno.mkdir(inbox, { recursive: true });
  const store = new SqliteDurableStateStore({ path: statePath });
  const lease = await store.open({
    bindingId: "demo",
    agent: "AzureFalcon",
    scopeJson: JSON.stringify({ kind: "project", projectPath }),
    adapter: "headless-app-server-owner",
    threadId: "thread-live-o1",
    configHash: "fixture",
  }, "owner-live");
  await lease.transact({
    kind: "setBaseline",
    cursorMessageId: 1,
    at: new Date().toISOString(),
  });

  const report = await inspectLiveStatus({
    config: configFor(statePath, projectPath),
    bindingName: "demo",
    mailboxRoot,
    probeCodexVersion: () => "codex-cli 0.145.0",
  });
  assert(!report.healthy, JSON.stringify(report));
  const version = report.checks.find((c) => c.name === "version");
  assert(version?.code === "VERSION_DRIFT", JSON.stringify(version));
  assert(version?.detail.includes("disposition=drift_probe"), version?.detail);

  await lease.close();
  await store.close();
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.14 CONFIG_RUNTIME_MISMATCH when runtime diverges", () => {
  const projectPath = "/home/fixture/o1-cfg";
  const binding = configFor("/tmp/state.sqlite3", projectPath).bindings.demo;
  const runtime: RuntimeSnapshot = {
    schemaVersion: 1,
    pid: 1,
    bindingId: "demo",
    agent: "WrongAgent",
    threadId: "thread-other",
    owner: "headless",
    ownership: "explicit-handoff",
    adapter: "headless-app-server-owner",
    statePath: "/tmp/other-state.sqlite3",
    runtimePath: "/tmp/runtime/demo.json",
    ownerStateDir: "/tmp/owner-state",
    mailboxRoot: "/tmp/mailbox",
    projectPath: "/home/other",
    leaseOwnerId: "x",
    leaseTtlSeconds: 20,
    leaseRenewSeconds: 5,
    heartbeatAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  const result = probeConfigConsistency({
    bindingName: "demo",
    binding,
    projectPath,
    statePath: "/tmp/state.sqlite3",
    mailboxRoot: "/tmp/mailbox",
    runtime,
  });
  assertEquals(result.code, "CONFIG_RUNTIME_MISMATCH");
  assert(result.state === "unhealthy");
  assert(result.detail.includes("agent"), result.detail);
});

Deno.test("5.14 mailbox layout drift and unreadability codes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o1-mbox-" });
  const drift = await probeMailboxLayout({
    mailboxRoot: `${tmp}/empty-root`,
    projectSlug: "slug",
    agent: "AzureFalcon",
  });
  assertEquals(drift.code, "MAILBOX_LAYOUT_DRIFT");

  await Deno.mkdir(`${tmp}/mailbox/projects`, { recursive: true });
  const missing = await probeMailboxLayout({
    mailboxRoot: `${tmp}/mailbox`,
    projectSlug: "slug",
    agent: "AzureFalcon",
  });
  assertEquals(missing.code, "MAILBOX_INBOX_MISSING");

  const inbox = `${tmp}/mailbox/projects/slug/agents/AzureFalcon/inbox`;
  await Deno.mkdir(inbox, { recursive: true });
  await Deno.writeTextFile(`${inbox}/1.md`, "x");
  const ok = await probeMailboxLayout({
    mailboxRoot: `${tmp}/mailbox`,
    projectSlug: "slug",
    agent: "AzureFalcon",
  });
  assertEquals(ok.code, "MAILBOX_OK");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.14 inspectLiveStatus surfaces CONFIG_RUNTIME_MISMATCH end-to-end", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o1-rt-" });
  const projectPath = "/home/fixture/o1-rt";
  const mailboxRoot = `${tmp}/mailbox`;
  const statePath = `${tmp}/state.sqlite3`;
  const inbox =
    `${mailboxRoot}/projects/${slugForProject(projectPath)}/agents/AzureFalcon/inbox`;
  await Deno.mkdir(inbox, { recursive: true });
  await Deno.mkdir(`${tmp}/runtime`, { recursive: true });
  const store = new SqliteDurableStateStore({ path: statePath });
  const lease = await store.open({
    bindingId: "demo",
    agent: "AzureFalcon",
    scopeJson: JSON.stringify({ kind: "project", projectPath }),
    adapter: "headless-app-server-owner",
    threadId: "thread-live-o1",
    configHash: "fixture",
  }, "owner-live");
  await lease.transact({
    kind: "setBaseline",
    cursorMessageId: 9,
    at: new Date().toISOString(),
  });

  const runtime: RuntimeSnapshot = {
    schemaVersion: 1,
    pid: 9,
    bindingId: "demo",
    agent: "AzureFalcon",
    threadId: "thread-live-o1",
    owner: "headless",
    ownership: "explicit-handoff",
    adapter: "headless-app-server-owner",
    statePath: `${tmp}/wrong.sqlite3`,
    runtimePath: `${tmp}/runtime/demo.json`,
    ownerStateDir: `${tmp}/owner-state`,
    mailboxRoot,
    projectPath,
    leaseOwnerId: "owner-live",
    leaseTtlSeconds: 20,
    leaseRenewSeconds: 5,
    heartbeatAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(`${tmp}/runtime/demo.json`, JSON.stringify(runtime));

  const report = await inspectLiveStatus({
    config: configFor(statePath, projectPath),
    bindingName: "demo",
    mailboxRoot,
    probeCodexVersion: () => "0.144.6",
  });
  assert(!report.healthy, JSON.stringify(report));
  assert(
    report.checks.some((c) => c.name === "config" && c.code === "CONFIG_RUNTIME_MISMATCH"),
    JSON.stringify(report.checks),
  );

  await lease.close();
  await store.close();
  await Deno.remove(tmp, { recursive: true });
});
