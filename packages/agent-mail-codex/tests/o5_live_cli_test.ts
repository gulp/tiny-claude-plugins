/// <reference lib="deno.window" />

import { main } from "../src/cli.ts";
import {
  InProcessLiveOwnershipAuthority,
  type LiveOwnerSnapshot,
  serveUnixLiveOwnership,
} from "../src/operator/live_ownership.ts";
import { EXIT } from "../src/errors.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function configAt(tmp: string): Promise<string> {
  const path = `${tmp}/config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      statePath: `${tmp}/state.sqlite3`,
      bindings: {
        demo: {
          agent: "BeigeHorizon",
          mailScope: { kind: "project", projectPath: tmp },
          codex: {
            adapter: "headless-app-server-owner",
            ownership: "explicit-handoff",
            threadId: "thread-exact",
            cwd: tmp,
            transport: { kind: "private-stdio" },
          },
          delivery: {
            batchWindowMs: 500,
            maxEvents: 50,
            maxBytes: 32768,
            urgentDuringTurn: "queue",
            routineDuringTurn: "queue",
          },
        },
      },
    }),
  );
  return path;
}

Deno.test("O5 CLI release reaches live daemon and retry is idempotent", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "o5-live-cli-" });
  let state: LiveOwnerSnapshot = {
    bindingId: "demo",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: [],
    connection: "open",
    soleOwnershipProven: true,
    revision: 1,
  };
  let releases = 0;
  const authority = new InProcessLiveOwnershipAuthority({
    snapshot: () => Promise.resolve(state),
    releaseOwnership: () => {
      releases++;
      state = {
        ...state,
        owner: "human",
        soleOwnershipProven: false,
        revision: 2,
      };
      return Promise.resolve();
    },
    closeConnection: () => {
      state = { ...state, connection: "closed" };
      return Promise.resolve();
    },
    acquireOwnership: () => Promise.resolve(),
  });
  const socket = `${tmp}/runtime/demo.ownership.sock`;
  const server = await serveUnixLiveOwnership(socket, authority);
  const config = await configAt(tmp);
  const args = [
    "binding",
    "release-owner",
    "demo",
    "--to",
    "human",
    "--config",
    config,
    "--control-socket",
    socket,
    "--request-id",
    "release-stable",
    "--json",
  ];
  try {
    assert(await main(args) === EXIT.OK, "first release");
    assert(await main(args) === EXIT.OK, "idempotent retry");
    assert(releases === 1, `release calls=${releases}`);
    const owner = JSON.parse(
      await Deno.readTextFile(`${tmp}/owner-state/demo.json`),
    );
    assert(owner.owner === "human", "human state persisted after ack");
  } finally {
    await server.close();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("O5 CLI daemon absence is loud and creates no owner state", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "o5-no-daemon-" });
  const config = await configAt(tmp);
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const code = await main([
      "binding",
      "release-owner",
      "demo",
      "--to",
      "human",
      "--config",
      config,
      "--control-socket",
      `${tmp}/missing.sock`,
      "--request-id",
      "absent",
    ]);
    assert(code === EXIT.OWNERSHIP, `exit=${code}`);
    assert(errors.join("\n").includes("daemon_absent"), errors.join("\n"));
    let exists = true;
    try {
      await Deno.stat(`${tmp}/owner-state/demo.json`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) exists = false;
      else throw error;
    }
    assert(!exists, "state-only success forbidden");
  } finally {
    console.error = original;
    await Deno.remove(tmp, { recursive: true });
  }
});
