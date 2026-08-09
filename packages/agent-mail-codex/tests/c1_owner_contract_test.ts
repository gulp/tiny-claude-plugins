/**
 * C1: ThreadOwnerAdapter contract suite against FakeThreadOwnerAdapter.
 */
import { runThreadOwnerContract } from "../src/owner/contract.ts";
import { FakeThreadOwnerAdapter } from "../src/owner/fake.ts";
import { OwnershipError } from "../src/owner/types.ts";
import { DOMAIN_SCHEMA_VERSION } from "../src/schemas/mod.ts";

Deno.test("C1: FakeThreadOwnerAdapter satisfies full ownership contract", async () => {
  await runThreadOwnerContract(
    () =>
      new FakeThreadOwnerAdapter({
        now: () => "2026-07-28T22:00:00.000Z",
        autoCompleteTurns: false,
      }),
  );
});

Deno.test("C1: contract refuses delivery without acquire", async () => {
  const owner = new FakeThreadOwnerAdapter({ autoCompleteTurns: false });
  await owner.connect({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: "b",
    agent: "AmberOtter",
    projectSlug: "p",
    threadId: "t1",
    ownershipModel: "exclusive-handoff",
  });
  try {
    await owner.startTurn({ schemaVersion: 1, text: "x", byteLength: 1 }, "k");
    throw new Error("expected fail");
  } catch (error) {
    if (!(error instanceof OwnershipError) || error.code !== "not_acquired") {
      throw error;
    }
  }
  await owner.close();
});

Deno.test("C1: release refuses open server request and active turn", async () => {
  const owner = new FakeThreadOwnerAdapter({
    now: () => "2026-07-28T22:00:00.000Z",
    autoCompleteTurns: false,
  });
  await owner.connect({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: "b",
    agent: "AmberOtter",
    projectSlug: "p",
    threadId: "t1",
    ownershipModel: "exclusive-handoff",
  });
  await owner.acquireOwnership();
  await owner.startTurn({ schemaVersion: 1, text: "x", byteLength: 1 }, "batch:b:1-1#1");
  try {
    await owner.releaseOwnership();
    throw new Error("expected refuse active turn");
  } catch (error) {
    if (!(error instanceof OwnershipError)) throw error;
  }
  owner.completeActiveTurn();
  owner.injectServerRequest({
    id: "elicit-1",
    type: "elicitation",
    method: "mcpServer/elicitation/request",
  });
  try {
    await owner.releaseOwnership();
    throw new Error("expected refuse open request");
  } catch (error) {
    if (!(error instanceof OwnershipError)) throw error;
  }
  await owner.respondToServerRequest("elicit-1", { kind: "cancel" });
  await owner.releaseOwnership();
  const snap = await owner.snapshot();
  if (snap.owner !== "none") throw new Error(`expected none, got ${snap.owner}`);
  await owner.close();
});
