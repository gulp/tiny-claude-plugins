// Integration test for the single-project watch loop (tcp-p0x.16.1).
//
// Drives runWatch against a REAL temp mailbox tree on disk (no fake `am` needed
// now that the backend is `snapshotMailbox`, not check-inbox). Asserts the
// promotion's acceptance criteria:
//   1. a watermark seeded at arm time suppresses replay of pre-existing mail;
//   2. a new .md file that appears after arm fires exactly once;
//   3. a missing/empty inbox arms cleanly (no throw, exits OK on shutdown).
//
// Run: deno test --allow-read --allow-write --allow-env src/commands/watch_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { runWatch } from "./watch.ts";
import { inboxDir } from "../core/mailbox.ts";

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
      const done = runWatch({ agent, root, slug, interval: 1, signal: ac.signal });

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
      const done = runWatch({ agent, root, slug, since: 10, interval: 1, signal: ac.signal });
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
        slug: "proj-missing",
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
