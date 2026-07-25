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
// Run: deno test --allow-read --allow-write --allow-env src/commands/watch_test.ts

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { resolveScopeSlugs, runWatch } from "./watch.ts";
import { inboxDir, listInboxSlugs } from "../core/mailbox.ts";
import { AppError, ExitCode } from "../core/exit.ts";

async function writeMsg(dir: string, name: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${name}`, "---json\n{}\n---\nbody\n");
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
