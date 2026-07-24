// Integration test for the product (multi-project) watch loop (tcp-6yk.2).
//
// Drives runProductWatch against a REAL child `am` — a fake shell script on a
// temp PATH whose `products inbox` output GROWS across polls, and whose
// `list-projects` provides the id->slug label map. Asserts the four behaviours
// the bead calls out:
//   1. baseline poll does NOT replay pre-existing mail;
//   2. only messages newer than the baseline are emitted, once each;
//   3. each emitted line is labelled with its origin project slug;
//   4. a malformed payload is rejected LOUDLY (parse fails -> no emit, no crash).
//
// Run: deno test --allow-all src/commands/product_test.ts
// (broad perms are fine for a test: it writes a temp fake `am` and runs it.)

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { runProductWatch } from "./product.ts";

// A fake `am` whose `products inbox` reads a call counter from a state file and
// returns a different page each invocation, so the watermark logic is exercised
// across polls. `list-projects` returns a fixed two-project map. NB: this is a JS
// template literal, so bash `${...}` brace-expansion is avoided deliberately (it
// would be read as JS interpolation) — positional `$1`/`$2`/`$n` only.
const FAKE_AM = `#!/usr/bin/env bash
set -eo pipefail
STATE="$AM_FAKE_STATE"
if [ "$1" = "list-projects" ]; then
  echo '[{"id":1,"slug":"alpha","human_key":"/x/alpha"},{"id":2,"slug":"beta","human_key":"/x/beta"}]'
  exit 0
fi
if [ "$1" = "products" ] && [ "$2" = "inbox" ]; then
  n=$(cat "$STATE" 2>/dev/null || echo 0)
  echo $((n+1)) > "$STATE"
  if [ "$n" = "0" ]; then
    # baseline: one pre-existing message — MUST NOT be emitted
    echo '{"messages":[{"id":10,"from":"Root","importance":"normal","subject":"old","created_ts":"2026-07-24T10:00:00Z","project_id":1}]}'
  elif [ "$n" = "1" ]; then
    # one genuinely new message in project beta -> emit, labelled [beta] (newest first)
    echo '{"messages":[{"id":11,"from":"Neo","importance":"high","subject":"fresh","created_ts":"2026-07-24T11:00:00Z","project_id":2},{"id":10,"from":"Root","importance":"normal","subject":"old","created_ts":"2026-07-24T10:00:00Z","project_id":1}]}'
  elif [ "$n" = "2" ]; then
    # malformed: created_ts missing -> Zod rejects; loop must not crash/emit
    echo '{"messages":[{"id":12,"from":"Bad","subject":"broken","project_id":1}]}'
  else
    # nothing new thereafter
    echo '{"messages":[]}'
  fi
  exit 0
fi
echo "fake-am: unhandled: $*" >&2
exit 2
`;

async function withFakeAm(
  fn: (env: { binDir: string; state: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "am-prod-test-" });
  const binDir = `${dir}/bin`;
  await Deno.mkdir(binDir);
  const amPath = `${binDir}/am`;
  await Deno.writeTextFile(amPath, FAKE_AM);
  await Deno.chmod(amPath, 0o755);
  const state = `${dir}/state`;
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${binDir}:${prevPath}`);
  Deno.env.set("AM_FAKE_STATE", state);
  try {
    await fn({ binDir, state });
  } finally {
    Deno.env.set("PATH", prevPath);
    Deno.env.delete("AM_FAKE_STATE");
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("product watch: silent baseline, emits only-new labelled lines, survives malformed payload", async () => {
  await withFakeAm(async () => {
    const ac = new AbortController();
    // Stop after the fake has served baseline + new + malformed + one empty poll.
    // interval is sub-second so the four polls complete quickly.
    const lines = await captureLog(async () => {
      const done = runProductWatch({
        productKey: "prod-x",
        agent: "Tester",
        interval: 1,
        signal: ac.signal,
      });
      // Let ~4 polls happen (interval 1s ⇒ ~0ms first poll, then 1s each). Abort
      // during the 5th sleep. 3.5s covers baseline+new+malformed+empty.
      await new Promise((r) => setTimeout(r, 3500));
      ac.abort();
      await done;
    });

    const mailLines = lines.filter((l) => l.startsWith("MAIL "));
    // (1)+(2): exactly ONE MAIL line — the id=11 "fresh" message. The baseline
    // id=10 "old" is never emitted (no replay); id=12 is malformed (dropped).
    assertEquals(mailLines.length, 1, `expected 1 MAIL line, got: ${JSON.stringify(mailLines)}`);
    // (2): it is the NEW message, not the old baseline one.
    assertStringIncludes(mailLines[0], "#11");
    assertStringIncludes(mailLines[0], "fresh");
    assert(!mailLines.some((l) => l.includes("old")), "baseline message must not be replayed");
    // (3): labelled with the origin project slug (project_id 2 -> beta).
    assertStringIncludes(mailLines[0], "[beta]");
    // (4): malformed payload did not crash the loop (we got here) and did not emit.
    assert(!mailLines.some((l) => l.includes("#12")), "malformed message must not be emitted");
  });
});
