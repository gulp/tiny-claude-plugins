/**
 * S2b (tcp-efp.1.4) acceptance: exclusive headless↔human ownership handoff.
 * Private-memory + fake-transport proofs; no remote TUI.
 */
import {
  HandoffError,
  memoryTransport,
  SpikeHandoffController,
  type PendingBatch,
} from "./codex-s2b-handoff.ts";
import { CodexIngressHarness } from "./codex-ingress-harness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const encode = (value: unknown) => JSON.stringify(value);
  if (encode(actual) !== encode(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assertThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected HandoffError ${code}`);
  } catch (error) {
    assert(error instanceof HandoffError, `expected HandoffError, got ${error}`);
    assertEquals(error.code, code);
  }
}

async function assertRejectsCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected HandoffError ${code}`);
  } catch (error) {
    assert(error instanceof HandoffError, `expected HandoffError, got ${error}`);
    assertEquals(error.code, code);
  }
}

Deno.test("s2b: zero overlap — human attach refused while headless active", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  await ctl.acquireHeadless();
  assertThrowsCode(() => ctl.noteHumanAttached(), "overlap");
  assertEquals(ctl.owner, "headless");
  const outcome = await ctl.deliverIfOwned({ id: "b1", eventIds: [1] });
  assertEquals(outcome, "accepted");
  await ctl.close();
});

Deno.test("s2b: competing client blocks acquire and delivery", async () => {
  let competing = false;
  const transport = memoryTransport({ competing: () => competing });
  const ctl = new SpikeHandoffController({ transport });
  competing = true;
  await assertRejectsCode(ctl.acquireHeadless(), "overlap");
  competing = false;
  await ctl.acquireHeadless();
  competing = true;
  const outcome = await ctl.deliverIfOwned({ id: "b2", eventIds: [2] });
  assertEquals(outcome, "refused");
  assertEquals(transport.delivered.length, 0);
  await ctl.close();
});

Deno.test("s2b: release refuses unresolved active turn", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  await ctl.acquireHeadless();
  ctl.markTurnActive("turn-open");
  await assertRejectsCode(ctl.releaseToHuman(), "active_turn");
  assertEquals(ctl.owner, "headless");
  ctl.markTurnCompleted("turn-open");
  const released = await ctl.releaseToHuman();
  assertEquals(released.owner, "none");
  assert(released.resumeHint.includes(released.threadId), "resume hint must name thread");
});

Deno.test("s2b: release refuses open server request until drained", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  await ctl.acquireHeadless();
  ctl.markServerRequestOpen("elicitation-1");
  await assertRejectsCode(ctl.releaseToHuman(), "open_server_request");
  ctl.markServerRequestClosed("elicitation-1");
  const released = await ctl.releaseToHuman();
  assertEquals(released.owner, "none");
});

Deno.test("s2b: queue survives human window; no Codex delivery while not headless", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  const proof = await ctl.acquireHeadless();
  await ctl.releaseToHuman();
  ctl.noteHumanAttached();

  const queued: PendingBatch = { id: "pending-while-human", eventIds: [41, 42] };
  const outcome = await ctl.deliverIfOwned(queued);
  assertEquals(outcome, "queued");
  assertEquals(transport.delivered.length, 0);
  assertEquals(ctl.pendingBatches.map((b) => b.id), ["pending-while-human"]);

  ctl.noteHumanDetached();
  // Still none — must not deliver until explicit reacquire.
  const stillQueued = await ctl.deliverIfOwned({ id: "more", eventIds: [43] });
  assertEquals(stillQueued, "queued");
  assertEquals(transport.delivered.length, 0);

  const reacquired = await ctl.reacquireHeadless();
  assertEquals(reacquired.threadId, proof.threadId);
  assertEquals(transport.resumed, [proof.threadId]);
  const drained = await ctl.drainPending();
  assertEquals(drained, ["pending-while-human", "more"]);
  assertEquals(transport.delivered.map((b) => b.id), ["pending-while-human", "more"]);
  await ctl.close();
});

Deno.test("s2b: exact-thread reacquire delivers each pending batch once", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  const proof = await ctl.acquireHeadless();
  ctl.enqueue({ id: "q1", eventIds: [10] });
  ctl.enqueue({ id: "q2", eventIds: [11, 12] });
  await ctl.releaseToHuman();
  ctl.noteHumanAttached();
  ctl.noteHumanDetached();

  const again = await ctl.reacquireHeadless();
  assertEquals(again.threadId, proof.threadId);
  const drained = await ctl.drainPending();
  assertEquals(drained, ["q1", "q2"]);
  // Stable IDs: re-delivering the same batch id is a no-op accept.
  assertEquals(await ctl.deliverIfOwned({ id: "q1", eventIds: [10] }), "accepted");
  assertEquals(transport.delivered.length, 2);
  await ctl.close();
});

Deno.test("s2b: no implicit handoff on disconnect", async () => {
  const transport = memoryTransport();
  const ctl = new SpikeHandoffController({ transport });
  await ctl.acquireHeadless();
  ctl.enqueue({ id: "survives-crash", eventIds: [99] });
  ctl.forceDisconnectWithoutHandoff();
  assertEquals(ctl.owner, "none");
  assertEquals(await ctl.deliverIfOwned({ id: "post-crash", eventIds: [100] }), "queued");
  assertEquals(transport.delivered.length, 0);
  // Must not become human without noteHumanAttached.
  assert(
    !ctl.transitions.some((t) => t.includes("noteHumanAttached")),
    "disconnect must not implicitly attach human owner",
  );
});

Deno.test("s2b: resume failure refuses replacement thread/start", async () => {
  const transport = memoryTransport({ resumeFails: true });
  const ctl = new SpikeHandoffController({ transport, threadId: "thread-durable" });
  await assertRejectsCode(ctl.reacquireHeadless(), "resume_failed");
  assertEquals(transport.started.length, 0, "must not thread/start a replacement");
  assertEquals(ctl.owner, "none");
});

Deno.test("s2b: fixture mail ids remain pending across handoff (harness integration)", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-s2b-fixture-" });
  try {
    const project = `${root}/project`;
    const mailbox = `${root}/mailbox`;
    const harness = new CodexIngressHarness({
      root: mailbox,
      project,
      agent: "CobaltJaguar",
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const written = await harness.writeMail({
      id: 27982,
      created: "2026-07-28T21:04:29.583807Z",
      from: "GoldenLake",
      to: ["CobaltJaguar"],
      subject: "Monitor wake nudge",
      body: "queued during human ownership",
      importance: "high",
      ackRequired: true,
    });

    const transport = memoryTransport();
    const ctl = new SpikeHandoffController({ transport });
    const proof = await ctl.acquireHeadless();
    await ctl.releaseToHuman();
    ctl.noteHumanAttached();
    ctl.enqueue({ id: `mail-${written.id}`, eventIds: [written.id] });
    assertEquals(ctl.pendingBatches[0].eventIds, [27982]);
    assert((await Deno.stat(written.path)).isFile, "canonical mail must remain");
    ctl.noteHumanDetached();
    await ctl.reacquireHeadless();
    assertEquals((await ctl.drainPending())[0], `mail-${written.id}`);
    assertEquals(transport.delivered[0].eventIds, [27982]);
    assertEquals(transport.resumed[0], proof.threadId);
    harness.transcript(
      `s2b handoff preserved mail #27982 across human window; reacquired ${proof.threadId}`,
    );
    assert(
      harness.evidenceJson().includes("preserved mail #27982"),
      "evidence must record handoff preservation",
    );
    await ctl.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
