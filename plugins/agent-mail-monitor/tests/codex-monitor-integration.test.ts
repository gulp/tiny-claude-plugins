function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected output to include: ${expected}\nactual output:\n${actual}`);
  }
}

async function runMonitor(args: string[]): Promise<Deno.CommandOutput> {
  const here = new URL(".", import.meta.url).pathname;
  return await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("CLI rejects missing option values with usage exit", async () => {
  const result = await runMonitor(["doctor", "--agent", "--project", "/tmp/project"]);
  assertEquals(result.code, 2);
  assertStringIncludes(new TextDecoder().decode(result.stderr), "--agent requires a value");
});

Deno.test("CLI rejects unknown options with usage exit", async () => {
  const result = await runMonitor(["doctor", "--wat"]);
  assertEquals(result.code, 2);
  assertStringIncludes(new TextDecoder().decode(result.stderr), "unknown option: --wat");
});

Deno.test("monitor fails loudly when App Server exits while idle", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-death-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const slug = project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const inbox = `${root}/projects/${slug}/agents/CobaltJaguar/inbox`;
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--interval",
      "1",
    ],
    env: {
      ...Deno.env.toObject(),
      CODEX_BIN: wrapper,
      TEST_MONITOR_INBOX: inbox,
      TEST_FAKE_EXIT_IDLE: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 1);
  assertStringIncludes(stderr, "Codex App Server exited with code 23");
});

Deno.test("monitor interrupts and fails loudly when a wake turn times out", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-timeout-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const slug = project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const inbox = `${root}/projects/${slug}/agents/CobaltJaguar/inbox`;
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--interval",
      "1",
      "--turn-timeout",
      "1",
    ],
    env: {
      ...Deno.env.toObject(),
      CODEX_BIN: wrapper,
      TEST_MONITOR_INBOX: inbox,
      TEST_FAKE_NO_COMPLETE: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "monitor turn timed out after 1000ms",
  );
});

Deno.test("headless monitor cancels MCP elicitation and completes delivery", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const inbox = `${root}/projects/${project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` +
    "/agents/CobaltJaguar/inbox";
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--interval",
      "1",
      "--once",
    ],
    env: { ...Deno.env.toObject(), CODEX_BIN: wrapper, TEST_MONITOR_INBOX: inbox },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, `${stdout}\n${stderr}`);
  assertStringIncludes(stdout, "MAIL #1");
  assertStringIncludes(
    stdout,
    "ELICITATION CANCELLED from mcp-agent-mail: headless monitor has no human input",
  );
  assertStringIncludes(stdout, "DELIVERED through #1");
});

Deno.test("headless monitor handles elicitation before thread startup", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-init-elicitation-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const inbox = `${root}/projects/${project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` +
    "/agents/CobaltJaguar/inbox";
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--interval",
      "1",
      "--once",
    ],
    env: {
      ...Deno.env.toObject(),
      CODEX_BIN: wrapper,
      TEST_MONITOR_INBOX: inbox,
      TEST_ELICITATION_PHASE: "initialize",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, `${stdout}\n${stderr}`);
  assertStringIncludes(
    stdout,
    "ELICITATION CANCELLED from mcp-agent-mail: headless monitor has no human input",
  );
  assertStringIncludes(stdout, "DELIVERED through #1");
});

Deno.test("monitor resumes exactly the requested durable thread", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-resume-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const inbox = `${root}/projects/${project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` +
    "/agents/CobaltJaguar/inbox";
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--thread",
      "thread-durable",
      "--interval",
      "1",
      "--once",
    ],
    env: { ...Deno.env.toObject(), CODEX_BIN: wrapper, TEST_MONITOR_INBOX: inbox },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, `${stdout}\n${stderr}`);
  assertStringIncludes(stdout, "Thread:  thread-durable");
  assertStringIncludes(stdout, "DELIVERED through #1");
});

Deno.test("unknown App Server request makes the binding fail loudly", async () => {
  const temp = await Deno.makeTempDir({ prefix: "agent-mail-monitor-unknown-request-test-" });
  const project = `${temp}/project`;
  const root = `${temp}/mailbox`;
  const inbox = `${root}/projects/${project.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` +
    "/agents/CobaltJaguar/inbox";
  await Deno.mkdir(inbox, { recursive: true });

  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);

  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      `${here}../scripts/codex-monitor.ts`,
      "monitor",
      "--agent",
      "CobaltJaguar",
      "--project",
      project,
      "--root",
      root,
      "--interval",
      "1",
      "--turn-timeout",
      "1",
    ],
    env: {
      ...Deno.env.toObject(),
      CODEX_BIN: wrapper,
      TEST_MONITOR_INBOX: inbox,
      TEST_UNKNOWN_REQUEST: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "unsupported App Server request: future/unknown",
  );
});
