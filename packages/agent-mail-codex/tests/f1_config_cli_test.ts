import { parseConfig, requireBinding } from "../src/config.ts";
import { EXIT, IngressError } from "../src/errors.ts";
import { resolveFeatureFlags } from "../src/flags.ts";
import { main } from "../src/cli.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => void, code: string, exit: number): void {
  try {
    fn();
    throw new Error(`expected throw ${code}`);
  } catch (error) {
    assert(error instanceof IngressError, `expected IngressError, got ${error}`);
    assert(error.code === code, `expected code ${code}, got ${error.code}`);
    assert(error.exitCode === exit, `expected exit ${exit}, got ${error.exitCode}`);
  }
}

const valid = {
  schemaVersion: 1,
  statePath: "/tmp/agent-mail-codex-test.sqlite3",
  bindings: {
    demo: {
      agent: "CobaltJaguar",
      mailScope: {
        kind: "project",
        projectPath: "/home/gulp/projects/tiny-claude-plugins",
      },
      codex: {
        adapter: "headless-app-server-owner",
        ownership: "explicit-handoff",
        cwd: "/home/gulp/projects/tiny-claude-plugins",
        transport: { kind: "private-stdio" },
      },
      delivery: {
        batchWindowMs: 500,
        maxEvents: 50,
        maxBytes: 32768,
        urgentDuringTurn: "steer",
        routineDuringTurn: "queue",
      },
    },
  },
};

Deno.test("F1: parseConfig accepts S5-selected headless + explicit-handoff", () => {
  const config = parseConfig(valid);
  assert(config.bindings.demo.agent === "CobaltJaguar", "agent");
  assert(config.bindings.demo.codex.adapter === "headless-app-server-owner", "adapter");
  assert(config.bindings.demo.codex.ownership === "explicit-handoff", "ownership");
});

Deno.test("F1: invalid identity / scope / path / adapter / ownership fail distinctly", () => {
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: { ...valid.bindings.demo, agent: "not-a-valid-name" },
        },
      }),
    "identity_invalid",
    EXIT.CONFIG,
  );
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: {
            ...valid.bindings.demo,
            mailScope: { kind: "project", projectPath: "relative/path" },
          },
        },
      }),
    "path_invalid",
    EXIT.CONFIG,
  );
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: {
            ...valid.bindings.demo,
            mailScope: { kind: "galaxy", projectPath: "/x" },
          },
        },
      }),
    "scope_invalid",
    EXIT.CONFIG,
  );
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: {
            ...valid.bindings.demo,
            codex: {
              ...valid.bindings.demo.codex,
              adapter: "nope",
            },
          },
        },
      }),
    "adapter_invalid",
    EXIT.OWNERSHIP,
  );
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: {
            ...valid.bindings.demo,
            codex: {
              ...valid.bindings.demo.codex,
              ownership: "shared",
            },
          },
        },
      }),
    "ownership_invalid",
    EXIT.OWNERSHIP,
  );
});

Deno.test("F1: binding names reject path and systemd instance traversal", () => {
  for (
    const name of [
      "../escape",
      "nested/path",
      "unit@override",
      ".hidden",
      "two words",
      "name%2fescape",
      "",
      "x".repeat(65),
    ]
  ) {
    assertThrows(
      () =>
        parseConfig({
          ...valid,
          bindings: { [name]: valid.bindings.demo },
        }),
      "config_invalid",
      EXIT.CONFIG,
    );
  }
  parseConfig({
    ...valid,
    bindings: {
      "safe-binding_01": valid.bindings.demo,
    },
  });
});

Deno.test("F1: delivery numeric limits require finite positive integers", () => {
  const invalid: Record<string, unknown[]> = {
    batchWindowMs: [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001, "500"],
    maxEvents: [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_001, "50"],
    maxBytes: [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1024 * 1024 + 1, "32768"],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      assertThrows(
        () =>
          parseConfig({
            ...valid,
            bindings: {
              demo: {
                ...valid.bindings.demo,
                delivery: {
                  ...valid.bindings.demo.delivery,
                  [field]: value,
                },
              },
            },
          }),
        "config_invalid",
        EXIT.CONFIG,
      );
    }
  }
});

Deno.test("F1: urgent delivery enum and unix socket path fail closed", () => {
  assertThrows(
    () =>
      parseConfig({
        ...valid,
        bindings: {
          demo: {
            ...valid.bindings.demo,
            delivery: {
              ...valid.bindings.demo.delivery,
              urgentDuringTurn: "interrupt",
            },
          },
        },
      }),
    "config_invalid",
    EXIT.CONFIG,
  );
  for (const path of [undefined, "relative.sock", ""]) {
    assertThrows(
      () =>
        parseConfig({
          ...valid,
          bindings: {
            demo: {
              ...valid.bindings.demo,
              codex: {
                ...valid.bindings.demo.codex,
                transport: { kind: "unix-socket", path },
              },
            },
          },
        }),
      "path_invalid",
      EXIT.CONFIG,
    );
  }
  const config = parseConfig({
    ...valid,
    bindings: {
      demo: {
        ...valid.bindings.demo,
        codex: {
          ...valid.bindings.demo.codex,
          transport: { kind: "unix-socket", path: "/run/user/1000/codex.sock" },
        },
      },
    },
  });
  assert(
    config.bindings.demo.codex.transport.path === "/run/user/1000/codex.sock",
    "absolute socket path",
  );
});

Deno.test("F1: requireBinding fails for unknown name", () => {
  const config = parseConfig(valid);
  assertThrows(() => requireBinding(config, "missing"), "binding_missing", EXIT.CONFIG);
});

Deno.test("F1: feature flags resolve once from env defaults", () => {
  const flags = resolveFeatureFlags({
    CODEX_INGRESS_ENABLED: undefined,
    CODEX_INGRESS_ADAPTER: undefined,
    CODEX_INGRESS_OWNERSHIP: undefined,
  });
  assert(flags.enabled === false, "enabled default false");
  assert(flags.adapter === "headless-owner", "adapter default");
  assert(flags.ownership === "explicit-handoff", "ownership default matches S5");
});

Deno.test("F1: doctor CLI prints resolved binding deterministically", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent-mail-codex-f1-" });
  const path = `${dir}/config.json`;
  await Deno.writeTextFile(path, JSON.stringify(valid, null, 2));
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    const code = await main(["doctor", "--config", path, "--binding", "demo"]);
    assert(code === EXIT.OK, `doctor exit ${code}`);
    const text = chunks.join("\n");
    assert(text.includes("[PASS] config"), text);
    assert(text.includes('"binding": "demo"'), text);
    assert(text.includes('"adapter": "headless-app-server-owner"'), text);
    assert(text.includes('"ownership": "explicit-handoff"'), text);
  } finally {
    console.log = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("O3: run CLI usage documents durable supervisor (no skeleton refusal)", async () => {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    const code = await main(["--help"]);
    assert(code === EXIT.OK, `help exit ${code}`);
    const text = chunks.join("\n");
    assert(text.includes("run holds the binding lease"), text);
    assert(!text.includes("Does not deliver mail yet"), text);
    assert(text.includes("supervisor failure"), text);
    assert(text.includes("run --shadow"), text);
    assert(text.includes("CODEX_INGRESS_SHADOW"), text);
  } finally {
    console.log = original;
  }
});

Deno.test("R1: run --shadow refuses when delivery enabled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent-mail-codex-r1-cli-" });
  const path = `${dir}/config.json`;
  await Deno.writeTextFile(path, JSON.stringify(valid, null, 2));
  const prev = Deno.env.get("CODEX_INGRESS_ENABLED");
  Deno.env.set("CODEX_INGRESS_ENABLED", "true");
  const err: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  };
  try {
    const code = await main(["run", "--config", path, "--binding", "demo", "--shadow"]);
    assert(code === EXIT.OWNERSHIP, `expected ownership exit, got ${code}`);
    assert(err.join("\n").includes("shadow_refused"), err.join("\n"));
  } finally {
    console.error = original;
    if (prev === undefined) Deno.env.delete("CODEX_INGRESS_ENABLED");
    else Deno.env.set("CODEX_INGRESS_ENABLED", prev);
    await Deno.remove(dir, { recursive: true });
  }
});
