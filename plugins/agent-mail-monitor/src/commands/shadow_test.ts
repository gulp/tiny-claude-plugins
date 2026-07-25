// Unit tests for `checkDesync` — the tcp-p0x.16.5 on-demand desync cross-check
// (repurposed shadow Part B). Builds a fake canonical mailbox tree (like
// mailbox_test.ts) alongside a fake SQLite store (schema-minimal: just the
// tables/columns `checkDesync` actually reads), then asserts:
//   1. an id present in both stores is NOT reported as lagging;
//   2. an id present only on disk (SQLite hasn't caught up) IS reported lagging;
//   3. an identity with no `agents` row for the project is a distinct "every id
//      lags" case, not a crash;
//   4. a missing/unopenable SQLite file surfaces as `dbUnavailable`, not a throw,
//      and is NOT itself counted as "lagging" (can't verify != verified behind);
//   5. THE LOAD-BEARING AC: the check never touches `read_ts` — a sentinel value
//      set before the check is byte-identical after it, proven by reopening the
//      db and reading the row back directly (not by trusting `checkDesync`'s
//      own report).
//
// Run: deno test --allow-read --allow-write --allow-env src/commands/shadow_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { DatabaseSync } from "node:sqlite";
import { checkDesync } from "./shadow.ts";
import { inboxDir } from "../core/mailbox.ts";

const READ_TS_SENTINEL = 999888777;

/** Minimal schema — only the tables/columns `checkDesync`'s SQL actually reads
 *  (projects.slug, agents.project_id/name, message_recipients.message_id/agent_id).
 *  Real am also carries `messages`/`ack_ts`/etc — irrelevant here. */
function buildFixtureDb(
  path: string,
  rows: {
    projectId: number;
    slug: string;
    agentId: number;
    agentName: string;
    delivered: number[]; // message ids SQLite already has a recipient row for
  }[],
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL);
    CREATE TABLE message_recipients (
      message_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      read_ts INTEGER,
      PRIMARY KEY (message_id, agent_id)
    );
  `);
  const insProject = db.prepare(`INSERT INTO projects (id, slug) VALUES (?, ?)`);
  const insAgent = db.prepare(`INSERT INTO agents (id, project_id, name) VALUES (?, ?, ?)`);
  const insRecipient = db.prepare(
    `INSERT INTO message_recipients (message_id, agent_id, read_ts) VALUES (?, ?, ?)`,
  );
  for (const r of rows) {
    insProject.run(r.projectId, r.slug);
    insAgent.run(r.agentId, r.projectId, r.agentName);
    for (const id of r.delivered) insRecipient.run(id, r.agentId, READ_TS_SENTINEL);
  }
  db.close();
}

async function writeCanonicalMsg(
  root: string,
  slug: string,
  agent: string,
  ts: string,
  subject: string,
  id: number,
): Promise<void> {
  const dir = `${inboxDir(root, slug, agent)}/${ts.slice(0, 4)}/${ts.slice(5, 7)}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${ts}__${subject}__${id}.md`, "---json\n{}\n---\nbody\n");
}

Deno.test("checkDesync: corroborated id is not lagging; SQLite-missing id is", async () => {
  const root = await Deno.makeTempDir({ prefix: "shadow-desync-" });
  try {
    await writeCanonicalMsg(root, "proj-a", "WindyBarn", "2026-07-24T10-00-00Z", "first", 10);
    await writeCanonicalMsg(root, "proj-a", "WindyBarn", "2026-07-24T11-00-00Z", "second", 20);

    const dbPath = `${root}/storage.sqlite3`;
    buildFixtureDb(dbPath, [
      { projectId: 1, slug: "proj-a", agentId: 1, agentName: "WindyBarn", delivered: [10] },
    ]);

    const result = await checkDesync({ root, slugs: ["proj-a"], agent: "WindyBarn", dbPath });
    assertEquals(result.dbUnavailable, null);
    assertEquals(result.checked, 2);
    assertEquals(result.lagging.map((e) => e.id), [20], "only #20 is SQLite-lags-canonical");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDesync: identity unknown to SQLite in this project -> every id lags, no crash", async () => {
  const root = await Deno.makeTempDir({ prefix: "shadow-desync-unknown-agent-" });
  try {
    await writeCanonicalMsg(root, "proj-a", "GreenWillow", "2026-07-24T10-00-00Z", "first", 10);

    const dbPath = `${root}/storage.sqlite3`;
    // SQLite knows proj-a and a DIFFERENT agent, but never "GreenWillow".
    buildFixtureDb(dbPath, [
      { projectId: 1, slug: "proj-a", agentId: 1, agentName: "SomeoneElse", delivered: [10] },
    ]);

    const result = await checkDesync({ root, slugs: ["proj-a"], agent: "GreenWillow", dbPath });
    assertEquals(result.dbUnavailable, null);
    assertEquals(result.lagging.map((e) => e.id), [10]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDesync: missing SQLite store -> dbUnavailable, not a throw, not counted as lagging", async () => {
  const root = await Deno.makeTempDir({ prefix: "shadow-desync-nodb-" });
  try {
    await writeCanonicalMsg(root, "proj-a", "WindyBarn", "2026-07-24T10-00-00Z", "first", 10);

    const result = await checkDesync({
      root,
      slugs: ["proj-a"],
      agent: "WindyBarn",
      dbPath: `${root}/no-such-storage.sqlite3`,
    });
    assert(result.dbUnavailable !== null, "an absent store must surface as dbUnavailable");
    assertEquals(result.lagging, [], "cannot-verify must not be reported as verified-lagging");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDesync: NEVER touches read_ts (the load-bearing non-consuming AC)", async () => {
  const root = await Deno.makeTempDir({ prefix: "shadow-desync-readts-" });
  try {
    await writeCanonicalMsg(root, "proj-a", "WindyBarn", "2026-07-24T10-00-00Z", "first", 10);
    await writeCanonicalMsg(root, "proj-a", "WindyBarn", "2026-07-24T11-00-00Z", "second", 20);

    const dbPath = `${root}/storage.sqlite3`;
    buildFixtureDb(dbPath, [
      { projectId: 1, slug: "proj-a", agentId: 1, agentName: "WindyBarn", delivered: [10] },
    ]);

    const result = await checkDesync({ root, slugs: ["proj-a"], agent: "WindyBarn", dbPath });
    assertEquals(result.lagging.map((e) => e.id), [20]); // sanity: the check did real work

    // Do NOT trust checkDesync's own report — reopen the db independently
    // (read-write, so a write would be visible either way) and read the row
    // back directly. It must still carry the exact sentinel written before the
    // check ran: a byte-identical read_ts proves no UPDATE ever landed.
    const verify = new DatabaseSync(dbPath);
    try {
      const row = verify.prepare(
        `SELECT read_ts FROM message_recipients WHERE message_id = 10 AND agent_id = 1`,
      ).get() as { read_ts: number } | undefined;
      assert(row, "the fixture row must still exist");
      assertEquals(
        row!.read_ts,
        READ_TS_SENTINEL,
        "read_ts must be byte-identical — never marked read",
      );
    } finally {
      verify.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
