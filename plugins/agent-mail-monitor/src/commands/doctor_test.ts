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
  elif [ "$4" = "identity-pick-project" ]; then
    echo '[{"name":"PinkGlen","model":"claude-opus-4-8","last_active_ts":"2026-07-25T08:06:44Z"},{"name":"CrimsonBear","model":"claude-sonnet-5","last_active_ts":"2026-07-25T04:06:56Z"}]'
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

// Every test in this file that runs `runDoctor` must NOT depend on whatever
// mailbox root happens to exist on the machine running the suite (tcp-p0x.16.5's
// `mailbox` check reads `$AGENT_MAIL_MAILBOX_ROOT`/the real default — a fresh CI
// box has neither). Wrap in a well-formed temp root so the mailbox check always
// PASSes and the test is isolated to the thing it actually means to assert.
async function withWellFormedMailboxRoot(fn: () => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "am-doctor-mailbox-root-" });
  await Deno.mkdir(`${root}/projects`);
  const prev = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT");
  Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", root);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AGENT_MAIL_MAILBOX_ROOT");
    else Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", prev);
    await Deno.remove(root, { recursive: true });
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
    await withWellFormedMailboxRoot(async () => {
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
});

// --- tcp-p0x.16.5: mailbox-layout health check ------------------------------

Deno.test("doctor mailbox check: a well-formed root PASSes", async () => {
  await withFakeAm(async () => {
    await withWellFormedMailboxRoot(async () => {
      const { ret } = await capture(() => runDoctor({ json: true }));
      // No product/desync gating configured, am present, root well-formed:
      // doctor must be clean OK end-to-end (the load-bearing back-compat AC —
      // adding the mailbox check must not fail an otherwise-healthy run).
      assertEquals(ret, ExitCode.OK);
    });
  });
});

Deno.test("doctor mailbox check: a missing root FAILs loud, named mailbox_layout_broken", async () => {
  await withFakeAm(async () => {
    // A path that was never created — not merely an empty temp dir.
    const missingRoot = `${await Deno.makeTempDir({
      prefix: "am-doctor-missing-",
    })}/does-not-exist`;
    const prev = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT");
    Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", missingRoot);
    try {
      const { lines, ret } = await capture(() => runDoctor({ json: true }));
      assertEquals(ret, ExitCode.SERVER_UNREACHABLE, "a broken layout must fail loud, non-zero");
      const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
      assertValidEnvelope(env, "doctor");
      assertEquals(env.ok, false);
      assertEquals((env.error as Record<string, unknown>).name, "mailbox_layout_broken");
      const checks = (env.data as Record<string, unknown>).checks as Record<string, unknown>;
      assertEquals((checks.mailbox as Record<string, unknown>).ok, false);

      const human = await capture(() => runDoctor({ json: false }));
      const fail = human.lines.find((l) => l.includes("[FAIL]") && l.includes("mailbox"));
      assert(fail, "expected a FAIL mailbox line");
    } finally {
      if (prev === undefined) Deno.env.delete("AGENT_MAIL_MAILBOX_ROOT");
      else Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", prev);
    }
  });
});

Deno.test("doctor mailbox check: root exists but has no projects/ subdir FAILs loud", async () => {
  await withFakeAm(async () => {
    const root = await Deno.makeTempDir({ prefix: "am-doctor-no-projects-" });
    const prev = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT");
    Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", root);
    try {
      const { ret, lines } = await capture(() => runDoctor({ json: true }));
      assertEquals(ret, ExitCode.SERVER_UNREACHABLE);
      const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
      assertEquals((env.error as Record<string, unknown>).name, "mailbox_layout_broken");
    } finally {
      if (prev === undefined) Deno.env.delete("AGENT_MAIL_MAILBOX_ROOT");
      else Deno.env.set("AGENT_MAIL_MAILBOX_ROOT", prev);
      await Deno.remove(root, { recursive: true });
    }
  });
});

// --- tcp-p0x.16.5: on-demand desync cross-check (gating only — the SQLite
// read itself, incl. the "never touches read_ts" AC, is unit-tested against
// `checkDesync` directly in shadow_test.ts) --------------------------------

Deno.test("doctor desync check: off by default (no AGENT_MAIL_DESYNC_CHECK, no 'desync' key)", async () => {
  await withFakeAm(async () => {
    await withWellFormedMailboxRoot(async () => {
      Deno.env.set("AGENT_NAME", "TestBot");
      try {
        const { lines, ret } = await capture(() => runDoctor({ json: true }));
        assertEquals(ret, ExitCode.OK);
        const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
        const checks = (env.data as Record<string, unknown>).checks as Record<string, unknown>;
        assert(!("desync" in checks), "desync must be opt-in — never runs unless explicitly asked");
      } finally {
        Deno.env.delete("AGENT_NAME");
      }
    });
  });
});

// --- tcp-p0x.4: identity-pick hint (AGENT_NAME unset -> list who's already
// registered in THIS project, so the user reuses one instead of minting a
// new empty mailbox) -----------------------------------------------------

Deno.test("doctor identity-pick: AGENT_NAME unset lists existing identities in this project", async () => {
  await withFakeAm(async () => {
    await withWellFormedMailboxRoot(async () => {
      const prevProj = Deno.env.get("CLAUDE_PROJECT_DIR");
      Deno.env.set("CLAUDE_PROJECT_DIR", "identity-pick-project");
      try {
        const { lines, ret } = await capture(() => runDoctor({ json: true }));
        assertEquals(ret, ExitCode.OK, "an unset identity stays a warning, never fails doctor");
        const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
        const checks = (env.data as Record<string, unknown>).checks as Record<string, unknown>;
        const identity = checks.identity as Record<string, unknown>;
        assertEquals(identity.ok, false);
        assertStringIncludes(identity.detail as string, "PinkGlen");
        assertStringIncludes(identity.detail as string, "CrimsonBear");
        assertStringIncludes(identity.detail as string, "reuse one of these");

        const candidates = (env.data as Record<string, unknown>).identityCandidates as Array<
          Record<string, unknown>
        >;
        assertEquals(candidates.length, 2);
        assertEquals(candidates[0].name, "PinkGlen");
        assertEquals(candidates[0].model, "claude-opus-4-8");

        const human = await capture(() => runDoctor({ json: false }));
        const identityLine = human.lines.find((l) => l.includes("identity"));
        assert(identityLine, "expected an identity line in human output");
        assertStringIncludes(identityLine!, "PinkGlen");
      } finally {
        if (prevProj === undefined) Deno.env.delete("CLAUDE_PROJECT_DIR");
        else Deno.env.set("CLAUDE_PROJECT_DIR", prevProj);
      }
    });
  });
});

Deno.test("doctor identity-pick: AGENT_NAME unset + no identities yet says so, not a crash", async () => {
  await withFakeAm(async () => {
    await withWellFormedMailboxRoot(async () => {
      const prevProj = Deno.env.get("CLAUDE_PROJECT_DIR");
      Deno.env.set("CLAUDE_PROJECT_DIR", "nobody-registered-here");
      try {
        const { lines, ret } = await capture(() => runDoctor({ json: true }));
        assertEquals(ret, ExitCode.OK);
        const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
        const checks = (env.data as Record<string, unknown>).checks as Record<string, unknown>;
        assertStringIncludes(
          (checks.identity as Record<string, unknown>).detail as string,
          "no identities registered yet",
        );
        const candidates = (env.data as Record<string, unknown>).identityCandidates as unknown[];
        assertEquals(candidates.length, 0);
      } finally {
        if (prevProj === undefined) Deno.env.delete("CLAUDE_PROJECT_DIR");
        else Deno.env.set("CLAUDE_PROJECT_DIR", prevProj);
      }
    });
  });
});

Deno.test("doctor identity-pick: AGENT_NAME set skips the hint entirely", async () => {
  await withFakeAm(async () => {
    await withWellFormedMailboxRoot(async () => {
      Deno.env.set("AGENT_NAME", "TestBot");
      Deno.env.set("CLAUDE_PROJECT_DIR", "identity-pick-project");
      try {
        const { lines, ret } = await capture(() => runDoctor({ json: true }));
        assertEquals(ret, ExitCode.OK);
        const env = JSON.parse(lines.join("\n")) as Record<string, unknown>;
        assert(
          !("identityCandidates" in (env.data as Record<string, unknown>)),
          "no hint once an identity is set",
        );
        const checks = (env.data as Record<string, unknown>).checks as Record<string, unknown>;
        assertEquals((checks.identity as Record<string, unknown>).ok, true);
      } finally {
        Deno.env.delete("AGENT_NAME");
        Deno.env.delete("CLAUDE_PROJECT_DIR");
      }
    });
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
