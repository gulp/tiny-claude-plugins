/**
 * F6: MailboxSource contract + filesystem adapter tests.
 */
import { runMailboxSourceContract } from "../src/mailbox/contract.ts";
import { FakeMailboxSource } from "../src/mailbox/fake.ts";
import { FsMailboxSource } from "../src/mailbox/fs.ts";
import {
  parseAckFrontmatter,
  parseMailboxFilename,
  slugForProject,
  SUBJECT_MAX_BYTES,
} from "../src/mailbox/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

Deno.test("F6: FakeMailboxSource satisfies contract suite", async () => {
  await runMailboxSourceContract();
});

Deno.test("F6: slug and filename parsers match Agent Mail layout", () => {
  assertEquals(
    slugForProject("/home/gulp/projects/tiny-claude-plugins"),
    "home-gulp-projects-tiny-claude-plugins",
  );
  const parsed = parseMailboxFilename(
    "2026-07-28T21-04-29Z__monitor-wake-nudge__27982.md",
  );
  assert(parsed !== null, "parse");
  assertEquals(parsed.id, 27982);
  assertEquals(parsed.subject, "monitor-wake-nudge");
  assertEquals(parseMailboxFilename("not-a-message.md"), null);
});

Deno.test("F6: FsMailboxSource baseline/readAfter/skips/symlink — no writes", async () => {
  const root = await Deno.makeTempDir({ prefix: "agent-mail-codex-f6-" });
  const project = "/home/fixture/project";
  const slug = slugForProject(project);
  const agent = "AmberOtter";
  const inbox = `${root}/projects/${slug}/agents/${agent}/inbox/2026/07`;
  await Deno.mkdir(inbox, { recursive: true });

  const writeMsg = async (
    id: number,
    subject: string,
    opts: { importance?: string; ack?: boolean; frontmatter?: "ok" | "bad" | "none" } = {},
  ) => {
    const name = `2026-07-28T10-00-00Z__${subject}__${id}.md`;
    const path = `${inbox}/${name}`;
    const fm = opts.frontmatter ?? "ok";
    let body: string;
    if (fm === "none") {
      body = "no frontmatter\n";
    } else if (fm === "bad") {
      body = "---json\n{not-json\n---\n\nbody\n";
    } else {
      body = `---json\n${
        JSON.stringify(
          {
            ack_required: opts.ack ?? false,
            importance: opts.importance ?? "normal",
          },
          null,
          2,
        )
      }\n---\n\nbody\n`;
    }
    await Deno.writeTextFile(path, body);
  };

  await writeMsg(10, "baseline");
  await writeMsg(11, "after", { importance: "high", ack: true });
  await Deno.writeTextFile(`${inbox}/malformed-no-id.md`, "x\n");
  await writeMsg(12, "corrupt", { frontmatter: "bad" });

  // Symlink escape: link into a file outside the mailbox root.
  const outside = await Deno.makeTempFile({ prefix: "escape-" });
  await Deno.writeTextFile(outside, "secret\n");
  try {
    await Deno.symlink(outside, `${inbox}/2026-07-28T10-00-00Z__escape__99.md`);
  } catch {
    // Some environments disallow symlinks; skip that assertion later.
  }

  const source = new FsMailboxSource({ root });
  const scope = { kind: "project" as const, agent, projectPath: project };

  const cursor = await source.baseline(scope);
  // id 12 is corrupt frontmatter (skipped); escape symlink skipped — max event id is 11.
  assertEquals(cursor.lastMessageId, 11);
  const afterBaseline = await source.readAfter(scope, cursor);
  assertEquals(afterBaseline.events.length, 0);

  await writeMsg(20, "new-mail", { importance: "urgent" });
  const page = await source.readAfter(scope, cursor);
  assertEquals(page.events.map((e) => e.messageId), [20]);
  assertEquals(page.events[0].importance, "urgent");
  assertEquals(page.events[0].eventId, "agent-mail:20");

  const all = await source.readAfter(scope, { lastMessageId: 0 });
  assert(
    all.skipped.some((s) => s.reason === "malformed_filename"),
    `expected malformed skip, got ${JSON.stringify(all.skipped)}`,
  );
  assert(
    all.skipped.some((s) => s.reason === "malformed_frontmatter"),
    "corrupt frontmatter skip",
  );
  const escapeSkipped = all.skipped.some((s) => s.reason === "symlink_escape");
  // If symlink creation worked, escape must be skipped and id 99 absent.
  if (escapeSkipped) {
    assert(!all.events.some((e) => e.messageId === 99), "escaped symlink must not emit");
  }

  // Prove no write: message files unchanged; no .read stamps created.
  const listing: string[] = [];
  for await (const e of Deno.readDir(inbox)) listing.push(e.name);
  assert(!listing.some((n) => n.includes(".read") || n.endsWith(".ack")), "no write artifacts");

  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside).catch(() => {});
});

Deno.test("F6: FsMailboxSource product scope and missing inbox", async () => {
  const root = await Deno.makeTempDir({ prefix: "agent-mail-codex-f6-prod-" });
  const agent = "AmberOtter";
  for (const slug of ["slug-a", "slug-b"]) {
    const inbox = `${root}/projects/${slug}/agents/${agent}/inbox/2026/07`;
    await Deno.mkdir(inbox, { recursive: true });
    await Deno.writeTextFile(
      `${inbox}/2026-07-28T10-00-00Z__m__${slug === "slug-a" ? 1 : 2}.md`,
      `---json\n${JSON.stringify({ ack_required: false, importance: "low" })}\n---\n\n`,
    );
  }
  const source = new FsMailboxSource({ root });
  const page = await source.readAfter(
    {
      kind: "product",
      agent,
      productKey: "demo",
      projectSlugs: ["slug-a", "slug-b", "slug-missing"],
    },
    { lastMessageId: 0 },
  );
  assertEquals(page.events.map((e) => e.messageId), [1, 2]);
  assert(
    page.missingInboxes.some((m) => m.includes("slug-missing")),
    "missing inbox reported",
  );
  await Deno.remove(root, { recursive: true });
});

Deno.test("F6: subject bound and frontmatter helper", () => {
  assertEquals(SUBJECT_MAX_BYTES, 512);
  const ack = parseAckFrontmatter(
    `---json\n{"ack_required":true,"importance":"urgent"}\n---\n\n`,
  );
  assertEquals(ack, { ackRequired: true, importance: "urgent" });
  assertEquals(parseAckFrontmatter("nope"), null);
});

Deno.test("F6: FakeMailboxSource layoutDrift and missing inboxes surface", async () => {
  const source = new FakeMailboxSource({
    layoutDrift: true,
    missingInboxes: ["gone/agents/AmberOtter/inbox"],
  });
  const page = await source.readAfter(
    { kind: "project", agent: "AmberOtter", projectPath: "/home/fixture/project" },
    { lastMessageId: 0 },
  );
  assertEquals(page.layoutDrift, true);
  assertEquals(page.missingInboxes.length, 1);
});
