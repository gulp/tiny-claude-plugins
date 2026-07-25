// tcp-p0x.1: cross-project `message <id>` lookup. These tests inject fake project
// lists + probes (no real `am`), so they assert the resolver/orchestrator logic
// directly: short-circuit on first hit, honest miss vs. unreachable, envelope
// shape, and the fan-out cap.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { type LinkedProject, type MessageProbe } from "../core/am.ts";
import { type MessageDeps, resolveMessage, runMessage } from "./message.ts";
import { ExitCode } from "../core/exit.ts";

function proj(key: string, label = key): LinkedProject {
  return { key, label };
}

/** A probe that hits on exactly one project key, absent everywhere else. */
function hitOn(target: string, message: unknown = { id: 1, subject: "hi" }) {
  return (_id: string, key: string): Promise<MessageProbe> =>
    Promise.resolve(key === target ? { kind: "hit", message } : { kind: "absent" });
}

// --- capture stdout/stderr for envelope + diagnostic assertions -----------------
function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = log;
      console.error = error;
    },
  };
}

function depsWith(over: Partial<MessageDeps>): Partial<MessageDeps> {
  return over;
}

Deno.test("resolveMessage short-circuits on the first hit (2nd of 3)", async () => {
  const calls: string[] = [];
  const probe = (id: string, key: string): Promise<MessageProbe> => {
    calls.push(key);
    return hitOn("b")(id, key);
  };
  const result = await resolveMessage("42", [proj("a"), proj("b"), proj("c")], probe);
  assert(result.hit, "expected a hit");
  assertEquals(result.hit?.projectKey, "b");
  assertEquals(result.probed, 2);
  // c must never be probed — short-circuit.
  assertEquals(calls, ["a", "b"]);
});

Deno.test("resolveMessage records errors but keeps searching past them", async () => {
  const probe = (_id: string, key: string): Promise<MessageProbe> => {
    if (key === "a") return Promise.resolve({ kind: "error", error: "boom" });
    if (key === "b") return Promise.resolve({ kind: "hit", message: { id: 9 } });
    return Promise.resolve({ kind: "absent" });
  };
  const result = await resolveMessage("9", [proj("a"), proj("b")], probe);
  assertEquals(result.hit?.projectKey, "b");
  assertEquals(result.errored.length, 1);
  assertStringIncludes(result.errored[0], "boom");
});

Deno.test("runMessage: hit emits an ok envelope with {project, message} under --json", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "42",
      json: true,
      deps: depsWith({
        listAllProjects: () =>
          Promise.resolve({ ok: true, projects: [proj("a"), proj("home", "home")] }),
        probe: hitOn("home", { id: 42, subject: "found me" }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.OK);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.ok, true);
  assertEquals(env.schemaVersion, 1);
  assertEquals(env.meta.command, "message");
  assertEquals(env.data.project, "home");
  assertEquals(env.data.message.subject, "found me");
});

Deno.test("runMessage: clean miss across all projects yields NOT_FOUND + one diagnostic", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "999",
      json: true,
      deps: depsWith({
        listAllProjects: () =>
          Promise.resolve({ ok: true, projects: [proj("a"), proj("b"), proj("c")] }),
        probe: () => Promise.resolve({ kind: "absent" }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.NOT_FOUND);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.ok, false);
  assertEquals(env.error.name, "NOT_FOUND");
  assertEquals(env.error.code, ExitCode.NOT_FOUND);
  // ONE collapsed diagnostic naming the count, not three stacked errors.
  assertStringIncludes(env.error.message, "3 project");
  assertEquals(env.data.probed, 3);
});

Deno.test("runMessage: every probe errored -> SERVER_UNREACHABLE, not a false NOT_FOUND", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "5",
      json: true,
      deps: depsWith({
        listAllProjects: () => Promise.resolve({ ok: true, projects: [proj("a"), proj("b")] }),
        probe: (_id, key) => Promise.resolve({ kind: "error", error: `down:${key}` }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.SERVER_UNREACHABLE);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.error.name, "SERVER_UNREACHABLE");
  // honest: it must NOT claim "not found" when it could not actually look.
  assertStringIncludes(env.error.message, "not a clean 'not found'");
});

Deno.test("runMessage: could not list projects -> SERVER_UNREACHABLE", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "5",
      json: true,
      deps: depsWith({
        listAllProjects: () => Promise.resolve({ ok: false, projects: [], error: "no am" }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.SERVER_UNREACHABLE);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.error.name, "SERVER_UNREACHABLE");
  assertStringIncludes(env.error.message, "could not list projects");
});

Deno.test("runMessage: non-integer id -> USAGE, no probing", async () => {
  const cap = capture();
  let probed = false;
  let code: number;
  try {
    code = await runMessage({
      id: "abc",
      json: true,
      deps: depsWith({
        listAllProjects: () => {
          probed = true;
          return Promise.resolve({ ok: true, projects: [] });
        },
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.USAGE);
  assert(!probed, "must reject a bad id before listing projects");
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.error.name, "USAGE");
});

Deno.test("runMessage: --product routes to the product project list", async () => {
  const cap = capture();
  let usedProduct: string | undefined;
  let code: number;
  try {
    code = await runMessage({
      id: "7",
      product: "acme",
      json: true,
      deps: depsWith({
        listProductProjects: (key: string) => {
          usedProduct = key;
          return Promise.resolve({ ok: true, projects: [proj("p1")] });
        },
        // listAllProjects must NOT be called in product mode.
        listAllProjects: () => Promise.reject(new Error("should not be called")),
        probe: hitOn("p1", { id: 7 }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.OK);
  assertEquals(usedProduct, "acme");
});

Deno.test("runMessage: fan-out is capped and the skip is reported, not silent", async () => {
  const cap = capture();
  // 600 projects, none holding the id -> a clean miss, but the cap must bite
  // and the miss diagnostic must disclose the skipped remainder.
  const many: LinkedProject[] = Array.from({ length: 600 }, (_v, i) => proj(`p${i}`));
  let probeCount = 0;
  let code: number;
  try {
    code = await runMessage({
      id: "1",
      json: true,
      deps: depsWith({
        listAllProjects: () => Promise.resolve({ ok: true, projects: many }),
        probe: () => {
          probeCount++;
          return Promise.resolve({ kind: "absent" });
        },
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.NOT_FOUND);
  // capped at MAX_FANOUT (500) — never probed all 600.
  assertEquals(probeCount, 500);
  // the cap notice went to stderr...
  assert(cap.err.some((l) => l.includes("bounding fan-out")), "expected a fan-out cap notice");
  // ...and the miss envelope discloses the skipped remainder (100 = 600 - 500).
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.data.skipped, 100);
  assertStringIncludes(env.error.message, "beyond the fan-out cap");
});

Deno.test("runMessage: a --product miss discloses the scope, so the 'no' isn't silently narrowed", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "999",
      product: "acme",
      json: true,
      deps: depsWith({
        listProductProjects: () =>
          Promise.resolve({ ok: true, projects: [proj("p1"), proj("p2")] }),
        probe: () => Promise.resolve({ kind: "absent" }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.NOT_FOUND);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.error.name, "NOT_FOUND");
  // the miss must name the product scope — a message may still exist in an unlinked project.
  assertStringIncludes(env.error.message, "product 'acme'");
});

Deno.test("runMessage: a miss with zero projects says so, not 'not found in any of 0 project(s)'", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "999",
      json: true,
      deps: depsWith({
        listAllProjects: () => Promise.resolve({ ok: true, projects: [] }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.NOT_FOUND);
  const env = JSON.parse(cap.out.join("\n"));
  assertEquals(env.error.name, "NOT_FOUND");
  assertEquals(env.data.probed, 0);
  // honest wording for the empty-frontier case.
  assertStringIncludes(env.error.message, "no projects");
});

Deno.test("runMessage: human output on a hit prints a readable block, no envelope", async () => {
  const cap = capture();
  let code: number;
  try {
    code = await runMessage({
      id: "42",
      json: false,
      deps: depsWith({
        listAllProjects: () => Promise.resolve({ ok: true, projects: [proj("home", "home")] }),
        probe: hitOn("home", {
          id: 42,
          from: "Alice",
          subject: "hello",
          body: "line one\nline two",
        }),
      }),
    });
  } finally {
    cap.restore();
  }
  assertEquals(code, ExitCode.OK);
  const text = cap.out.join("\n");
  assertStringIncludes(text, "message #42");
  assertStringIncludes(text, "home");
  assertStringIncludes(text, "hello");
  assertStringIncludes(text, "line two");
  // human mode must NOT emit a JSON envelope.
  assert(!text.includes('"schemaVersion"'), "human mode should not print an envelope");
});
