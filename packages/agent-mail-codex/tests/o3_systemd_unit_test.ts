/**
 * O3: systemd user-unit template + supervisor contract checks.
 */

import {
  defaultSleep,
  resolveRuntimePaths,
  runSupervisor,
  type RuntimeSnapshot,
} from "../src/operator/supervisor.ts";
import type { IngressConfig } from "../src/config.ts";

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

const UNIT_PATH = new URL("../deploy/systemd/agent-mail-codex@.service", import.meta.url);
const RUN_WRAPPER = new URL("../deploy/agent-mail-codex-run.sh", import.meta.url);
const INSTALL = new URL("../deploy/install-user-unit.sh", import.meta.url);
const UNINSTALL = new URL("../deploy/uninstall-user-unit.sh", import.meta.url);
const RUNBOOK = new URL("../docs/ops-runbook.md", import.meta.url);

Deno.test("O3 unit template: bounded restart and inspectable state dirs", async () => {
  const text = await Deno.readTextFile(UNIT_PATH);
  assert(text.includes("Restart=on-failure"), "Restart=on-failure");
  assert(text.includes("StartLimitBurst=5"), "StartLimitBurst");
  assert(text.includes("StartLimitIntervalSec=120"), "StartLimitIntervalSec");
  assert(text.includes("StateDirectory=agent-mail-codex/%i"), "StateDirectory");
  assert(text.includes("RuntimeDirectory=agent-mail-codex/%i"), "RuntimeDirectory");
  assert(text.includes("WantedBy=default.target"), "WantedBy default.target");
  assert(text.includes("KillSignal=SIGTERM"), "SIGTERM stop");
  assert(
    text.includes("ReadWritePaths=%h/.local/state/agent-mail-codex"),
    "state write only",
  );
  assert(
    text.includes("ReadOnlyPaths=%h/.mcp_agent_mail_git_mailbox_repo"),
    "mailbox read-only",
  );
  assert(
    !text.toLowerCase().includes("app-server.service"),
    "must not order after App Server daemon",
  );
  assert(text.includes("agent-mail-codex-run.sh"), "ExecStart wrapper");
});

Deno.test("O3 deploy scripts and runbook exist and are executable where required", async () => {
  for (const url of [RUN_WRAPPER, INSTALL, UNINSTALL]) {
    const stat = await Deno.stat(url);
    assert(stat.isFile, `${url.pathname} missing`);
    assert((stat.mode ?? 0) & 0o100, `${url.pathname} must be executable`);
  }
  const runbook = await Deno.readTextFile(RUNBOOK);
  assert(runbook.includes("loginctl enable-linger"), "reboot survival");
  assert(runbook.includes("uninstall-user-unit.sh"), "reversible uninstall");
  assert(runbook.includes("runtime/<binding>.json"), "inspectable runtime path");
  assert(runbook.includes("StartLimitBurst"), "bounded restart documented");
});

function exampleConfig(statePath: string): IngressConfig {
  return {
    schemaVersion: 1,
    statePath,
    bindings: {
      "example-project": {
        agent: "CobaltJaguar",
        mailScope: {
          kind: "project",
          projectPath: "/home/gulp/projects/tiny-claude-plugins",
        },
        codex: {
          adapter: "headless-app-server-owner",
          ownership: "explicit-handoff",
          threadId: "thread-o3",
          cwd: "/home/gulp/projects/tiny-claude-plugins",
          transport: { kind: "private-stdio" },
        },
        delivery: {
          batchWindowMs: 500,
          maxEvents: 50,
          maxBytes: 32768,
          urgentDuringTurn: "steer",
          routineDuringTurn: "queue",
        },
      },
    },
  };
}

Deno.test("O3 supervisor: publishes runtime snapshot and shuts down on abort", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o3-" });
  const statePath = `${tmp}/state.sqlite3`;
  const config = exampleConfig(statePath);
  const paths = resolveRuntimePaths(config, "example-project", {
    mailboxRoot: `${tmp}/mailbox`,
  });
  await Deno.mkdir(paths.mailboxRoot, { recursive: true });

  const snapshots: RuntimeSnapshot[] = [];
  const controller = new AbortController();
  let ticks = 0;
  const sleep = async (_ms: number, signal: AbortSignal) => {
    ticks += 1;
    if (ticks >= 2) controller.abort();
    await defaultSleep(1, signal);
  };

  const result = await runSupervisor({
    config,
    bindingName: "example-project",
    mailboxRoot: paths.mailboxRoot,
    signal: controller.signal,
    sleep,
    writeRuntime: async (path, snapshot) => {
      snapshots.push(snapshot);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, `${JSON.stringify(snapshot)}\n`);
    },
  });

  assert(result.ok, `expected ok shutdown, got ${result.reason}: ${result.detail}`);
  assertEquals(result.reason, "shutdown");
  assert(snapshots.length >= 1, "runtime snapshot written");
  const last = snapshots.at(-1)!;
  assertEquals(last.bindingId, "example-project");
  assertEquals(last.threadId, "thread-o3");
  assertEquals(last.owner, "headless");
  assertEquals(last.statePath, statePath);
  assert(
    last.runtimePath.endsWith("/example-project.json"),
    "runtime path ends with binding id",
  );
  const onDisk = JSON.parse(await Deno.readTextFile(paths.runtimePath));
  assertEquals(onDisk.threadId, "thread-o3");
});

Deno.test("O3 supervisor: second lease for same binding fails loud", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-o3-lease-" });
  const statePath = `${tmp}/state.sqlite3`;
  const config = exampleConfig(statePath);
  const mailboxRoot = `${tmp}/mailbox`;
  await Deno.mkdir(mailboxRoot, { recursive: true });

  const first = new AbortController();
  const firstDone = runSupervisor({
    config,
    bindingName: "example-project",
    mailboxRoot,
    ownerId: "supervisor:first",
    signal: first.signal,
    sleep: (ms, signal) => defaultSleep(ms, signal),
  });

  // Give the first supervisor time to acquire the lease.
  await defaultSleep(50, new AbortController().signal);

  const second = await runSupervisor({
    config,
    bindingName: "example-project",
    mailboxRoot,
    ownerId: "supervisor:second",
    signal: AbortSignal.abort(),
    sleep: () => Promise.resolve(),
  });
  first.abort();
  const firstResult = await firstDone;

  assert(firstResult.ok, `first supervisor should shut down cleanly: ${firstResult.detail}`);
  assert(!second.ok, "second supervisor must fail");
  assertEquals(second.reason, "lease_lost");
});
