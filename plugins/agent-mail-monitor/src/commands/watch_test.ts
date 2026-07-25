// Integration test for the watch loop (tcp-p0x.16.1 single-project promotion +
// tcp-p0x.16.2 MAIL_WATCH_SCOPE multi-slug support + tcp-p0x.16.3 source-
// project slug tagging).
//
// Drives runWatch against a REAL temp mailbox tree on disk (no fake `am` needed
// now that the backend is `snapshotMailbox`, not check-inbox). Asserts the
// tcp-p0x.16.1 acceptance criteria:
//   1. a watermark seeded at arm time suppresses replay of pre-existing mail;
//   2. a new .md file that appears after arm fires exactly once;
//   3. a missing/empty inbox arms cleanly (no throw, exits OK on shutdown).
// ...and the tcp-p0x.16.2 acceptance criteria:
//   4. MAIL_WATCH_SCOPE unset/"project" reproduces (1)-(3) exactly — a
//      single-element `slugs` array is byte-identical to the old singular
//      `slug` field (asserted implicitly: every test above now passes
//      `slugs: [slug]` and still passes unchanged);
//   5. runWatch tailing MULTIPLE slugs (what scope=all resolves to) fires for
//      a new message in EITHER project, not just the first;
//   6. resolveScopeSlugs: "project" -> [projectSlug]; "all" -> every inbox dir
//      for the agent (delegates to mailbox.ts listInboxSlugs); "product" ->
//      throws AppError(USAGE) rather than silently falling back (deferred,
//      tcp-p0x.16.2 non-goal).
// ...and the tcp-p0x.16.3 acceptance criteria (delivers the original
// tcp-p0x.6 AC — a notification names which project the mail landed in):
//   7. the notification format `MAIL #<id> [<slug>] <ts>: <subject>` holds
//      in BOTH "project" and "all" scope — the slug tag is not omitted for
//      single-project (test 1, above, now asserts this too);
//   8. under "all" scope, each line's tag names ITS OWN origin project, not
//      just "some" project — two concurrent notifications stay distinctly
//      identifiable (test 5, above, now asserts this too).
//
// ...and tcp-p0x.7 (ack/urgency-aware watch, FS frontmatter backing):
//   9. MAIL_WATCH_MODE=actionable tags an ack-required message with
//      (ACK-REQUIRED) and a high/urgent-importance message with (URGENT),
//      sourced from the message .md's own frontmatter (mailbox.ts readAckInfo).
//  10. MAIL_WATCH_FILTER=ack|urgent suppresses a new message that doesn't
//      match — independent of mode.
//  11. the default (mode/filter both unset) reproduces the pre-tcp-p0x.7 line
//      byte-for-byte, even when the underlying message IS ack-required/urgent
//      — basic mode never reads that frontmatter.
//
// Run: deno test --allow-read --allow-write --allow-env src/commands/watch_test.ts

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { resolveScopeSlugs, runWatch } from "./watch.ts";
import { inboxDir, listInboxSlugs, snapshotMailbox } from "../core/mailbox.ts";
import { AppError, ExitCode } from "../core/exit.ts";

async function writeMsg(dir: string, name: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${name}`, "---json\n{}\n---\nbody\n");
}

/** Like `writeMsg`, but with a real ack_required/importance frontmatter block
 *  (tcp-p0x.7 fixtures). */
async function writeMsgWithAck(
  dir: string,
  name: string,
  fields: { ackRequired: boolean; importance: string },
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const json = JSON.stringify({ ack_required: fields.ackRequired, importance: fields.importance });
  await Deno.writeTextFile(`${dir}/${name}`, `---json\n${json}\n---\nbody\n`);
}

/** Capture console.log lines produced while `fn` runs. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// tcp-p0x.16.3: the FORMALIZED notification format — `MAIL #<id> [<slug>]
// <ts>: <subject>`. The source-project slug tag is present in EVERY scope,
// including single-project "project" (the bead's Constraints leave this a
// choice — decision: keep it for consistency, not conditional formatting; see
// the format tests below and formatLine's doc in watch.ts).
const MAIL_LINE_RE = /^MAIL #(\d+) \[([^\]]+)\] (\S+): (.*)$/;

Deno.test("watch: seeded watermark suppresses replay; a new file fires exactly once", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-test-" });
  const agent = "Tester";
  const slug = "proj-x";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    // Pre-existing mail BEFORE the watch ever arms — the baseline watermark
    // must silently adopt this, never replay it.
    await writeMsg(dir, "2026-07-24T10-00-00Z__old__10.md");

    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({ agent, root, slugs: [slug], interval: 1, signal: ac.signal });

      // Let the baseline poll happen — pre-existing id=10 must not be emitted.
      await new Promise((r) => setTimeout(r, 1200));

      // A genuinely new message arrives after arm — must fire once.
      await writeMsg(dir, "2026-07-24T11-00-00Z__fresh__20.md");
      await new Promise((r) => setTimeout(r, 1200));

      // A further poll with nothing new must NOT re-emit id=20.
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `expected exactly 1 MAIL line, got: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#20"), `expected #20 in: ${mailLines[0]}`);
    assert(
      !mailLines.some((l) => l.includes("#10")),
      "pre-existing mail must not be replayed at arm (seeded watermark)",
    );
    // tcp-p0x.16.3: project scope still tags the source-project slug.
    const m = mailLines[0].match(MAIL_LINE_RE);
    assert(m, `notification line does not match the documented format: ${mailLines[0]}`);
    assertEquals(m![2], slug, "project scope must tag the source-project slug");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch: --since replays existing mail above the id once, at startup only", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-since-test-" });
  const agent = "Tester";
  const slug = "proj-y";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    await writeMsg(dir, "2026-07-24T10-00-00Z__old__10.md");
    await writeMsg(dir, "2026-07-24T10-05-00Z__above__15.md");

    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        since: 10,
        interval: 1,
        signal: ac.signal,
      });
      // First poll replays anything with id > 10 once (id=15).
      await new Promise((r) => setTimeout(r, 1200));
      // A second poll with nothing new must not re-emit id=15.
      await new Promise((r) => setTimeout(r, 1200));
      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `expected exactly 1 MAIL line, got: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#15"));
    assert(!mailLines.some((l) => l.includes("#10")), "id at/under --since must not replay");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch: missing/empty inbox arms cleanly, no throw, exits OK", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-empty-test-" });
  try {
    const ac = new AbortController();
    let code: number | undefined;
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent: "Nobody",
        root,
        slugs: ["proj-missing"],
        interval: 1,
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      code = await done;
    });

    assertEquals(code, 0, "watch must exit OK, not fail loud, on a missing inbox dir");
    assert(
      lines.some((l) => l.includes("no mailbox inbox dir found")),
      "missing inbox should be a warned-once notice, not silent",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- tcp-p0x.16.2: MAIL_WATCH_SCOPE=all — runWatch over multiple slugs -------

Deno.test("watch: scope=all (multiple slugs) fires for a new message in EITHER project", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-all-test-" });
  const agent = "Tester";
  const slugA = "proj-a";
  const slugB = "proj-b";
  const dirA = `${inboxDir(root, slugA, agent)}/2026/07`;
  const dirB = `${inboxDir(root, slugB, agent)}/2026/07`;

  try {
    // Pre-existing mail in BOTH projects before arm — neither must replay.
    await writeMsg(dirA, "2026-07-24T10-00-00Z__old-a__10.md");
    await writeMsg(dirB, "2026-07-24T10-00-00Z__old-b__11.md");

    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slugA, slugB],
        interval: 1,
        signal: ac.signal,
      });

      // Baseline poll — pre-existing ids 10/11 must not be emitted.
      await new Promise((r) => setTimeout(r, 1200));

      // A new message in project B (not the first slug) must still fire.
      await writeMsg(dirB, "2026-07-24T11-00-00Z__fresh-b__21.md");
      await new Promise((r) => setTimeout(r, 1200));

      // A new message in project A must ALSO fire (both slugs stay live).
      await writeMsg(dirA, "2026-07-24T11-05-00Z__fresh-a__22.md");
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      2,
      `expected exactly 2 MAIL lines, got: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines.some((l) => l.includes("#21") && l.includes("[proj-b]")));
    assert(mailLines.some((l) => l.includes("#22") && l.includes("[proj-a]")));
    assert(
      !mailLines.some((l) => l.includes("#10") || l.includes("#11")),
      "pre-existing mail in either project must not be replayed at arm",
    );
    // tcp-p0x.16.3: each line's slug tag matches ITS OWN origin project, not
    // just "some slug" — the two notifications must be distinctly identifiable.
    const tags = mailLines.map((l) => {
      const m = l.match(MAIL_LINE_RE);
      assert(m, `notification line does not match the documented format: ${l}`);
      return m![2];
    });
    assertEquals(new Set(tags), new Set([slugA, slugB]), "all scope: distinct source-project tags");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch: scope=all does not warn 'missing' when only SOME slugs have an inbox", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-partial-test-" });
  const agent = "Tester";
  const slugA = "proj-partial-a";
  const slugB = "proj-partial-b"; // deliberately never created
  const dirA = `${inboxDir(root, slugA, agent)}/2026/07`;

  try {
    await writeMsg(dirA, "2026-07-24T10-00-00Z__seed__1.md");

    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slugA, slugB],
        interval: 1,
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1200));
      ac.abort();
      await done;
    });

    assert(
      !lines.some((l) => l.includes("no mailbox inbox dir found")),
      "a partial miss (one slug present) must not be treated as the misconfig/empty case",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- tcp-p0x.16.2: resolveScopeSlugs -----------------------------------------

Deno.test("resolveScopeSlugs: 'project' resolves to exactly [projectSlug]", async () => {
  const slugs = await resolveScopeSlugs({
    scope: "project",
    root: "/does/not/matter",
    agent: "Tester",
    projectSlug: "home-gulp-my-proj",
  });
  assertEquals(slugs, ["home-gulp-my-proj"]);
});

Deno.test("resolveScopeSlugs: 'all' delegates to mailbox.ts listInboxSlugs", async () => {
  const root = await Deno.makeTempDir({ prefix: "resolve-all-test-" });
  const agent = "Tester";
  try {
    await writeMsg(`${inboxDir(root, "proj-1", agent)}/2026/07`, "2026-07-24T10-00-00Z__x__1.md");
    await writeMsg(`${inboxDir(root, "proj-2", agent)}/2026/07`, "2026-07-24T10-00-00Z__y__2.md");
    // A different agent's inbox must NOT leak into this agent's "all" scope.
    await writeMsg(
      `${inboxDir(root, "proj-3", "OtherAgent")}/2026/07`,
      "2026-07-24T10-00-00Z__z__3.md",
    );

    const [viaResolve, viaMailbox] = await Promise.all([
      resolveScopeSlugs({ scope: "all", root, agent, projectSlug: "unused" }),
      listInboxSlugs(root, agent),
    ]);

    assertEquals(viaResolve, ["proj-1", "proj-2"]);
    assertEquals(
      viaResolve,
      viaMailbox,
      "resolveScopeSlugs('all') must match listInboxSlugs exactly",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- tcp-p0x.12: recovery is lossless w.r.t. read-state -----------------------
//
// The bug: the RETIRED check-inbox backend re-fetched the UNREAD set on recovery,
// so a message that arrived during a poll outage and was read elsewhere before
// recovery was silently dropped. The FS backend reads the on-disk file, which
// read/ack state can't remove — so recovery is lossless. This test reproduces the
// four-step repro faithfully: baseline, an OUTAGE (the snapshot throws for two
// ticks) during which a new message lands on disk, then recovery — and asserts
// the straddling message fires EXACTLY ONCE. The injected snapshot is the only
// way to reproduce a poll outage; on the recovery tick it delegates to the real
// snapshotMailbox, so the message is emitted from the genuine on-disk read. The
// "read elsewhere" dimension needs no simulation: the watch never consults
// read-state, so a concurrent ack is a no-op by construction — the file's mere
// presence drives emission, which is exactly the property the old backend lacked.
Deno.test("watch (tcp-p0x.12): a message straddling a poll outage still fires exactly once on recovery", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-outage-test-" });
  const agent = "Tester";
  const slug = "proj-outage";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    // Baseline mail present before arm — adopted silently as the watermark.
    await writeMsg(dir, "2026-07-24T10-00-00Z__baseline__10.md");

    let call = 0;
    let arrivedDuringOutage = false;
    // Ticks 2 and 3 THROW (the outage). On tick 2 we also land a new message on
    // disk — it "arrives during the outage". Every other tick delegates to the
    // real on-disk snapshot, so recovery reads the genuine file set.
    const flakySnapshot = async (r: string, s: string[], a: string) => {
      call++;
      if (call === 2 && !arrivedDuringOutage) {
        await writeMsg(dir, "2026-07-24T11-00-00Z__straddler__20.md");
        arrivedDuringOutage = true;
      }
      if (call === 2 || call === 3) {
        throw new Error(`simulated poll outage (tick ${call})`);
      }
      return await snapshotMailbox(r, s, a);
    };

    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        interval: 1,
        signal: ac.signal,
        snapshot: flakySnapshot,
      });
      // Tick 1 baselines (id=10). Ticks 2-3 are the outage (throw, retry). Tick 4+
      // recovers and must emit id=20. Give it enough ticks to get past recovery.
      await new Promise((r) => setTimeout(r, 5000));
      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `expected exactly 1 MAIL line (lossless, no dup) — got: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#20"), `the straddling message must fire: ${mailLines[0]}`);
    assert(
      !mailLines.some((l) => l.includes("#10")),
      "pre-existing baseline mail must not be replayed",
    );
    // The outage must have been exercised, not skipped — else the test is hollow.
    assert(call >= 4, `expected the loop to survive the outage into recovery (calls=${call})`);
    assert(
      lines.some((l) => l.includes("snapshot error")),
      "the degraded-tick notice should have fired during the outage",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- tcp-p0x.7: MAIL_WATCH_MODE / MAIL_WATCH_FILTER (ack/urgency-aware watch) -
//
// Acceptance criteria: (1) an ack-required message gets the marker in
// actionable mode; (2) filter mode suppresses a non-matching message; (3)
// basic mode (default) is byte-for-byte unchanged, even when the frontmatter
// carries ack/urgent data it simply never reads.

Deno.test("watch (tcp-p0x.7): actionable mode tags an ack-required message with (ACK-REQUIRED)", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-actionable-ack-" });
  const agent = "Tester";
  const slug = "proj-ack";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        interval: 1,
        mode: "actionable",
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1200)); // baseline, nothing yet

      await writeMsgWithAck(dir, "2026-07-24T11-00-00Z__ack-me__20.md", {
        ackRequired: true,
        importance: "normal",
      });
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `expected exactly 1 MAIL line, got: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#20"));
    assert(
      mailLines[0].includes("(ACK-REQUIRED)"),
      `expected an (ACK-REQUIRED) marker: ${mailLines[0]}`,
    );
    // Marker sits between <ts> and the colon, per the module doc's format.
    assert(
      /Z \(ACK-REQUIRED\): /.test(mailLines[0]),
      `marker must sit between <ts> and the colon: ${mailLines[0]}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch (tcp-p0x.7): actionable mode tags a high/urgent-importance message with (URGENT)", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-actionable-urgent-" });
  const agent = "Tester";
  const slug = "proj-urgent";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        interval: 1,
        mode: "actionable",
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1200));

      await writeMsgWithAck(dir, "2026-07-24T11-00-00Z__fire__20.md", {
        ackRequired: false,
        importance: "urgent",
      });
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(mailLines.length, 1);
    assert(mailLines[0].includes("(URGENT)"), `expected an (URGENT) marker: ${mailLines[0]}`);
    assert(
      !mailLines[0].includes("ACK-REQUIRED"),
      "must not tag ACK-REQUIRED for a non-ack message",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch (tcp-p0x.7): MAIL_WATCH_FILTER=ack suppresses a non-ack-required message", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-filter-ack-" });
  const agent = "Tester";
  const slug = "proj-filter-ack";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        interval: 1,
        filter: "ack",
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1200)); // baseline

      await writeMsgWithAck(dir, "2026-07-24T11-00-00Z__plain__20.md", {
        ackRequired: false,
        importance: "normal",
      });
      await new Promise((r) => setTimeout(r, 1200));

      await writeMsgWithAck(dir, "2026-07-24T11-05-00Z__needs-ack__21.md", {
        ackRequired: true,
        importance: "normal",
      });
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `filter=ack must suppress the non-ack message: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#21"));
    assert(!mailLines.some((l) => l.includes("#20")), "non-ack message #20 must be suppressed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch (tcp-p0x.7): MAIL_WATCH_FILTER=urgent suppresses a normal-importance message", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-filter-urgent-" });
  const agent = "Tester";
  const slug = "proj-filter-urgent";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    const ac = new AbortController();
    const lines = await captureLog(async () => {
      const done = runWatch({
        agent,
        root,
        slugs: [slug],
        interval: 1,
        filter: "urgent",
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1200));

      await writeMsgWithAck(dir, "2026-07-24T11-00-00Z__routine__20.md", {
        ackRequired: true, // ack-required but NOT urgent — must still be suppressed
        importance: "normal",
      });
      await new Promise((r) => setTimeout(r, 1200));

      await writeMsgWithAck(dir, "2026-07-24T11-05-00Z__fire__21.md", {
        ackRequired: false,
        importance: "high",
      });
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(
      mailLines.length,
      1,
      `filter=urgent must suppress the normal message: ${JSON.stringify(mailLines)}`,
    );
    assert(mailLines[0].includes("#21"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch (tcp-p0x.7): default (basic) mode is byte-for-byte unchanged, even with ack/urgent frontmatter present", async () => {
  const root = await Deno.makeTempDir({ prefix: "watch-basic-unchanged-" });
  const agent = "Tester";
  const slug = "proj-basic";
  const dir = `${inboxDir(root, slug, agent)}/2026/07`;

  try {
    const ac = new AbortController();
    const lines = await captureLog(async () => {
      // mode/filter both omitted -> defaults (basic, no filter) — the exact
      // same call shape T1/tcp-p0x.16.x tests use above.
      const done = runWatch({ agent, root, slugs: [slug], interval: 1, signal: ac.signal });
      await new Promise((r) => setTimeout(r, 1200));

      // This message is ack-required AND urgent — basic mode must still emit
      // the pre-tcp-p0x.7 line shape, untouched.
      await writeMsgWithAck(dir, "2026-07-24T11-00-00Z__loaded__20.md", {
        ackRequired: true,
        importance: "urgent",
      });
      await new Promise((r) => setTimeout(r, 1200));

      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    assertEquals(mailLines.length, 1);
    assertEquals(
      mailLines[0],
      `MAIL #20 [${slug}] 2026-07-24T11-00-00Z: loaded`,
      "basic mode must not insert any marker, regardless of the message's frontmatter",
    );
    const m = mailLines[0].match(MAIL_LINE_RE);
    assert(m, `basic-mode line must still match the original format regex: ${mailLines[0]}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveScopeSlugs: 'product' is a loud deferred stub, not a silent fallback", async () => {
  await assertRejects(
    () =>
      resolveScopeSlugs({
        scope: "product",
        root: "/does/not/matter",
        agent: "Tester",
        projectSlug: "home-gulp-my-proj",
        productKey: "my-product",
      }),
    AppError,
  );
  try {
    await resolveScopeSlugs({
      scope: "product",
      root: "/does/not/matter",
      agent: "Tester",
      projectSlug: "home-gulp-my-proj",
    });
    throw new Error("expected resolveScopeSlugs to throw for scope=product");
  } catch (e) {
    assert(e instanceof AppError);
    assertEquals(e.code, ExitCode.USAGE);
  }
});
