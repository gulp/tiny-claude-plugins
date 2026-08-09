/**
 * tcp-efp.5.15 — native CODEX_BIN resolution + hard version-probe deadline.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVersionProbeEnv,
  classifyCodexBytes,
  CODEX_BIN_CODES,
  CodexBinError,
  defaultProbeCodexVersion,
  inspectCodexBin,
  resolveNativeCodexBin,
} from "../src/operator/codex_bin.ts";
import { inspectLiveStatus } from "../src/operator/live_status.ts";
import type { IngressConfig } from "../src/config.ts";
import { slugForProject } from "../src/mailbox/mod.ts";

const NPX_WRAPPER = `#!/bin/bash
package="@openai/codex"
command="codex"
"$node_bin" "$npx_bin" --yes --prefer-online --package "$package" -- true
exec_package_bin "$@"
`;

function elfStub(): Uint8Array {
  // Minimal bytes that pass the ELF magic check (not a runnable binary).
  const bytes = new Uint8Array(64);
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = 2; // 64-bit
  return bytes;
}

function configFor(statePath: string, projectPath: string): IngressConfig {
  return {
    schemaVersion: 1,
    statePath,
    bindings: {
      demo: {
        agent: "OliveCedar",
        mailScope: { kind: "project", projectPath },
        codex: {
          adapter: "headless-app-server-owner",
          ownership: "explicit-handoff",
          threadId: "thread-5-15",
          cwd: projectPath,
          transport: { kind: "private-stdio" },
        },
        delivery: {
          batchWindowMs: 500,
          maxEvents: 50,
          maxBytes: 32_768,
          urgentDuringTurn: "steer",
          routineDuringTurn: "queue",
        },
      },
    },
  };
}

Deno.test("5.15: classifyCodexBytes rejects npx --prefer-online wrapper", () => {
  const bytes = new TextEncoder().encode(NPX_WRAPPER);
  const result = classifyCodexBytes("/tmp/wrapper-codex", bytes);
  assertEquals(result.kind, "package_manager_wrapper");
  assertEquals(result.code, CODEX_BIN_CODES.WRAPPER_REJECTED);
});

Deno.test("5.15: classifyCodexBytes accepts ELF magic as native", () => {
  const result = classifyCodexBytes("/tmp/native-codex", elfStub());
  assertEquals(result.kind, "native_elf");
  assertEquals(result.code, "CODEX_BIN_OK");
});

Deno.test("5.15: classifyCodexBytes rejects plain script as not native", () => {
  const bytes = new TextEncoder().encode("#!/bin/sh\necho ok\n");
  const result = classifyCodexBytes("/tmp/script-codex", bytes);
  assertEquals(result.kind, "script");
  assertEquals(result.code, CODEX_BIN_CODES.NOT_NATIVE);
});

Deno.test("5.15: resolveNativeCodexBin rejects PATH wrapper file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-5.15-wrap-" });
  const wrapper = `${tmp}/codex`;
  await Deno.writeTextFile(wrapper, NPX_WRAPPER);
  await Deno.chmod(wrapper, 0o755);
  await assertRejects(
    () => resolveNativeCodexBin(wrapper),
    CodexBinError,
    CODEX_BIN_CODES.WRAPPER_REJECTED,
  );
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.15: resolveNativeCodexBin accepts ELF file path", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-5.15-elf-" });
  const bin = `${tmp}/codex`;
  await Deno.writeFile(bin, elfStub());
  await Deno.chmod(bin, 0o755);
  const resolved = await resolveNativeCodexBin(bin);
  assertEquals(resolved, await Deno.realPath(bin));
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.15: resolveNativeCodexBin requires CODEX_BIN when unset", async () => {
  const prev = Deno.env.get("CODEX_BIN");
  Deno.env.delete("CODEX_BIN");
  try {
    await assertRejects(
      () => resolveNativeCodexBin(),
      CodexBinError,
      CODEX_BIN_CODES.MISSING,
    );
  } finally {
    if (prev === undefined) Deno.env.delete("CODEX_BIN");
    else Deno.env.set("CODEX_BIN", prev);
  }
});

Deno.test("5.15: buildVersionProbeEnv strips loader injection vars", () => {
  const env = buildVersionProbeEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LD_LIBRARY_PATH: "/evil",
    LD_PRELOAD: "/evil.so",
    DYLD_INSERT_LIBRARIES: "/evil.dylib",
    AWS_SECRET_ACCESS_KEY: "secret",
    OPENAI_API_KEY: "sk-test",
  });
  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.HOME, "/home/x");
  assertEquals(env.LD_LIBRARY_PATH, undefined);
  assertEquals(env.LD_PRELOAD, undefined);
  assertEquals(env.DYLD_INSERT_LIBRARIES, undefined);
  assertEquals(env.AWS_SECRET_ACCESS_KEY, undefined);
  assertEquals(env.OPENAI_API_KEY, undefined);
});

Deno.test("5.15: defaultProbeCodexVersion times out on pipe-holding descendant", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-5.15-hang-" });
  const hang = `${tmp}/hang-codex`;
  // Parent exits quickly; grandchild keeps inherited stdout open → classic hang
  // without process-group kill.
  await Deno.writeTextFile(
    hang,
    `#!/bin/sh
# Background sleeper inherits Deno stdout/stderr; parent exits → classic pipe hang
# without process-group cleanup.
sleep 60 &
exit 0
`,
  );
  await Deno.chmod(hang, 0o755);

  const started = Date.now();
  let failed: unknown;
  try {
    await defaultProbeCodexVersion(hang, 400);
  } catch (error) {
    failed = error;
  }
  const elapsed = Date.now() - started;
  assert(failed instanceof CodexBinError, `expected CodexBinError, got ${failed}`);
  assertEquals(failed.binCode, CODEX_BIN_CODES.PROBE_TIMEOUT);
  assert(elapsed < 2_500, `probe hung too long: ${elapsed}ms`);

  // Descendants should be gone (best-effort; allow brief reaping lag).
  await new Promise((r) => setTimeout(r, 200));
  const ps = await new Deno.Command("ps", {
    args: ["-eo", "pid,args"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const listing = new TextDecoder().decode(ps.stdout);
  assert(
    !listing.includes(hang),
    `descendant still referencing hang fixture:\n${listing}`,
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.15: defaultProbeCodexVersion succeeds with LD_LIBRARY_PATH in parent env", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-5.15-ok-" });
  const ok = `${tmp}/ok-codex`;
  await Deno.writeTextFile(ok, "#!/bin/sh\necho 'codex-cli 0.145.0'\n");
  await Deno.chmod(ok, 0o755);

  const text = await defaultProbeCodexVersion(ok, 2_000, {
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin",
      HOME: Deno.env.get("HOME") ?? "/tmp",
      LD_LIBRARY_PATH: "/does/not/matter",
      LD_PRELOAD: "/also/ignored.so",
    },
  });
  assert(text.includes("0.145.0"), text);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.15: doctor surfaces CODEX_BIN_WRAPPER_REJECTED without probe hang", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-5.15-doc-" });
  const projectPath = `${tmp}/project`;
  const mailboxRoot = `${tmp}/mailbox`;
  const statePath = `${tmp}/state.sqlite3`;
  const wrapper = `${tmp}/wrapper-codex`;
  await Deno.mkdir(projectPath, { recursive: true });
  const inbox =
    `${mailboxRoot}/projects/${slugForProject(projectPath)}/agents/OliveCedar/inbox`;
  await Deno.mkdir(inbox, { recursive: true });
  await Deno.writeTextFile(wrapper, NPX_WRAPPER);
  await Deno.chmod(wrapper, 0o755);

  const started = Date.now();
  const report = await inspectLiveStatus({
    config: configFor(statePath, projectPath),
    bindingName: "demo",
    mailboxRoot,
    codexBin: wrapper,
    versionProbeTimeoutMs: 500,
  });
  const elapsed = Date.now() - started;
  assert(elapsed < 2_000, `doctor hung on wrapper: ${elapsed}ms`);
  const version = report.checks.find((c) => c.name === "version");
  assertEquals(version?.code, CODEX_BIN_CODES.WRAPPER_REJECTED);
  assert(!report.healthy);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("5.15: deploy wrapper rejects PATH-style wrapper and requires CODEX_BIN", async () => {
  const wrapper = await Deno.readTextFile(
    new URL("../deploy/agent-mail-codex-run.sh", import.meta.url),
  );
  assert(wrapper.includes("CODEX_BIN_WRAPPER_REJECTED"));
  assert(wrapper.includes("CODEX_BIN is required"));
  assert(
    !/\$\(command -v codex/.test(wrapper),
    "must not default CODEX_BIN via $(command -v codex)",
  );
  assert(wrapper.includes("unset LD_LIBRARY_PATH"));
});

Deno.test({
  name: "5.15: live native ELF probe returns within deadline (host evidence)",
  ignore: !(await Deno.stat("/usr/bin/codex").then(() => true).catch(() => false)),
  fn: async () => {
    const inspection = await inspectCodexBin("/usr/bin/codex");
    assertEquals(inspection.kind, "native_elf");
    const text = await defaultProbeCodexVersion("/usr/bin/codex", 3_000, {
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin",
        HOME: Deno.env.get("HOME") ?? "/tmp",
        LD_LIBRARY_PATH: "/evil",
      },
    });
    assert(/\d+\.\d+/.test(text) || text.toLowerCase().includes("codex"), text);
  },
});
