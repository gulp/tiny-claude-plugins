// tcp-ssu: project/bus resolution provenance. The Agent Mail project_key IS the
// absolute project path, so the ONLY unsafe source is the cwd fall-through — these
// tests pin the provenance table and assert the warning fires on exactly that source.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
  noteResolvedBus,
  noteResolvedProductBus,
  type ResolvedProject,
  resolveProjectFrom,
} from "./cli.ts";

Deno.test("resolveProjectFrom: --project wins over everything", () => {
  const r = resolveProjectFrom("/p", "/c", "/env", "/cwd");
  assertEquals(r, { path: "/p", source: "--project" } satisfies ResolvedProject);
});

Deno.test("resolveProjectFrom: --cwd wins over env + cwd", () => {
  const r = resolveProjectFrom(undefined, "/c", "/env", "/cwd");
  assertEquals(r, { path: "/c", source: "--cwd" } satisfies ResolvedProject);
});

Deno.test("resolveProjectFrom: $CLAUDE_PROJECT_DIR wins over cwd", () => {
  const r = resolveProjectFrom(undefined, undefined, "/env", "/cwd");
  assertEquals(r, { path: "/env", source: "$CLAUDE_PROJECT_DIR" } satisfies ResolvedProject);
});

Deno.test("resolveProjectFrom: nothing pinned -> cwd, flagged as fallthrough", () => {
  const r = resolveProjectFrom(undefined, undefined, undefined, "/cwd");
  assertEquals(r, { path: "/cwd", source: "cwd-fallthrough" } satisfies ResolvedProject);
});

Deno.test("resolveProjectFrom: EMPTY env/flag falls through, never resolves to ''", () => {
  // the empty-string variant of the wrong-bus bug — "" is a degenerate key.
  assertEquals(resolveProjectFrom("", "", "", "/cwd").source, "cwd-fallthrough");
  assertEquals(resolveProjectFrom("", "", "", "/cwd").path, "/cwd");
  // a non-empty later source still wins over an empty earlier one.
  assertEquals(resolveProjectFrom("", "", "/env", "/cwd").source, "$CLAUDE_PROJECT_DIR");
});

Deno.test("noteResolvedBus: always confirms the bus; WARNS only on cwd-fallthrough", () => {
  const pinned: string[] = [];
  noteResolvedBus({ path: "/proj", source: "$CLAUDE_PROJECT_DIR" }, (l) => pinned.push(l));
  assertEquals(pinned.length, 1, "a pinned source emits confirmation only, no warning");
  assertStringIncludes(pinned[0], "/proj");
  assertStringIncludes(pinned[0], "$CLAUDE_PROJECT_DIR");
  assert(!pinned.some((l) => l.includes("WARNING")), "pinned source must not warn");

  const fell: string[] = [];
  noteResolvedBus({ path: "/cwd", source: "cwd-fallthrough" }, (l) => fell.push(l));
  assertEquals(fell.length, 2, "fallthrough emits confirmation + warning");
  assert(fell.some((l) => l.includes("WARNING")), "fallthrough must warn about the wrong-bus risk");
  assert(fell.some((l) => l.includes("--cwd")), "the warning must name how to pin the bus");
});

// tcp-p0x.15: product mode previously had NO bus-identity announcement at all —
// these lock that a `monitor`/`product` run under a product bus now names the
// FULL bus key (not a basename, and product keys have no path-basename concept
// to begin with — the whole key IS the identity) and its source, with no
// spurious WARNING (unlike noteResolvedBus, a product key has no
// cwd-fallthrough case: both sources are always explicit).
Deno.test("noteResolvedProductBus: names the full product key and its source, never warns", () => {
  const viaEnv: string[] = [];
  noteResolvedProductBus("acme-suite", "$AGENT_MAIL_PRODUCT", (l) => viaEnv.push(l));
  assertEquals(viaEnv.length, 1, "product mode has nothing to warn about — confirmation only");
  assertStringIncludes(viaEnv[0], "acme-suite");
  assertStringIncludes(viaEnv[0], "$AGENT_MAIL_PRODUCT");
  assert(!viaEnv[0].includes("WARNING"));

  const viaFlag: string[] = [];
  noteResolvedProductBus("acme-suite", "--product", (l) => viaFlag.push(l));
  assertEquals(viaFlag.length, 1);
  assertStringIncludes(viaFlag[0], "acme-suite");
  assertStringIncludes(viaFlag[0], "--product");
});
