// Integration test for doctor's product registration-gap check + the
// capabilities/schema introspection envelopes (tcp-6yk.3).
//
// Drives runDoctor / runCapabilities / runSchema against a REAL child `am` — a
// fake shell script on a temp PATH. The fake links two projects into the product
// (alpha, beta) but registers the watched identity only in alpha, so doctor must
// FAIL naming beta. Asserts:
//   1. doctor (json) fails with error.name=product_registration_gap and
//      data.product.missing=["beta"], returning ExitCode.FIRST_POLL_FAILED;
//   2. doctor (human) prints a FAIL line naming beta;
//   3. capabilities --json and schema doctor --json are valid envelopes
//      (schemaVersion/ok/meta.command), matching the schema `schema` itself emits.
//
// Run: deno test --allow-all src/commands/doctor_test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { runDoctor } from "./doctor.ts";
import { runCapabilities, runSchema } from "./introspect.ts";
import { ExitCode } from "../core/exit.ts";

// Fake `am`: --version (presence), products status (two linked projects), and
// agents list per project (identity present in alpha, absent in beta). Dispatch
// on positional args only — no bash ${...} (it reads as JS interpolation here).
const FAKE_AM = `#!/usr/bin/env bash
set -eo pipefail
if [ "$1" = "--version" ]; then echo "am 0.0-fake"; exit 0; fi
if [ "$1" = "products" ] && [ "$2" = "status" ]; then
  echo '{"projects":[{"id":1,"slug":"alpha"},{"id":2,"slug":"beta"}]}'
  exit 0
fi
if [ "$1" = "agents" ] && [ "$2" = "list" ]; then
  if [ "$4" = "alpha" ]; then
    echo '[{"name":"TestBot"},{"name":"Root"}]'
  elif [ "$4" = "beta" ]; then
    echo '[{"name":"Root"}]'
  else
    echo '[]'
  fi
  exit 0
fi
echo "fake-am unhandled: $*" >&2
exit 2
`;

async function withFakeAm(fn: () => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "am-doctor-test-" });
  const binDir = `${dir}/bin`;
  await Deno.mkdir(binDir);
  const amPath = `${binDir}/am`;
  await Deno.writeTextFile(amPath, FAKE_AM);
  await Deno.chmod(amPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${binDir}:${prevPath}`);
  try {
    await fn();
  } finally {
    Deno.env.set("PATH", prevPath);
    await Deno.remove(dir, { recursive: true });
  }
}

async function capture(
  fn: () => Promise<unknown> | unknown,
): Promise<{ lines: string[]; ret: unknown }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let ret: unknown;
  try {
    ret = await fn();
  } finally {
    console.log = orig;
  }
  return { lines, ret };
}

/** Structural envelope validation, cross-checked against `schema`'s own output. */
function assertValidEnvelope(obj: Record<string, unknown>, command: string): void {
  assertEquals(obj.schemaVersion, 1, "schemaVersion must be 1");
  assertEquals(typeof obj.ok, "boolean", "ok must be boolean");
  assert(obj.meta && typeof obj.meta === "object", "meta object required");
  assertEquals((obj.meta as Record<string, unknown>).command, command, "meta.command mismatch");
  if (obj.ok) assert("data" in obj, "ok envelope must carry data");
  else assert("error" in obj, "err envelope must carry error");
}

Deno.test("doctor product gap: FAILs naming the project missing the identity", async () => {
  await withFakeAm(async () => {
    Deno.env.set("AGENT_MAIL_PRODUCT", "prod-x");
    Deno.env.set("AGENT_NAME", "TestBot");
    try {
      // (1) JSON path — fail loud, name beta, correct exit code.
      const { lines, ret } = await capture(() => runDoctor({ json: true }));
      assertEquals(ret, ExitCode.FIRST_POLL_FAILED, "gap must map to FIRST_POLL_FAILED");
      const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
      assertValidEnvelope(env, "doctor");
      assertEquals(env.ok, false);
      assertEquals((env.error as Record<string, unknown>).name, "product_registration_gap");
      const product = (env.data as Record<string, unknown>).product as Record<string, unknown>;
      assertEquals(product.missing, ["beta"], "beta is the missing project");

      // (2) Human path — a FAIL line names beta.
      const human = await capture(() => runDoctor({ json: false }));
      const fail = human.lines.find((l) => l.includes("[FAIL]") && l.includes("product"));
      assert(fail, "expected a FAIL product line");
      assertStringIncludes(fail!, "beta");
      assert(!fail!.includes("alpha"), "alpha is registered and must not be named");
    } finally {
      Deno.env.delete("AGENT_MAIL_PRODUCT");
      Deno.env.delete("AGENT_NAME");
    }
  });
});

Deno.test("introspection: capabilities and schema emit valid envelopes", async () => {
  await withFakeAm(async () => {
    const caps = await capture(() => runCapabilities());
    assertEquals(caps.ret, ExitCode.OK);
    assertValidEnvelope(
      JSON.parse(caps.lines.join("\n")) as Record<string, unknown>,
      "capabilities",
    );

    const sch = await capture(() => Promise.resolve(runSchema("doctor")));
    assertEquals(sch.ret, ExitCode.OK);
    const schEnv = JSON.parse(sch.lines.join("\n")) as Record<string, unknown>;
    assertValidEnvelope(schEnv, "schema");
    // The emitted schema describes an envelope: it must require the wrapper keys.
    const schema = ((schEnv.data as Record<string, unknown>).schema) as Record<string, unknown>;
    assertEquals(schema.required, ["schemaVersion", "ok", "meta"]);

    // schema for a notification command has no envelope → USAGE.
    const bad = await capture(() => Promise.resolve(runSchema("watch")));
    assertEquals(bad.ret, ExitCode.USAGE);
  });
});
