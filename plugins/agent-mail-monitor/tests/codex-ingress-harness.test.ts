import { CodexIngressHarness, standardMailScenarios } from "./codex-ingress-harness.ts";
import { parseAckInfo, snapshotMailbox } from "../src/core/mailbox.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const encode = (value: unknown) =>
    JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item);
  if (encode(actual) !== encode(expected)) {
    throw new Error(
      message || `expected ${encode(expected)}, got ${encode(actual)}`,
    );
  }
}

function deterministicClock(): () => bigint {
  let tick = 0n;
  return () => ++tick * 100n;
}

Deno.test("fixture writer emits ordered, urgent, ack-required, and malformed mail", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-ingress-fixture-" });
  try {
    const harness = new CodexIngressHarness({
      root,
      project: "/fixture/project",
      agent: "CobaltJaguar",
      nowNs: deterministicClock(),
    });
    const written = await harness.writeBurst(standardMailScenarios());
    const snapshot = await snapshotMailbox(root, ["fixture-project"], "CobaltJaguar");

    assertEquals(snapshot.entries.map((entry) => entry.id), [1, 2, 3, 4, 5]);
    assertEquals(written.map((entry) => entry.writtenAtNs), [100n, 200n, 300n, 400n, 500n]);
    assertEquals(
      parseAckInfo(await Deno.readTextFile(written[2].path)),
      { ackRequired: false, importance: "urgent" },
    );
    assertEquals(
      parseAckInfo(await Deno.readTextFile(written[3].path)),
      { ackRequired: true, importance: "normal" },
    );
    assertEquals(parseAckInfo(await Deno.readTextFile(written[4].path)), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fixture output is byte-for-byte deterministic across repeated runs", async () => {
  const roots = await Promise.all([
    Deno.makeTempDir({ prefix: "codex-ingress-repeat-a-" }),
    Deno.makeTempDir({ prefix: "codex-ingress-repeat-b-" }),
  ]);
  try {
    const contents: string[][] = [];
    for (const root of roots) {
      const harness = new CodexIngressHarness({
        root,
        project: "/fixture/project",
        agent: "CobaltJaguar",
        nowNs: deterministicClock(),
      });
      const written = await harness.writeBurst(standardMailScenarios());
      contents.push(await Promise.all(written.map((entry) => Deno.readTextFile(entry.path))));
    }
    assertEquals(contents[0], contents[1]);
  } finally {
    await Promise.all(roots.map((root) => Deno.remove(root, { recursive: true })));
  }
});

Deno.test("measurement harness captures raw JSON-RPC, transcripts, process output, and time", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-ingress-evidence-" });
  try {
    const harness = new CodexIngressHarness({
      root,
      project: "/fixture/project",
      agent: "CobaltJaguar",
      nowNs: deterministicClock(),
    });
    const frame = '{"id":1,"method":"initialize","params":{}}';
    assertEquals(harness.captureJsonRpc("out", frame), {
      id: 1,
      method: "initialize",
      params: {},
    });
    harness.transcript("initialized");
    const process = await harness.runProcess([
      Deno.execPath(),
      "eval",
      "console.log('stdout-frame'); console.error('stderr-frame')",
    ]);

    assert(process.success, "fixture process should succeed");
    assertEquals(process.stdout, "stdout-frame\n");
    assertEquals(process.stderr, "stderr-frame\n");
    assertEquals(process.endedAtNs - process.startedAtNs, 300n);
    assertEquals(
      harness.records.map((record) => record.channel),
      ["json-rpc", "transcript", "process", "stdout", "stderr", "process"],
    );
    assert(harness.evidenceJson().includes('"atNs": "100"'), "evidence must serialize bigint time");
    assertEquals(harness.records[0].value, frame);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("malformed filename scenario is observable as a skipped mailbox file", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-ingress-malformed-name-" });
  try {
    const harness = new CodexIngressHarness({
      root,
      project: "/fixture/project",
      agent: "CobaltJaguar",
      nowNs: deterministicClock(),
    });
    await harness.writeMail({
      ...standardMailScenarios()[0],
      id: 99,
      malformed: "filename",
    });
    const snapshot = await snapshotMailbox(root, ["fixture-project"], "CobaltJaguar");
    assertEquals(snapshot.entries, []);
    assertEquals(snapshot.skipped.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
