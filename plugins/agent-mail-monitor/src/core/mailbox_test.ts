// Unit tests for the durable git-mailbox reader (the deterministic core of the
// shadow tail). Builds a fake mailbox tree in a temp dir and asserts the reader:
//   1. derives the AM dir-mode project slug correctly;
//   2. parses id/ts/subject from the "__"-delimited filename (incl. subjects
//      that themselves contain "__");
//   3. snapshots across multiple slugs, sorted by id, read-only;
//   4. records a wholly-absent inbox dir in missingDirs (misconfig vs empty);
//   5. records an unparseable .md file in skipped (the corruption failure-mode
//      signal) instead of crashing.
//
// Run: deno test --allow-read --allow-write --allow-env src/core/mailbox_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { inboxDir, parseMailboxFilename, slugForProject, snapshotMailbox } from "./mailbox.ts";

Deno.test("slugForProject matches AM dir-mode slugging", () => {
  assertEquals(slugForProject("/home/gulp/Vaults/everything"), "home-gulp-vaults-everything");
  assertEquals(
    slugForProject("/home/gulp/Vaults/everything-tooling"),
    "home-gulp-vaults-everything-tooling",
  );
  assertEquals(
    slugForProject("/home/gulp/projects/tiny-claude-plugins"),
    "home-gulp-projects-tiny-claude-plugins",
  );
  // non-alphanumeric runs collapse to a single "-", edges trimmed.
  assertEquals(slugForProject("/x/atasozleriyle.xyz/"), "x-atasozleriyle-xyz");
});

Deno.test("parseMailboxFilename: id from tail, subject from middle", () => {
  const p = parseMailboxFilename("2026-07-24T20-15-31Z__re-desync-recurs__27652.md");
  assertEquals(p, { ts: "2026-07-24T20-15-31Z", subject: "re-desync-recurs", id: 27652 });

  // subject slug that itself contains "__" — id is still the LAST segment.
  const p2 = parseMailboxFilename("2026-07-24T10-00-00Z__weird__subject__100.md");
  assertEquals(p2?.id, 100);
  assertEquals(p2?.subject, "weird__subject");

  // REGRESSION (live smoke test, msg 27650): subject slugs carry SINGLE
  // underscores (`last_active_ts`), so a subject ending in `_` abuts the `__`
  // separator as `___<id>`. The id must still parse — `split("__")` mis-read
  // this as a `_27650` tail and false-flagged a healthy message as corruption.
  const p3 = parseMailboxFilename(
    "2026-07-24T20-11-48Z__last_active_ts-is-frozen-at-registration-agent-liveness-is-unreadable-from-list___27650.md",
  );
  assertEquals(p3?.id, 27650);
  assertEquals(p3?.ts, "2026-07-24T20-11-48Z");
  assert(p3!.subject.startsWith("last_active_ts-is-frozen"));

  // non-numeric tail => not an id-bearing message file.
  assertEquals(parseMailboxFilename("README.md"), null);
  assertEquals(parseMailboxFilename("2026__notanid.md"), null);
  // not markdown.
  assertEquals(parseMailboxFilename("2026-07-24T10-00-00Z__x__5.txt"), null);
});

async function writeMsg(dir: string, name: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${name}`, "---json\n{}\n---\nbody\n");
}

Deno.test("snapshotMailbox: sorted across slugs, missingDirs + skipped recorded", async () => {
  const root = await Deno.makeTempDir({ prefix: "mailbox-test-" });
  const agent = "WindyBarn";
  const slugA = "proj-a";
  const slugB = "proj-b";
  const slugMissing = "proj-missing";

  try {
    // proj-a: two messages under YYYY/MM, out of id order on disk.
    const aDir = `${inboxDir(root, slugA, agent)}/2026/07`;
    await writeMsg(aDir, "2026-07-24T11-00-00Z__second__20.md");
    await writeMsg(aDir, "2026-07-24T10-00-00Z__first__10.md");
    // proj-a also has an unparseable file (corruption signal) — must be skipped.
    await writeMsg(aDir, "garbage-no-id.md");
    // proj-b: one message.
    const bDir = `${inboxDir(root, slugB, agent)}/2026/07`;
    await writeMsg(bDir, "2026-07-24T12-00-00Z__third__30.md");

    const snap = await snapshotMailbox(root, [slugA, slugB, slugMissing], agent);

    // (3) sorted by id ascending across BOTH present slugs.
    assertEquals(snap.entries.map((e) => e.id), [10, 20, 30]);
    assertEquals(snap.entries.map((e) => e.project), [slugA, slugA, slugB]);
    assertEquals(snap.entries[0].subject, "first");
    // (4) the wholly-absent slug's inbox dir is recorded, not silently dropped.
    assertEquals(snap.missingDirs.length, 1);
    assert(snap.missingDirs[0].includes(slugMissing));
    // (5) the unparseable file is recorded as skipped, not crashed on.
    assertEquals(snap.skipped.length, 1);
    assert(snap.skipped[0].endsWith("garbage-no-id.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("snapshotMailbox: empty root => all slugs missing, no entries", async () => {
  const root = await Deno.makeTempDir({ prefix: "mailbox-empty-" });
  try {
    const snap = await snapshotMailbox(root, ["proj-a", "proj-b"], "Nobody");
    assertEquals(snap.entries.length, 0);
    assertEquals(snap.missingDirs.length, 2);
    assertEquals(snap.skipped.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
