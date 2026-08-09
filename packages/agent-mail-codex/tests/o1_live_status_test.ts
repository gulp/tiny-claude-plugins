import type { IngressConfig } from "../src/config.ts";
import { slugForProject } from "../src/mailbox/mod.ts";
import { inspectLiveStatus } from "../src/operator/live_status.ts";
import type { RuntimeSnapshot } from "../src/operator/supervisor.ts";
import { SqliteDurableStateStore } from "../src/store/sqlite.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
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

Deno.test("O1 live status measures healthy mailbox/store/lease/runtime without mutation", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o1-live-" });
  const nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  const projectPath = "/home/fixture/o1-live";
  const mailboxRoot = `${tmp}/mailbox`;
  const statePath = `${tmp}/state.sqlite3`;
  const config = configFor(statePath, projectPath);
  const inbox = `${mailboxRoot}/projects/${slugForProject(projectPath)}/agents/AzureFalcon/inbox`;
  await Deno.mkdir(inbox, { recursive: true });

  const store = new SqliteDurableStateStore({
    path: statePath,
    now: () => new Date(nowMs).toISOString(),
  });
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
    cursorMessageId: 27981,
    at: new Date(nowMs).toISOString(),
  });

  const runtime: RuntimeSnapshot = {
    schemaVersion: 1,
    pid: 123,
    bindingId: "demo",
    agent: "AzureFalcon",
    threadId: "thread-live-o1",
    owner: "headless",
    ownership: "explicit-handoff",
    adapter: "headless-app-server-owner",
    statePath,
    runtimePath: `${tmp}/runtime/demo.json`,
    ownerStateDir: `${tmp}/owner-state`,
    mailboxRoot,
    projectPath,
    leaseOwnerId: "owner-live",
    leaseTtlSeconds: 20,
    leaseRenewSeconds: 5,
    // Runtime snapshots identify the process; the renewable SQLite lease is
    // the liveness authority.
    heartbeatAt: new Date(nowMs - 60_000).toISOString(),
    startedAt: new Date(nowMs - 60_000).toISOString(),
  };
  await Deno.mkdir(`${tmp}/runtime`);
  await Deno.writeTextFile(
    `${tmp}/runtime/demo.json`,
    JSON.stringify(runtime),
  );

  const report = await inspectLiveStatus({
    config,
    bindingName: "demo",
    mailboxRoot,
    now: () => nowMs,
    probeCodexVersion: () => "codex-cli 0.144.6",
  });
  assert(report.healthy, JSON.stringify(report));
  assert(report.cursor === 27981, JSON.stringify(report));
  assert(report.queueDepth === 0, JSON.stringify(report));
  assert(report.owner === "headless", JSON.stringify(report));
  assert(report.checks.every((item) => item.state === "healthy"), JSON.stringify(report));
  assert(
    report.checks.some((item) => item.name === "version" && item.code === "VERSION_OK"),
    JSON.stringify(report),
  );

  await lease.close();
  await store.close();
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("O1 live status fails loud without creating missing store or inbox", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o1-missing-" });
  const statePath = `${tmp}/missing.sqlite3`;
  const config = configFor(statePath, "/home/fixture/o1-missing");
  const report = await inspectLiveStatus({
    config,
    bindingName: "demo",
    mailboxRoot: `${tmp}/mailbox`,
    probeCodexVersion: () => "codex-cli 0.144.6",
  });
  assert(!report.healthy, JSON.stringify(report));
  assert(
    report.checks.some((item) => item.name === "store" && item.code === "STORE_UNREADABLE"),
    JSON.stringify(report),
  );
  assert(
    report.checks.some((item) =>
      item.name === "mailbox" &&
      (item.code === "MAILBOX_INBOX_MISSING" || item.code === "MAILBOX_LAYOUT_DRIFT")
    ),
    JSON.stringify(report),
  );
  let created = true;
  try {
    await Deno.stat(statePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) created = false;
    else throw error;
  }
  assert(!created, "diagnostic probe created the missing SQLite file");
  await Deno.remove(tmp, { recursive: true });
});
