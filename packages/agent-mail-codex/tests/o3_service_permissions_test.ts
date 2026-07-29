/**
 * tcp-efp.5.13 — least-privilege service FS + App Server child env.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  APP_SERVER_ENV_ALLOWLIST,
  buildAppServerEnv,
  computeServicePermissions,
  isPathDenied,
} from "../src/operator/service_permissions.ts";

async function withFixture<T>(
  fn: (paths: {
    root: string;
    packageRoot: string;
    configPath: string;
    statePath: string;
    mailboxRoot: string;
    projectCwd: string;
    homeDir: string;
    codexBin: string;
    tmpDir: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "amc-5.13-" });
  const packageRoot = `${root}/pkg`;
  const configDir = `${root}/config`;
  const stateDir = `${root}/state/binding`;
  const mailboxRoot = `${root}/mailbox`;
  const projectCwd = `${root}/project`;
  const homeDir = `${root}/home`;
  const binDir = `${root}/bin`;
  const tmpDir = `${root}/tmp`;
  await Deno.mkdir(packageRoot, { recursive: true });
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.mkdir(mailboxRoot, { recursive: true });
  await Deno.mkdir(projectCwd, { recursive: true });
  await Deno.mkdir(homeDir, { recursive: true });
  await Deno.mkdir(`${homeDir}/.codex`, { recursive: true });
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.mkdir(tmpDir, { recursive: true });
  const configPath = `${configDir}/config.json`;
  const statePath = `${stateDir}/state.sqlite3`;
  const codexBin = `${binDir}/codex`;
  await Deno.writeTextFile(configPath, "{}\n");
  await Deno.writeTextFile(codexBin, "#!/bin/sh\nexit 0\n");
  await Deno.chmod(codexBin, 0o755);
  try {
    return await fn({
      root,
      packageRoot,
      configPath,
      statePath,
      mailboxRoot,
      projectCwd,
      homeDir,
      codexBin,
      tmpDir,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("5.13: computeServicePermissions bounds read/write and rejects bare-style gaps", async () => {
  await withFixture(async (p) => {
    const perms = await computeServicePermissions({
      packageRoot: p.packageRoot,
      configPath: p.configPath,
      statePath: p.statePath,
      mailboxRoot: p.mailboxRoot,
      codexBin: p.codexBin,
      projectCwd: p.projectCwd,
      homeDir: p.homeDir,
      tmpDir: p.tmpDir,
      requireExists: true,
    });

    const packageReal = await Deno.realPath(p.packageRoot);
    const codexReal = await Deno.realPath(p.codexBin);
    const tmpReal = await Deno.realPath(p.tmpDir);
    const stateRootReal = await Deno.realPath(parentOf(p.statePath));
    const codexHomeReal = await Deno.realPath(`${p.homeDir}/.codex`);
    const projectReal = await Deno.realPath(p.projectCwd);

    assert(!perms.denoArgs.includes("--allow-read"));
    assert(!perms.denoArgs.includes("--allow-write"));
    assert(perms.denoArgs.some((a) => a.startsWith("--allow-read=")));
    assert(perms.denoArgs.some((a) => a.startsWith("--allow-write=")));
    assert(perms.denoArgs.some((a) => a.startsWith("--allow-run=")));
    assertEquals(perms.allowRun, [codexReal]);

    assert(perms.allowRead.includes(packageReal));
    assertEquals(
      [...perms.allowWrite].sort(),
      [codexHomeReal, stateRootReal, tmpReal].sort(),
    );

    // Project must be readable, never writable.
    assert(perms.allowRead.includes(projectReal));
    assert(!perms.allowWrite.includes(projectReal));
    assert(!perms.allowWrite.some((w) => projectReal === w || projectReal.startsWith(`${w}/`)));

    assert(
      isPathDenied(perms.deniedExamples.unrelatedHomeFile, perms.allowRead),
      "unrelated home secret must be outside allowRead",
    );
    assert(
      isPathDenied(perms.deniedExamples.unrelatedProjectFile, perms.allowRead),
      "unrelated sibling project file must be outside allowRead",
    );
  });
});

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

Deno.test("5.13: computeServicePermissions rejects missing and noncanonical paths", async () => {
  await withFixture(async (p) => {
    await assertRejects(
      () =>
        computeServicePermissions({
          packageRoot: p.packageRoot,
          configPath: `${p.root}/missing-config.json`,
          statePath: p.statePath,
          mailboxRoot: p.mailboxRoot,
          codexBin: p.codexBin,
          projectCwd: p.projectCwd,
          homeDir: p.homeDir,
          tmpDir: p.tmpDir,
          requireExists: true,
        }),
      Error,
      "missing or unresolvable",
    );

    await assertRejects(
      () =>
        computeServicePermissions({
          packageRoot: "relative/pkg",
          configPath: p.configPath,
          statePath: p.statePath,
          mailboxRoot: p.mailboxRoot,
          codexBin: p.codexBin,
          projectCwd: p.projectCwd,
          homeDir: p.homeDir,
          tmpDir: p.tmpDir,
          requireExists: true,
        }),
      Error,
      "absolute path",
    );

    await assertRejects(
      () =>
        computeServicePermissions({
          packageRoot: `${p.root}/../${p.root.split("/").pop()}/pkg`,
          configPath: p.configPath,
          statePath: p.statePath,
          mailboxRoot: p.mailboxRoot,
          codexBin: p.codexBin,
          projectCwd: p.projectCwd,
          homeDir: p.homeDir,
          tmpDir: p.tmpDir,
          requireExists: true,
        }),
      Error,
      "..",
    );
  });
});

Deno.test("5.13: buildAppServerEnv allowlists keys and strips secrets", () => {
  const env = buildAppServerEnv({
    HOME: "/home/op",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-test",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-secret",
    ANTHROPIC_API_KEY: "ant-secret",
    AGENT_MAIL_BEARER_TOKEN: "mail-secret",
    LD_PRELOAD: "/evil.so",
    DYLD_INSERT_LIBRARIES: "/evil.dylib",
    RANDOM_LEAK: "should-not-pass",
  }, { codexBin: "/usr/local/bin/codex" });

  assertEquals(env.HOME, "/home/op");
  assertEquals(env.OPENAI_API_KEY, "sk-test");
  assertEquals(env.CODEX_BIN, "/usr/local/bin/codex");
  assertEquals(env.AWS_SECRET_ACCESS_KEY, undefined);
  assertEquals(env.GITHUB_TOKEN, undefined);
  assertEquals(env.ANTHROPIC_API_KEY, undefined);
  assertEquals(env.AGENT_MAIL_BEARER_TOKEN, undefined);
  assertEquals(env.RANDOM_LEAK, undefined);
  assertEquals(env.LD_PRELOAD, undefined);
  assertEquals(env.DYLD_INSERT_LIBRARIES, undefined);

  for (const key of Object.keys(env)) {
    assert(
      (APP_SERVER_ENV_ALLOWLIST as readonly string[]).includes(key),
      `unexpected child env key: ${key}`,
    );
  }
});

Deno.test("5.13: deploy wrapper forbids bare --allow-read/--allow-write", async () => {
  const wrapper = await Deno.readTextFile(
    new URL("../deploy/agent-mail-codex-run.sh", import.meta.url),
  );
  assert(
    !/\n\s*--allow-read\s*\\?\s*\n/.test(wrapper) &&
      !wrapper.includes("  --allow-read \\\n") &&
      !wrapper.includes("--allow-read \\"),
    "wrapper must not pass bare --allow-read",
  );
  // Final exec uses computed args; bootstrap uses --allow-read=...
  assert(wrapper.includes("--allow-read="), "bootstrap/read must be path-scoped");
  assert(wrapper.includes("permissions"), "wrapper must compute permissions");
  assert(wrapper.includes('--allow-run="$CODEX_BIN"') || wrapper.includes("allow-run="),
    "wrapper must keep allow-run scoped");
  assert(wrapper.includes("bare permission flag rejected"));
});

Deno.test("5.13: production_run uses allowlisted child env", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/operator/production_run.ts", import.meta.url),
  );
  assert(source.includes("buildAppServerEnv"), "spawn must use buildAppServerEnv");
  assert(!source.includes("Deno.env.toObject();\n  for (const name"),
    "must not strip-only inherit full env");
});
